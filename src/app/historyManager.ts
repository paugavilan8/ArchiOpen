import type { Document, HistoryRecord, StepChange } from '../core/document'
import { isCurve } from '../core/geometry'
import type { Settings } from '../core/settings'
import { toBrep } from '../kernel/brep'
import { loadKernel } from '../kernel/loadKernel'
import { REBUILDERS } from '../kernel/rebuild'

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
    for (const action of step) {
      if (action.type === 'modify') changed.add(action.id)
      else if (action.type === 'remove') removed.add(action.obj.id)
      else if (action.type === 'add') removed.delete(action.obj.id)
    }
    if (changed.size === 0 && removed.size === 0) return

    const breaks: number[] = []
    const rebuild: number[] = []
    for (const obj of doc.objects.values()) {
      const record = obj.history
      if (!record) continue
      if (changed.has(obj.id)) breaks.push(obj.id) // Edited by hand.
      else if (record.inputs.some((id) => removed.has(id) || !doc.objects.has(id))) breaks.push(obj.id)
      else if (record.inputs.some((id) => changed.has(id))) rebuild.push(obj.id)
    }
    if (breaks.length === 0 && rebuild.length === 0) return

    const results = new Map<number, ReturnType<typeof toBrep>>()
    const failed: number[] = []
    if (rebuild.length > 0) await loadKernel()
    for (const id of rebuild) {
      try {
        results.set(id, toBrep(this.build(doc.objects.get(id)!.history!)))
      } catch (error) {
        console.warn('History could not rebuild an object', error)
        failed.push(id)
      }
    }

    this.busy = true
    try {
      doc.beginAmend(step)
      for (const id of breaks) doc.setHistory(id, undefined)
      for (const [id, geometry] of results) if (doc.objects.has(id)) doc.setGeometry(id, geometry)
      doc.commit()
    } finally {
      this.busy = false
    }
    if (failed.length > 0) this.log(`History could not update ${failed.length} object${failed.length === 1 ? '' : 's'}: the changed curves no longer make it (undo to go back)`)
  }

  /** Builds the object a record describes, from its input curves as they are now. */
  private build(record: HistoryRecord) {
    const make = REBUILDERS[record.command]
    if (!make) throw new Error(`No history for ${record.command}`)
    const curves = record.inputs.map((id) => {
      const g = this.doc.objects.get(id)?.geometry
      if (!g || !isCurve(g)) throw new Error('A history input is no longer a curve')
      return g
    })
    return make(curves, record.params ?? {})
  }

  /** Remembers how an object was made, if history recording is on. */
  record(id: number, command: string, inputs: number[], params?: Record<string, unknown>): void {
    if (!this.settings.history) return
    this.doc.setHistory(id, { command, inputs, ...(params ? { params } : {}) })
  }
}
