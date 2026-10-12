import { Box3, Vector3 } from 'three'
import { deformGeometry, pointMap, type Deformation } from '../core/deformations'
import { geometryToJSON, isCurve, wireframe } from '../core/geometry'
import { layerNamed } from './drawing'
import { kernelJob } from '../kernel/client'
import { shapeRef } from '../kernel/wire'
import { isOption, plural, valueOption, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'
import { kernel, readable } from './solids'

/**
 * Twist, Taper, Bend and Flow (along a curve): curves, points, meshes, surfaces and solids
 * deformed in place. Surfaces and solids keep their NURBS form, refined to follow the deformation.
 */

const memory = { twistAngle: 90, taperStart: 1, taperEnd: 0.5, bendAngle: 90, infinite: false, stretch: true }
const DEG = Math.PI / 180

/** The objects' outlines as they would look deformed, for previews. */
function previewOf(ctx: CommandContext, ids: number[]) {
  const lines = ids.flatMap((id) => {
    const g = ctx.doc.objects.get(id)?.geometry
    return g ? wireframe(g) : []
  })
  // Long straight lines bend too: split them up first.
  const fine = lines.map((line) => line.flatMap((p, i) => (i === 0 ? [p] : Array.from({ length: 8 }, (_, k) => line[i - 1].clone().lerp(p, (k + 1) / 8)))))
  return (d: Deformation | null) => {
    if (!d) return []
    const map = pointMap(d)
    return fine.map((line) => line.map(map))
  }
}

/** Deforms the objects in place; surfaces and solids in the kernel. */
async function apply(ctx: CommandContext, ids: number[], d: Deformation): Promise<void> {
  const { doc, log } = ctx
  const map = pointMap(d)
  let done = 0
  let skipped = 0
  for (const id of ids) {
    const g = doc.objects.get(id)?.geometry
    if (!g) continue
    if (g.type === 'brep') {
      await kernel(ctx)
      doc.setGeometry(id, await readable(kernelJob('deformBy', shapeRef(g), d), 'deform that surface or solid'))
      done++
      continue
    }
    const out = deformGeometry(g, map)
    if (out) {
      doc.setGeometry(id, out)
      done++
    } else skipped++
  }
  log(`${plural('object', done)} deformed${skipped > 0 ? `; ${plural('object', skipped)} (blocks, texts, hatches) left as they are` : ''}`)
}

async function axisOf(ctx: CommandContext, what: string, preview: (start: Vector3, end: Vector3) => Vector3[][]): Promise<[Vector3, Vector3] | null> {
  const a = await ctx.input.getPoint({ prompt: `Start of ${what}` })
  if (a.kind !== 'point') return null
  const b = await ctx.input.getPoint({ prompt: `End of ${what}`, base: a.point, preview: (p) => (p.distanceTo(a.point) > 1e-9 ? preview(a.point, p) : []) })
  if (b.kind !== 'point' || b.point.distanceTo(a.point) < 1e-9) return null
  return [a.point, b.point]
}

/** Twist: turns objects about an axis, by an angle growing from nothing at its start. */
const twist: Command = {
  name: 'Twist',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to twist')
    const show = previewOf(ctx, ids)
    const d = (start: Vector3, end: Vector3, angle: number): Deformation => ({ kind: 'twist', start, end, angle: angle * DEG, infinite: memory.infinite })
    const axis = await axisOf(ctx, 'twist axis', (s, e) => show(d(s, e, memory.twistAngle)))
    if (!axis) return
    for (;;) {
      const r = await input.getNumber('Twist angle in degrees', memory.twistAngle, [yesNo('Infinite', memory.infinite)])
      if (typeof r === 'string') {
        if (isOption(r, 'Infinite')) memory.infinite = !memory.infinite
        continue
      }
      memory.twistAngle = r
      return apply(ctx, ids, d(axis[0], axis[1], r))
    }
  },
}

/** Taper: scales objects across an axis, from one factor at its start to another at its end. */
const taper: Command = {
  name: 'Taper',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to taper')
    const show = previewOf(ctx, ids)
    const d = (start: Vector3, end: Vector3): Deformation => ({ kind: 'taper', start, end, startScale: memory.taperStart, endScale: memory.taperEnd, infinite: memory.infinite })
    const axis = await axisOf(ctx, 'taper axis', (s, e) => show(d(s, e)))
    if (!axis) return
    for (;;) {
      const r = await input.getNumber('Scale at the end of the axis', memory.taperEnd, [valueOption('StartScale', memory.taperStart), yesNo('Infinite', memory.infinite)])
      if (typeof r === 'string') {
        if (isOption(r, 'Infinite')) memory.infinite = !memory.infinite
        else if (isOption(r, 'StartScale')) {
          const s = await input.getNumber('Scale at the start of the axis', memory.taperStart)
          if (typeof s === 'number' && s >= 0) memory.taperStart = s
        }
        continue
      }
      if (r < 0) throw new Error('The scale must not be negative')
      memory.taperEnd = r
      return apply(ctx, ids, d(axis[0], axis[1]))
    }
  },
}

