import { Vector3 } from 'three'
import { blend, Continuity, ellipse, helix, polygon, rebuild } from '../core/curveTools'
import { closestPoint } from '../core/curves'
import { AnyCurve, domain, isCurve, tessellate } from '../core/geometry'
import { CancelError } from '../input/interaction'
import { interpolate } from '../math/nurbs'
import { formatValue, isOption, plural, valueOption } from './helpers'
import type { Command, CommandContext } from './runner'

const memory = {
  sides: 6,
  circumscribed: false,
  turns: 5,
  rebuildPoints: 10,
  rebuildDegree: 3,
  continuity: 'tangency' as Continuity,
}

const ellipseCommand: Command = {
  name: 'Ellipse',
  async run({ doc, input }) {
    const center = await input.getPoint({ prompt: 'Center of ellipse' })
    if (center.kind !== 'point') return
    const plane = center.viewport.cplane
    const c = center.point
    const first = await input.getPoint({
      prompt: 'End of first axis',
      base: c,
      preview: (p) => [tessellate(ellipse(c, plane.xaxis, plane.yaxis, p.distanceTo(c), p.distanceTo(c)))],
    })
    if (first.kind !== 'point') return
    const a = first.point.distanceTo(c)
    if (a < 1e-9) throw new Error('The axis has no length')
    const x = first.point.clone().sub(c).normalize()
    const y = plane.normal.clone().cross(x).normalize()
    // The second axis is how far the point is from the first one.
    const along = (p: Vector3) => Math.abs(p.clone().sub(c).dot(y))
    const second = await input.getPoint({
      prompt: 'End of second axis',
      base: c,
      acceptNumber: true,
      rubberBand: false,
      preview: (p) => [tessellate(ellipse(c, x, y, a, Math.max(along(p), 1e-9)))],
    })
    const b = second.kind === 'number' ? second.value : second.kind === 'point' ? along(second.point) : null
    if (b === null) return
    if (b < 1e-9) throw new Error('The second axis has no length')
    doc.add(ellipse(c, x, y, a, b))
  },
}

const polygonCommand: Command = {
  name: 'Polygon',
  async run({ doc, input }) {
    const options = () => [valueOption('NumSides', memory.sides), `Mode=${memory.circumscribed ? 'Circumscribed' : 'Inscribed'}`]
    let center: Vector3 | null = null
    let plane = null as null | { xaxis: Vector3; yaxis: Vector3; normal: Vector3 }
    for (;;) {
      const r = await input.getPoint({ prompt: 'Center of polygon', options: options() })
      if (r.kind === 'option') {
        if (isOption(r.option, 'NumSides')) {
          const n = await input.getNumber('Number of sides', memory.sides)
          if (typeof n === 'number' && n >= 3) memory.sides = Math.round(n)
        } else memory.circumscribed = !memory.circumscribed
        continue
      }
      if (r.kind !== 'point') return
      center = r.point
      plane = r.viewport.cplane
      break
    }
    const c = center
    const p = plane
    const make = (at: Vector3) => {
      const d = at.clone().sub(c)
      const angle = Math.atan2(d.dot(p.yaxis), d.dot(p.xaxis))
      return polygon(c, p.xaxis, p.yaxis, Math.hypot(d.dot(p.xaxis), d.dot(p.yaxis)), memory.sides, angle, memory.circumscribed)
    }
    const corner = await input.getPoint({
      prompt: memory.circumscribed ? 'Middle of a side' : 'Corner of polygon',
      base: c,
      preview: (q) => [tessellate(make(q))],
    })
    if (corner.kind !== 'point') return
    if (corner.point.distanceTo(c) < 1e-9) throw new Error('The polygon has no size')
    doc.add(make(corner.point))
  },
}

const helixCommand: Command = {
  name: 'Helix',
  async run({ doc, input }) {
    const base = await input.getPoint({ prompt: 'Start of axis' })
    if (base.kind !== 'point') return
    const top = await input.getPoint({ prompt: 'End of axis', base: base.point })
    if (top.kind !== 'point') return
    for (;;) {
      const start = await input.getPoint({
        prompt: 'Radius and start point',
        base: base.point,
        options: [valueOption('Turns', memory.turns)],
        preview: (p) => {
          const h = helix(base.point, top.point, p, memory.turns)
          return h ? [tessellate(h)] : []
        },
      })
      if (start.kind === 'option') {
        const n = await input.getNumber('Number of turns', memory.turns)
        if (typeof n === 'number' && n > 0) memory.turns = n
        continue
      }
      if (start.kind !== 'point') return
      const h = helix(base.point, top.point, start.point, memory.turns)
      if (!h) throw new Error('The helix needs an axis with length and a radius')
      doc.add(h)
      return
    }
  },
}

