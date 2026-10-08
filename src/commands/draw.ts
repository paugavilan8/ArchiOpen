import { Vector3 } from 'three'
import { ArcGeometry, CircleGeometry, CurveGeometry, PolylineGeometry, tessellate } from '../core/geometry'
import { clampedKnots } from '../math/nurbs'
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
    const make = (pts: Vector3[]): CurveGeometry => {
      const degree = Math.min(3, pts.length - 1)
      return { type: 'curve', degree, points: pts, knots: clampedKnots(pts.length, degree) }
    }

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

const arc: Command = {
  name: 'Arc',
  async run({ doc, input }) {
    const center = await input.getPoint({ prompt: 'Center of arc' })
    if (center.kind !== 'point') return
    const c = center.point
    const { normal } = center.viewport.cplane
    const start = await input.getPoint({ prompt: 'Start of arc', base: c })
    if (start.kind !== 'point') return
    const toStart = start.point.clone().sub(c)
    toStart.addScaledVector(normal, -toStart.dot(normal))
    const radius = toStart.length()
    if (radius < 1e-9) throw new Error('The start point is on the center')
    const xaxis = toStart.normalize()
    const yaxis = normal.clone().cross(xaxis).normalize()

    // The sweep follows the cursor as it goes round, so the arc can turn either way and pass 180°.
    let previous = 0
    let sweep = 0
    const track = (p: Vector3) => {
      const d = p.clone().sub(c)
      const angle = Math.atan2(d.dot(yaxis), d.dot(xaxis))
      let delta = angle - previous
      if (delta > Math.PI) delta -= 2 * Math.PI
      if (delta < -Math.PI) delta += 2 * Math.PI
      previous = angle
      sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, sweep + delta))
      return sweep
    }
    const make = (angle: number): ArcGeometry =>
      angle >= 0
        ? { type: 'arc', center: c, xaxis, yaxis, radius, angle }
        : { type: 'arc', center: c, xaxis, yaxis: yaxis.clone().negate(), radius, angle: -angle }

    const end = await input.getPoint({
      prompt: 'End point or angle',
      base: c,
      acceptNumber: true,
      preview: (p) => {
        const angle = track(p)
        return Math.abs(angle) > 1e-9 ? [tessellate(make(angle))] : []
      },
    })
    const angle = end.kind === 'number' ? (end.value * Math.PI) / 180 : end.kind === 'point' ? track(end.point) : 0
    if (Math.abs(angle) > 1e-9) doc.add(make(angle))
  },
}

const rectangle: Command = {
  name: 'Rectangle',
  async run({ doc, input }) {
    const first = await input.getPoint({ prompt: 'First corner of rectangle' })
    if (first.kind !== 'point') return
    const a = first.point
    const { xaxis, yaxis } = first.viewport.cplane
    const make = (p: Vector3): PolylineGeometry | null => {
      const d = p.clone().sub(a)
      const dx = d.dot(xaxis)
      const dy = d.dot(yaxis)
      if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) return null
      const b = a.clone().addScaledVector(xaxis, dx)
      return {
        type: 'polyline',
        points: [a.clone(), b, b.clone().addScaledVector(yaxis, dy), a.clone().addScaledVector(yaxis, dy)],
        closed: true,
      }
    }
    const other = await input.getPoint({
      prompt: 'Other corner (type r20,10 for width and height)',
      base: a,
      rubberBand: false,
      preview: (p) => {
        const r = make(p)
        return r ? [tessellate(r)] : []
      },
    })
    if (other.kind !== 'point') return
    const result = make(other.point)
    if (result) doc.add(result)
  },
}

export const drawCommands: Command[] = [line, polyline, rectangle, circle, arc, curve]
