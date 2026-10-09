import { Vector3 } from 'three'
import { closestPoint } from '../core/curves'
import { AnnotationGeometry, AnnotationKind, isCurve, Plane, tangentAt, wireframe } from '../core/geometry'
import { CancelError, GetPointOptions, GetResult } from '../input/interaction'
import { isOption, valueOption } from './helpers'
import type { Command, CommandContext } from './runner'

/** Style of new texts and dimensions, remembered between commands. */
const style = { height: 1, arrow: 'arrow' as AnnotationGeometry['arrow'], precision: 2 }

const styleOptions = (arrows: boolean) => [valueOption('Height', style.height), ...(arrows ? [`Arrow=${style.arrow === 'arrow' ? 'Arrow' : 'Tick'}`] : [])]

/** Handles the Height and Arrow options; true if the option was one of them. */
async function changeStyle(ctx: CommandContext, option: string): Promise<boolean> {
  if (isOption(option, 'Height')) {
    const value = await ctx.input.getNumber('Text height', style.height)
    if (typeof value === 'number' && value > 0) style.height = value
    return true
  }
  if (isOption(option, 'Arrow')) {
    style.arrow = style.arrow === 'arrow' ? 'tick' : 'arrow'
    return true
  }
  return false
}

/** Asks for a point, offering the style options until a point (or something else) is given. */
async function getPointWithStyle(ctx: CommandContext, opts: GetPointOptions, arrows = true): Promise<GetResult> {
  for (;;) {
    const result = await ctx.input.getPoint({ ...opts, options: styleOptions(arrows) })
    if (result.kind === 'option' && (await changeStyle(ctx, result.option))) continue
    return result
  }
}

const make = (kind: AnnotationKind, points: Vector3[], plane: Pick<Plane, 'xaxis' | 'yaxis'>, text = ''): AnnotationGeometry => ({
  type: 'annotation',
  kind,
  points,
  xaxis: plane.xaxis.clone(),
  yaxis: plane.yaxis.clone(),
  text,
  height: style.height,
  arrow: style.arrow,
  precision: style.precision,
})

function add(ctx: CommandContext, g: AnnotationGeometry): void {
  ctx.doc.add(g)
}

const point = (r: GetResult) => {
  if (r.kind !== 'point') throw new CancelError()
  return r
}

const text: Command = {
  name: 'Text',
  async run(ctx) {
    const at = point(await getPointWithStyle(ctx, { prompt: 'Text location (lower left)' }, false))
    const content = await ctx.input.getString('Text (type \\n for a new line)')
    if (!content) return
    add(ctx, make('text', [at.point], at.viewport.cplane, content))
  },
}

/**
 * Linear dimensions measure along the construction plane's X or Y: X when the dimension line is
 * dragged above or below the points, Y when it is dragged to a side.
 */
function linearPlane(plane: Plane, p1: Vector3, p2: Vector3, at: Vector3): Pick<Plane, 'xaxis' | 'yaxis'> {
  const coord = (p: Vector3) => [p.dot(plane.xaxis), p.dot(plane.yaxis)]
  const [x1, y1] = coord(p1)
  const [x2, y2] = coord(p2)
  const [x, y] = coord(at)
  const beyond = (v: number, a: number, b: number) => Math.max(0, Math.min(a, b) - v, v - Math.max(a, b))
  const vertical = beyond(x, x1, x2) > beyond(y, y1, y2)
  return vertical ? { xaxis: plane.yaxis, yaxis: plane.xaxis.clone().negate() } : plane
}

function linearCommand(name: string, kind: 'linear' | 'aligned'): Command {
  return {
    name,
    async run(ctx) {
      const first = point(await getPointWithStyle(ctx, { prompt: 'First dimension point' }))
      const plane = first.viewport.cplane
      const second = point(await ctx.input.getPoint({ prompt: 'Second dimension point', base: first.point }))
      const p1 = first.point
      const p2 = second.point
      const build = (at: Vector3) => make(kind, [p1, p2, at], kind === 'linear' ? linearPlane(plane, p1, p2, at) : plane)
      const at = point(
        await ctx.input.getPoint({ prompt: 'Dimension location', base: p2, rubberBand: false, preview: (p) => wireframe(build(p)) }),
      )
      add(ctx, build(at.point))
    },
  }
}

/** The circle or arc under a pick: its center, radius and plane. */
function circleOf(ctx: CommandContext, id: number): { center: Vector3; radius: number; plane: Pick<Plane, 'xaxis' | 'yaxis'> } | null {
  const g = ctx.doc.objects.get(id)?.geometry
  if (!g) return null
  if (g.type === 'circle' || g.type === 'arc') return { center: g.center, radius: g.radius, plane: g }
  if (g.type === 'polycurve') {
    const arcs = g.segments.filter((s) => s.type === 'arc')
    return arcs.length > 0 ? { center: arcs[0].center, radius: arcs[0].radius, plane: arcs[0] } : null
  }
  return null
}