const interpCrv: Command = {
  name: 'InterpCrv',
  async run({ doc, input }) {
    const first = await input.getPoint({ prompt: 'Start of curve' })
    if (first.kind !== 'point') return
    const points = [first.point]
    const curveThrough = (pts: Vector3[]): AnyCurve =>
      pts.length === 2 ? { type: 'polyline', points: pts, closed: false } : { type: 'curve', ...interpolate(pts, 3) }
    for (;;) {
      const options = points.length >= 3 ? ['Close', 'Undo'] : points.length >= 2 ? ['Undo'] : []
      const next = await input.getPoint({
        prompt: 'Next point of curve. Press Enter when done',
        base: points[points.length - 1],
        options,
        rubberBand: false,
        preview: (p) => [tessellate(curveThrough([...points, p]))],
      })
      if (next.kind === 'point') points.push(next.point)
      else if (next.kind === 'option' && isOption(next.option, 'Undo')) {
        if (points.length > 1) points.pop()
      } else if (next.kind === 'option' && isOption(next.option, 'Close')) {
        points.push(points[0].clone())
        break
      } else if (next.kind === 'enter') break
      else throw new CancelError()
    }
    if (points.length >= 2) doc.add(curveThrough(points))
  },
}

const rebuildCommand: Command = {
  name: 'Rebuild',
  async run(ctx: CommandContext) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select curves to rebuild')).filter((id) => {
      const g = doc.objects.get(id)?.geometry
      return g && isCurve(g)
    })
    if (ids.length === 0) throw new Error('Select curves')
    for (;;) {
      const option = await input.getOption('Rebuild options. Press Enter to rebuild', [
        valueOption('PointCount', memory.rebuildPoints),
        valueOption('Degree', memory.rebuildDegree),
      ])
      if (option === null) break
      if (isOption(option, 'PointCount')) {
        const n = await input.getNumber('Number of control points', memory.rebuildPoints)
        if (typeof n === 'number' && n >= 2) memory.rebuildPoints = Math.round(n)
      } else if (isOption(option, 'Degree')) {
        const n = await input.getNumber('Degree (1 to 11)', memory.rebuildDegree)
        if (typeof n === 'number' && n >= 1 && n <= 11) memory.rebuildDegree = Math.round(n)
      }
    }
    if (memory.rebuildPoints <= memory.rebuildDegree) throw new Error('A curve needs more control points than its degree')
    let worst = 0
    for (const id of ids) {
      const g = doc.objects.get(id)!.geometry as AnyCurve
      const rebuilt = rebuild(g, memory.rebuildPoints, memory.rebuildDegree)
      // How far the new curve strays from the old one.
      for (const p of tessellate(g)) worst = Math.max(worst, closestPoint(rebuilt, p).distance)
      doc.setGeometry(id, rebuilt)
    }
    log(`${plural('curve', ids.length)} rebuilt with ${memory.rebuildPoints} points, degree ${memory.rebuildDegree}. Largest deviation ${formatValue(Number(worst.toPrecision(3)))}`)
  },
}

const blendCrv: Command = {
  name: 'BlendCrv',
  async run({ doc, input, log }) {
    const continuities: Continuity[] = ['position', 'tangency', 'curvature']
    const label = (c: Continuity) => c[0].toUpperCase() + c.slice(1)
    const pickEnd = async (prompt: string) => {
      for (;;) {
        const pick = await input.getPick(prompt, [`Continuity=${label(memory.continuity)}`])
        if (pick.kind === 'option') {
          memory.continuity = continuities[(continuities.indexOf(memory.continuity) + 1) % continuities.length]
          continue
        }
        if (pick.kind !== 'pick') return null
        const g = doc.objects.get(pick.id)?.geometry
        if (!g || !isCurve(g)) {
          log('Pick near the end of a curve')
          continue
        }
        // The end nearer the click is blended.
        const [t0, t1] = domain(g)
        const t = closestPoint(g, pick.point).t
        return { id: pick.id, curve: g, atStart: t - t0 < t1 - t }
      }
    }
    const a = await pickEnd('Select the end of the first curve')
    if (!a) return
    doc.select([a.id])
    const b = await pickEnd('Select the end of the second curve')
    if (!b) return
    const g = blend(a.curve, a.atStart, b.curve, b.atStart, memory.continuity)
    doc.select([doc.add(g, doc.objects.get(a.id)!.layerId).id])
  },
}

export const curveCommands: Command[] = [ellipseCommand, polygonCommand, helixCommand, interpCrv, rebuildCommand, blendCrv]
