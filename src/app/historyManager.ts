import type { Document, HistoryRecord, StepChange } from '../core/document'
import { isCurve } from '../core/geometry'
import type { Settings } from '../core/settings'
import type { BrepGeometry } from '../core/geometry'
import { kernelJob } from '../kernel/client'
import { orphanedParts, planOpeningParts, withOpeningIds } from './openingParts'
import { ownInputOnly, withJoins } from './wallJoins'

/**
 * Construction history, as in Rhino: an object made from curves with history recorded is made again
 * when those curves change, in the same undo step as the change. Editing the object itself, or
 * deleting one of its inputs, breaks its history (it stays as it is).
 */
export class HistoryManager {
  /** Steps whose consequences are still being worked out, so their own changes are not followed again. */
  private busy = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly doc: Document,
    private readonly settings: Settings,
    private readonly log: (text: string) => void,
  ) {
    doc.onStep((step) => {
      if (this.busy) return
      // Rebuilds wait for the kernel, so they run one step at a time, in order.
      this.queue = this.queue.then(() => this.follow(step)).catch((error) => console.error(error))
    })
  }

  /** Resolves when every change so far has been followed (for tests and scripts). */
  get settled(): Promise<void> {
    return this.queue
  }

  private async follow(step: readonly StepChange[]): Promise<void> {
    const { doc } = this
    const changed = new Set<number>()
    const removed = new Set<number>()
    // Objects made again with a new record in the same step (parameters edited) keep their history.
    const remade = new Set<number>()
    for (const action of step) {
      if (action.type === 'history' && action.after) remade.add(action.id)
    }
    for (const action of step) {
      if (action.type === 'modify' && remade.has(action.id)) continue
      if (action.type === 'modify') changed.add(action.id)
      else if (action.type === 'remove') removed.add(action.obj.id)
      else if (action.type === 'add') removed.delete(action.obj.id)
    }
    // Walls added or remade can change how others join, even when nothing else changed.
    const walls = [...doc.objects.values()].some((o) => o.history?.command === 'Wall')
    if (changed.size === 0 && removed.size === 0 && !(walls && remade.size > 0)) return

    const breaks: number[] = []
    let rebuild: number[] = []
    for (const obj of doc.objects.values()) {
      const record = obj.history
      if (!record) continue
      // Walls and their pieces are tied to their own line only; the lines of the walls they join
      // come and go.
      const tied = ownInputOnly(record) ? record.inputs.slice(0, 1) : record.inputs
      if (changed.has(obj.id)) breaks.push(obj.id) // Edited by hand.
      else if (tied.some((id) => removed.has(id) || !doc.objects.has(id))) breaks.push(obj.id)
      else if (record.inputs.some((id) => changed.has(id))) rebuild.push(obj.id)
    }
    // The frames and glass of a wall that is gone, or no longer made from its line, stay as they are.
    const orphans = orphanedParts(doc, new Set([...breaks, ...removed]))
    for (const id of orphans) if (!breaks.includes(id) && !removed.has(id)) breaks.push(id)
    rebuild = rebuild.filter((id) => !orphans.includes(id))

    // Walls whose joins changed are made again with them (their pieces with them).
    const remakes = new Map<number, HistoryRecord>()
    const skip = new Set(breaks)
    for (const obj of doc.objects.values()) {
      if (obj.history?.command !== 'Wall' || skip.has(obj.id)) continue
      const wanted = withJoins(doc, obj.id, obj.history, skip)
      if (JSON.stringify(wanted) !== JSON.stringify(obj.history)) remakes.set(obj.id, wanted)
    }
    rebuild = rebuild.filter((id) => {
      const record = doc.objects.get(id)!.history!
      return !remakes.has(id) && !(record.command === 'OpeningPart' && remakes.has(Number(record.params?.wall)))
    })
    if (breaks.length === 0 && rebuild.length === 0 && remakes.size === 0) return

    const results = new Map<number, BrepGeometry>()
    const applies: (() => void)[] = []
    const failed: number[] = []
    for (const id of rebuild) {
      try {
        results.set(id, await this.build(doc.objects.get(id)!.history!))
      } catch (error) {
        console.warn('History could not rebuild an object', error)
        failed.push(id)
      }
    }
    for (const [id, record] of remakes) {
      try {
        applies.push(await this.prepare(id, record, skip))
      } catch (error) {
        console.warn('History could not join a wall', error)
        failed.push(id)
      }
    }

    this.busy = true
    try {
      doc.beginAmend(step)
      for (const id of breaks) doc.setHistory(id, undefined)
      for (const [id, geometry] of results) if (doc.objects.has(id)) doc.setGeometry(id, geometry)
      for (const apply of applies) apply()
      doc.commit()
    } finally {
      this.busy = false
    }
    if (failed.length > 0) this.log(`History could not update ${failed.length} object${failed.length === 1 ? '' : 's'}: the changed curves no longer make it (undo to go back)`)
  }

  /** Builds the object a record describes, from its input curves as they are now. */
  private build(record: HistoryRecord): Promise<BrepGeometry> {
    const curves = record.inputs.map((id) => {
      const g = this.doc.objects.get(id)?.geometry
      if (!g || !isCurve(g)) throw new Error('A history input is no longer a curve')
      return g
    })
    return kernelJob('rebuild', record.command, curves, record.params ?? {})
  }

  /**
   * Makes an object again from a new record (its parameters changed), as part of the current step:
   * its geometry and record change together, and it keeps following its inputs.
   */
  async remake(id: number, record: HistoryRecord): Promise<void> {
    ;(await this.prepare(id, record))()
  }

  /** Like remake(), as an undo step of its own (for edits made outside commands). */
  async remakeStep(id: number, record: HistoryRecord): Promise<void> {
    const apply = await this.prepare(id, record)
    if (!this.doc.objects.has(id)) return
    this.doc.begin()
    apply()
    this.doc.commit()
  }

  /**
   * Builds what remaking an object needs (for a wall, also the frames and glass of its openings) and
   * returns the function that makes the changes.
   */
  private async prepare(id: number, given: HistoryRecord, skip?: Set<number>): Promise<() => void> {
    const record = given.command === 'Wall' ? withJoins(this.doc, id, withOpeningIds(given), skip) : given
    const geometry = await this.build(record)
    const parts = record.command === 'Wall' ? await planOpeningParts(this.doc, id, record, (r) => this.build(r)) : () => {}
    return () => {
      this.doc.setGeometry(id, geometry)
      this.doc.setHistory(id, record)
      parts()
    }
  }

  /** Remembers how an object was made, if history recording is on. */
  record(id: number, command: string, inputs: number[], params?: Record<string, unknown>): void {
    if (!this.settings.history) return
    this.doc.setHistory(id, { command, inputs, ...(params ? { params } : {}) })
  }
}