function radialCommand(name: string, kind: 'radius' | 'diameter'): Command {
  return {
    name,
    async run(ctx) {
      const { input } = ctx
      let circle: ReturnType<typeof circleOf> = null
      let picked = new Vector3()
      while (!circle) {
        const pick = await input.getPick('Select circle or arc', styleOptions(true))
        if (pick.kind === 'option') {
          await changeStyle(ctx, pick.option)
          continue
        }
        if (pick.kind !== 'pick') return
        circle = circleOf(ctx, pick.id)
        picked = pick.point
        if (!circle) ctx.log('That is not a circle or an arc')
      }
      const { center, radius, plane } = circle
      const onCircle = (p: Vector3) => {
        const n = plane.xaxis.clone().cross(plane.yaxis)
        const d = p.clone().sub(center)
        d.addScaledVector(n, -d.dot(n))
        return center.clone().addScaledVector(d.lengthSq() > 1e-18 ? d.normalize() : plane.xaxis, radius)
      }
      const build = (at: Vector3) => make(kind, [center, onCircle(at), at], plane)
      const at = point(
        await input.getPoint({ prompt: 'Dimension location', base: onCircle(picked), rubberBand: false, preview: (p) => wireframe(build(p)) }),
      )
      add(ctx, build(at.point))
    },
  }
}

/** Where two lines in a plane cross, or null if they are parallel. */
function crossing(p: Vector3, u: Vector3, q: Vector3, w: Vector3, plane: Plane): Vector3 | null {
  const n = plane.normal
  const denom = u.clone().cross(w).dot(n)
  if (Math.abs(denom) < 1e-12) return null
  const s = q.clone().sub(p).cross(w).dot(n) / denom
  return p.clone().addScaledVector(u, s)
}

const dimAngle: Command = {
  name: 'DimAngle',
  async run(ctx) {
    const { input, doc } = ctx
    let vertex: Vector3
    let a: Vector3
    let b: Vector3
    let plane: Plane
    const firstPick = await (async () => {
      for (;;) {
        const pick = await input.getPick('Select first line', [...styleOptions(true), 'Points'])
        if (pick.kind === 'option' && (await changeStyle(ctx, pick.option))) continue
        return pick
      }
    })()
    if (firstPick.kind === 'option') {
      // Three points: vertex, then one point on each side.
      const v = point(await input.getPoint({ prompt: 'Angle vertex' }))
      plane = v.viewport.cplane
      vertex = v.point
      a = point(await input.getPoint({ prompt: 'First angle point', base: vertex })).point
      b = point(await input.getPoint({ prompt: 'Second angle point', base: vertex })).point
    } else {
      if (firstPick.kind !== 'pick') return
      const secondPick = await input.getPick('Select second line')
      if (secondPick.kind !== 'pick') return
      plane = firstPick.viewport.cplane
      const lineAt = (id: number, at: Vector3) => {
        const g = doc.objects.get(id)?.geometry
        if (!g || !isCurve(g)) throw new Error('Select lines or curves')
        const c = closestPoint(g, at)
        return { point: c.point, direction: tangentAt(g, c.t).normalize() }
      }
      const l1 = lineAt(firstPick.id, firstPick.point)
      const l2 = lineAt(secondPick.id, secondPick.point)
      const meet = crossing(l1.point, l1.direction, l2.point, l2.direction, plane)
      if (!meet) throw new Error('The lines are parallel')
      vertex = meet
      // The picked points choose the angle between the lines.
      a = l1.point.distanceTo(vertex) > 1e-9 ? l1.point : vertex.clone().add(l1.direction)
      b = l2.point.distanceTo(vertex) > 1e-9 ? l2.point : vertex.clone().add(l2.direction)
    }
    const build = (at: Vector3) => make('angle', [vertex, a, b, at], plane)
    const at = point(
      await input.getPoint({ prompt: 'Dimension arc location', base: vertex, rubberBand: false, preview: (p) => wireframe(build(p)) }),
    )
    add(ctx, build(at.point))
  },
}

const leader: Command = {
  name: 'Leader',
  async run(ctx) {
    const { input } = ctx
    const start = point(await getPointWithStyle(ctx, { prompt: 'Start of leader (arrow tip)' }))
    const plane = start.viewport.cplane
    const points = [start.point]
    for (;;) {
      const next = await input.getPoint({
        prompt: points.length < 2 ? 'Next point of leader' : 'Next point of leader. Press Enter when done',
        base: points[points.length - 1],
        options: points.length >= 2 ? ['Undo'] : [],
        rubberBand: false,
        preview: (p) => wireframe(make('leader', [...points, p], plane)),
      })
      if (next.kind === 'point') points.push(next.point)
      else if (next.kind === 'option') points.pop()
      else if (next.kind === 'enter' && points.length >= 2) break
      else if (next.kind !== 'enter') return
    }
    const content = (await input.getString('Leader text (type \\n for a new line; Enter for none)')) ?? ''
    add(ctx, make('leader', points, plane, content))
  },
}

export const annotationCommands: Command[] = [
  text,
  linearCommand('Dim', 'linear'),
  linearCommand('DimAligned', 'aligned'),
  radialCommand('DimRadius', 'radius'),
  radialCommand('DimDiameter', 'diameter'),
  dimAngle,
  leader,
]
