import type { Vector3 } from 'three'
import { CircleGeometry, CurveGeometry, tessellate } from '../core/geometry'
import type { Command } from './runner'

const line: Command = {
  name: 'Line',
  async run({ doc, input }) {
    const start = await input.getPoint({ prompt: 'Start of line' })
    if (start.kind !== 'point') return
    const end = await input.getPoint({ prompt: 'End of line', base: start.point })
    if (end.kind !== 'point') return
    doc.add({ type: 'polyline', points: [start.point, end.point], closed: false })
  },
}

const polyline: Command = {
  name: 'Polyline',
  async run({ doc, input }) {
    const start = await input.getPoint({ prompt: 'Start of polyline' })
    if (start.kind !== 'point') return
    const points: Vector3[] = [start.point]
    let closed = false

    for (;;) {
      const options = points.length >= 3 ? ['Close', 'Undo'] : points.length === 2 ? ['Undo'] : []
      const next = await input.getPoint({
        prompt: 'Next point of polyline',
        base: points[points.length - 1],
        options,
        rubberBand: false,
        preview: (p) => [[...points, p]],
      })
      if (next.kind === 'point') points.push(next.point)
      else if (next.kind === 'option' && next.option === 'Undo') points.pop()
      else {
        closed = next.kind === 'option' && next.option === 'Close'
        break
      }
    }
    if (points.length >= 2) doc.add({ type: 'polyline', points, closed })
  },
}

const circle: Command = {
  name: 'Circle',
  async run({ doc, input }) {
    const center = await input.getPoint({ prompt: 'Center of circle' })
    if (center.kind !== 'point') return
    // The circle lies parallel to the construction plane of the viewport where its center was picked.
    const { xaxis, yaxis } = center.viewport.cplane
    const make = (radius: number): CircleGeometry => ({ type: 'circle', center: center.point, xaxis, yaxis, radius })

    const result = await input.getPoint({
      prompt: 'Radius',
      base: center.point,
      acceptNumber: true,
      preview: (p) => [tessellate(make(p.distanceTo(center.point)))],
    })
    const radius =
      result.kind === 'number' ? result.value : result.kind === 'point' ? result.point.distanceTo(center.point) : 0
    if (radius > 0) doc.add(make(radius))
  },
}

const curve: Command = {
  name: 'Curve',
  async run({ doc, input }) {
    const start = await input.getPoint({ prompt: 'Start of curve' })
    if (start.kind !== 'point') return
    const points: Vector3[] = [start.point]
    const make = (pts: Vector3[]): CurveGeometry => ({ type: 'curve', degree: 3, points: pts })

    for (;;) {
      const next = await input.getPoint({
        prompt: 'Next point',
        base: points[points.length - 1],
        options: points.length >= 2 ? ['Undo'] : [],
        rubberBand: false,
        // Show the curve together with its control polygon.
        preview: (p) => [tessellate(make([...points, p])), [...points, p]],
      })
      if (next.kind === 'point') points.push(next.point)
      else if (next.kind === 'option') points.pop()
      else break
    }
    if (points.length >= 2) doc.add(make(points))
  },
}

export const drawCommands: Command[] = [line, polyline, circle, curve]