/** Bend: bends objects along a spine into an arc of the same length, toward a point. */
const bend: Command = {
  name: 'Bend',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to bend')
    const show = previewOf(ctx, ids)
    const spine = await axisOf(ctx, 'spine', () => [])
    if (!spine) return
    const [start, end] = spine
    const d = (toward: Vector3, angle: number): Deformation => ({ kind: 'bend', start, end, toward, angle: angle * DEG })
    const side = await input.getPoint({ prompt: 'Point to bend toward', base: end, preview: (p) => show(d(p, memory.bendAngle)) })
    if (side.kind !== 'point') return
    const r = await input.getNumber('Bend angle in degrees', memory.bendAngle)
    if (typeof r !== 'number') return
    memory.bendAngle = r
    await apply(ctx, ids, d(side.point, r))
  },
}

/** Flow: moves objects from along a base curve to along a target curve, bending with it. */
const flow: Command = {
  name: 'Flow',
  async run(ctx) {
    const { doc, input, display } = ctx
    const ids = await input.getObjects('Select objects to flow along a curve')
    const pickCurve = async (prompt: string) => {
      for (;;) {
        const pick = await input.getPick(prompt, [yesNo('Stretch', memory.stretch)], (id) => {
          const g = doc.objects.get(id)?.geometry
          return !!g && isCurve(g) && !ids.includes(id)
        })
        if (pick.kind === 'option') {
          memory.stretch = !memory.stretch
          continue
        }
        if (pick.kind !== 'pick') return null
        const g = doc.objects.get(pick.id)?.geometry
        return g && isCurve(g) ? g : null
      }
    }
    const base = await pickCurve('Select the base curve (near the objects)')
    if (!base) return
    const target = await pickCurve('Select the target curve')
    if (!target) return
    await apply(ctx, ids, { kind: 'flow', base, target, stretch: memory.stretch, up: display.active.cplane.normal.clone() })
  },
}

const cageMemory = { points: 3 }

/**
 * CageEdit: puts objects in a cage of points (a grid over their bounding box). Moving the points (by
 * dragging them, with the gumball, Move, ...) reshapes the objects smoothly; deleting the cage
 * leaves them as they are.
 */
const cageEdit: Command = {
  name: 'CageEdit',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select objects to put in a cage')).filter((id) => {
      const g = doc.objects.get(id)?.geometry
      return !!g && g.type !== 'instance' && g.type !== 'annotation' && g.type !== 'hatch' && g.type !== 'clipping'
    })
    if (ids.length === 0) throw new Error('Select curves, points, meshes, surfaces or solids')
    for (;;) {
      const option = await input.getOption('Press Enter to make the cage', [valueOption('Points', cageMemory.points)])
      if (option === null) break
      const n = await input.getNumber('Points in each direction (2 to 6)', cageMemory.points)
      if (typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= 6) cageMemory.points = n
    }
    const box = new Box3()
    for (const id of ids) for (const line of wireframe(doc.objects.get(id)!.geometry)) for (const p of line) box.expandByPoint(p)
    // A flat or straight set of objects still gets a cage with some depth.
    const size = box.getSize(new Vector3())
    const pad = Math.max(size.x, size.y, size.z, 1) * 0.05
    for (const axis of ['x', 'y', 'z'] as const) {
      if (size[axis] < pad) {
        box.min[axis] -= pad
        box.max[axis] += pad
      }
    }
    const n = cageMemory.points
    const counts: [number, number, number] = [n, n, n]
    const layer = layerNamed(ctx, 'Cage', '#d4380d')
    const points: number[] = []
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const f = (a: number) => a / (n - 1)
          const p = new Vector3(box.min.x + (box.max.x - box.min.x) * f(i), box.min.y + (box.max.y - box.min.y) * f(j), box.min.z + (box.max.z - box.min.z) * f(k))
          points.push(doc.add({ type: 'point', point: p }, layer.id).id)
        }
    doc.group(points)
    for (const id of ids) {
      doc.setHistory(id, { command: 'CageEdit', inputs: points, params: { original: geometryToJSON(doc.objects.get(id)!.geometry), min: box.min.toArray(), max: box.max.toArray(), counts } })
    }
    doc.select(points)
    log(`${plural('object', ids.length)} in a cage of ${n}×${n}×${n} points (Cage layer). Move the points and the objects follow; delete the cage to leave them as they are`)
  },
}

export const deformCommands: Command[] = [twist, taper, bend, flow, cageEdit]
