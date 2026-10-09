import { length } from '../core/curves'
import { atLengths } from '../core/curveTools'
import { isClosed, isCurve, type AnyCurve } from '../core/geometry'
import { CancelError } from '../input/interaction'
import { formatValue, isOption, plural, valueOption } from './helpers'
import type { Command, CommandContext } from './runner'

/** Point objects: placing them one by one and dividing curves into them. */

const memory = { segments: 10, length: 1, byLength: false }

const point: Command = {
  name: 'Point',
  async run({ doc, input }) {
    const r = await input.getPoint({ prompt: 'Location of point object' })
    if (r.kind !== 'point') return
    doc.select([doc.add({ type: 'point', point: r.point }).id])
  },
}

const points: Command = {
  name: 'Points',
  async run({ doc, input, log }) {
    const made: number[] = []
    for (;;) {
      const r = await input.getPoint({ prompt: made.length === 0 ? 'Location of point object' : 'Next point. Press Enter when done', options: made.length > 0 ? ['Undo'] : [] })
      if (r.kind === 'point') made.push(doc.add({ type: 'point', point: r.point }).id)
      else if (r.kind === 'option' && isOption(r.option, 'Undo')) doc.remove(made.pop()!)
      else if (r.kind === 'enter') break
      else throw new CancelError()
    }
    doc.select(made)
    log(`${plural('point', made.length)} added`)
  },
}

/** Distances along a curve of `total` length that split it into `segments` equal parts or parts of `step`. */
export function divisionLengths(total: number, closed: boolean, by: { segments: number } | { step: number }): number[] {
  const out: number[] = []
  if ('segments' in by) {
    const n = Math.max(1, Math.round(by.segments))
    // A closed curve ends where it starts: no point twice.
    for (let i = 0; i <= (closed ? n - 1 : n); i++) out.push((total * i) / n)
  } else {
    if (by.step <= 0) throw new Error('The length must be more than zero')
    for (let s = 0; s <= total * (1 + 1e-12); s += by.step) out.push(Math.min(s, total))
    if (closed && out.length > 1 && total - out[out.length - 1] < by.step * 1e-9) out.pop()
  }
  return out
}

const divide: Command = {
  name: 'Divide',
  async run(ctx: CommandContext) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select curves to divide')).filter((id) => {
      const g = doc.objects.get(id)?.geometry
      return g && isCurve(g)
    })
    if (ids.length === 0) throw new Error('Select curves')
    for (;;) {
      // Picking Segments or Length switches how the curves are divided.
      const options = [valueOption('Segments', memory.segments), valueOption('Length', memory.length)]
      const r = await input.getNumber(memory.byLength ? 'Length of each segment' : 'Number of segments', memory.byLength ? memory.length : memory.segments, options)
      if (typeof r === 'number') {
        if (memory.byLength) {
          if (r <= 0) throw new Error('The length must be more than zero')
          memory.length = r
        } else {
          if (r < 1) throw new Error('Divide into at least one segment')
          memory.segments = Math.round(r)
        }
        break
      }
      if (isOption(r, 'Segments')) memory.byLength = false
      else if (isOption(r, 'Length')) memory.byLength = true
    }
    const made: number[] = []
    for (const id of ids) {
      const g = doc.objects.get(id)!.geometry as AnyCurve
      const total = length(g)
      const distances = divisionLengths(total, isClosed(g), memory.byLength ? { step: memory.length } : { segments: memory.segments })
      for (const p of atLengths(g, distances).points) made.push(doc.add({ type: 'point', point: p }, doc.objects.get(id)!.layerId).id)
    }
    doc.select(made)
    log(`${plural('point', made.length)} on ${plural('curve', ids.length)}${memory.byLength ? `, every ${formatValue(memory.length)}` : ''}`)
  },
}

export const pointCommands: Command[] = [point, points, divide]
