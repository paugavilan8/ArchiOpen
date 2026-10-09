import { Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import { AnyCurve, BrepGeometry, isCurve, tessellate, wireframe } from '../core/geometry'
import { CancelError } from '../input/interaction'
import {
  boolean,
  BooleanKind,
  box,
  cylinder,
  explodeShape,
  extrudeCurve,
  filletEdges,
  joinShapes,
  loftCurves,
  nearestFace,
  planarFace,
  revolveCurve,
  sectionCurves,
  shapeOf,
  shellSolid,
  sphere,
  sweep,
  toBrep,
} from '../kernel/brep'
import { brepHooks } from './curveEdit'
import { kernelReady, loadKernel } from '../kernel/loadKernel'
import { isOption, plural, valueOption, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'

/** Defaults the solid commands remember between runs. */
const memory = {
  height: 10,
  radius: 5,
  extrudeDistance: 10,
  extrudeSolid: true,
  revolveAngle: 360,
  filletRadius: 1,
  shellThickness: 1,
  contourSpacing: 3,
}

export async function kernel(ctx: CommandContext): Promise<void> {
  if (kernelReady()) return
  ctx.log('Loading the geometry kernel (only the first time)…')
  await loadKernel()
}

/** Runs a kernel operation and adds the result, turning kernel failures into a readable error. */
function addShape(ctx: CommandContext, make: () => AnyShape, what: string, layerId?: number): number {
  let shape: AnyShape
  try {
    shape = make()
  } catch (error) {
    console.error(error)
    throw new Error(`Could not ${what}. Check that the input is valid (closed, planar, not self-intersecting)`)
  }
  return ctx.doc.add(toBrep(shape), layerId).id
}

const curveOf = (ctx: CommandContext, id: number): AnyCurve | null => {
  const g = ctx.doc.objects.get(id)?.geometry
  return g && isCurve(g) ? g : null
}
const brepOf = (ctx: CommandContext, id: number): BrepGeometry | null => {
  const g = ctx.doc.objects.get(id)?.geometry
  return g?.type === 'brep' ? g : null
}

/** Signed height of p above the base along n; in the base's own plane, the distance from the base. */
function heightAt(base: Vector3, n: Vector3, p: Vector3): number {
  const h = p.clone().sub(base).dot(n)
  return Math.abs(h) > 1e-9 ? h : p.distanceTo(base)
}

/** Asks for a height: typed, or picked (see heightAt). Resolves to null when cancelled with Enter. */
async function getHeight(ctx: CommandContext, base: Vector3, n: Vector3, preview: (h: number) => Vector3[][]): Promise<number> {
  const result = await ctx.input.getPoint({
    prompt: `Height <${memory.height}>`,
    base,
    acceptNumber: true,
    rubberBand: false,
    preview: (p) => preview(heightAt(base, n, p)),
  })
  if (result.kind === 'number') return result.value
  if (result.kind === 'point') return heightAt(base, n, result.point)
  if (result.kind === 'enter') return memory.height
  throw new CancelError()
}

/** Wireframe of the box on rectangle (a, u, v) extruded by w, for previews. */
function boxLines(a: Vector3, u: Vector3, v: Vector3, w: Vector3): Vector3[][] {
  const bottom = [a, a.clone().add(u), a.clone().add(u).add(v), a.clone().add(v)]
  const top = bottom.map((p) => p.clone().add(w))
  return [[...bottom, bottom[0]], [...top, top[0]], ...bottom.map((p, i) => [p, top[i]])]
}

const boxCommand: Command = {
  name: 'Box',
  async run(ctx) {
    const { input } = ctx
    const first = await input.getPoint({ prompt: 'First corner of base' })
    if (first.kind !== 'point') return
    const a = first.point
    const { xaxis, yaxis, normal } = first.viewport.cplane
    const sides = (p: Vector3) => {
      const d = p.clone().sub(a)
      return [xaxis.clone().multiplyScalar(d.dot(xaxis)), yaxis.clone().multiplyScalar(d.dot(yaxis))]
    }
    const second = await input.getPoint({
      prompt: 'Other corner of base (type r20,10 for width and depth)',
      base: a,
      rubberBand: false,
      preview: (p) => {
        const [u, v] = sides(p)
        return boxLines(a, u, v, new Vector3())
      },
    })
    if (second.kind !== 'point') return
    const [u, v] = sides(second.point)
    if (u.length() < 1e-9 || v.length() < 1e-9) throw new Error('The base has no area')
    const h = await getHeight(ctx, second.point, normal, (h) => boxLines(a, u, v, normal.clone().multiplyScalar(h)))
    if (Math.abs(h) < 1e-9) throw new Error('The height must not be zero')
    memory.height = Math.abs(h)
    await kernel(ctx)
    addShape(ctx, () => box(a, u, v, normal.clone().multiplyScalar(h)), 'make the box')
  },
}

function circleLines(center: Vector3, x: Vector3, y: Vector3, r: number): Vector3[] {
  const pts: Vector3[] = []
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2
    pts.push(center.clone().addScaledVector(x, r * Math.cos(t)).addScaledVector(y, r * Math.sin(t)))
  }
  return pts
}

/** Asks for a radius around a center (typed or picked). */
async function getRadius(ctx: CommandContext, center: Vector3, x: Vector3, y: Vector3): Promise<number> {
  const result = await ctx.input.getPoint({
    prompt: `Radius <${memory.radius}>`,
    base: center,
    acceptNumber: true,
    preview: (p) => [circleLines(center, x, y, p.distanceTo(center))],
  })
  const r = result.kind === 'number' ? result.value : result.kind === 'point' ? result.point.distanceTo(center) : result.kind === 'enter' ? memory.radius : null
  if (r === null) throw new CancelError()
  if (r <= 0) throw new Error('The radius must be more than zero')
  memory.radius = r
  return r
}

const cylinderCommand: Command = {
  name: 'Cylinder',
  async run(ctx) {
    const base = await ctx.input.getPoint({ prompt: 'Center of base' })
    if (base.kind !== 'point') return
    const c = base.point
    const { xaxis, yaxis, normal } = base.viewport.cplane
    const r = await getRadius(ctx, c, xaxis, yaxis)
    const h = await getHeight(ctx, c, normal, (h) => {
      const top = c.clone().addScaledVector(normal, h)
      return [circleLines(c, xaxis, yaxis, r), circleLines(top, xaxis, yaxis, r), [c.clone().addScaledVector(xaxis, r), top.clone().addScaledVector(xaxis, r)]]
    })
    if (Math.abs(h) < 1e-9) throw new Error('The height must not be zero')
    memory.height = Math.abs(h)
    await kernel(ctx)
    // A negative height grows the cylinder downwards.
    addShape(ctx, () => cylinder(c, r, Math.abs(h), h > 0 ? normal : normal.clone().negate()), 'make the cylinder')
  },
}

const sphereCommand: Command = {
  name: 'Sphere',
  async run(ctx) {
    const center = await ctx.input.getPoint({ prompt: 'Center of sphere' })
    if (center.kind !== 'point') return
    const { xaxis, yaxis } = center.viewport.cplane
    const r = await getRadius(ctx, center.point, xaxis, yaxis)
    await kernel(ctx)
    addShape(ctx, () => sphere(center.point, r), 'make the sphere')
  },
}

const extrudeCrv: Command = {
  name: 'ExtrudeCrv',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = (await input.getObjects('Select curves to extrude')).filter((id) => curveOf(ctx, id))
    if (ids.length === 0) throw new Error('Select curves to extrude')
    const n = display.active.cplane.normal.clone()
    const outlines = ids.map((id) => tessellate(curveOf(ctx, id)!))
    const base = outlines[0][0]

    for (;;) {
      const result = await input.getPoint({
        prompt: `Extrusion distance <${memory.extrudeDistance}>`,
        base,
        acceptNumber: true,
        rubberBand: false,
        options: [yesNo('Solid', memory.extrudeSolid)],
        preview: (p) => {
          const shift = n.clone().multiplyScalar(heightAt(base, n, p))
          return outlines.flatMap((pts) => [pts.map((q) => q.clone().add(shift)), [pts[0], pts[0].clone().add(shift)], [pts[pts.length - 1], pts[pts.length - 1].clone().add(shift)]])
        },
      })
      if (result.kind === 'option') {
        memory.extrudeSolid = !memory.extrudeSolid
        continue
      }
      const distance = result.kind === 'number' ? result.value : result.kind === 'point' ? heightAt(base, n, result.point) : result.kind === 'enter' ? memory.extrudeDistance : null
      if (distance === null) return
      if (Math.abs(distance) < 1e-9) throw new Error('The distance must not be zero')
      memory.extrudeDistance = Math.abs(distance)
      await kernel(ctx)
      const created = ids.map((id) =>
        addShape(ctx, () => extrudeCurve(curveOf(ctx, id)!, n.clone().multiplyScalar(distance), memory.extrudeSolid), 'extrude the curve', doc.objects.get(id)!.layerId),
      )
      doc.select(created)
      log(`${plural('object', created.length)} created`)
      return
    }
  },
}

const revolve: Command = {
  name: 'Revolve',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select curves to revolve')).filter((id) => curveOf(ctx, id))
    if (ids.length === 0) throw new Error('Select curves to revolve')
    const start = await input.getPoint({ prompt: 'Start of revolve axis' })
    if (start.kind !== 'point') return
    const end = await input.getPoint({ prompt: 'End of revolve axis', base: start.point })
    if (end.kind !== 'point') return
    const axis = end.point.clone().sub(start.point)
    if (axis.length() < 1e-9) throw new Error('The axis has no length')
    const angle = await input.getNumber('Revolution angle', memory.revolveAngle)
    if (typeof angle !== 'number') return
    memory.revolveAngle = angle
    await kernel(ctx)
    const created = ids.map((id) =>
      addShape(ctx, () => revolveCurve(curveOf(ctx, id)!, start.point, axis.normalize(), (angle * Math.PI) / 180), 'revolve the curve', doc.objects.get(id)!.layerId),
    )
    doc.select(created)
    log(`${plural('object', created.length)} created`)
  },
}

const loft: Command = {
  name: 'Loft',
  async run(ctx) {
    const { doc, input } = ctx
    // Curves are lofted in the order they were selected.
    const ids = (await input.getObjects('Select curves to loft, in order')).filter((id) => curveOf(ctx, id))
    if (ids.length < 2) throw new Error('Select at least two curves')
    await kernel(ctx)
    const id = addShape(ctx, () => loftCurves(ids.map((i) => curveOf(ctx, i)!)), 'loft the curves', doc.objects.get(ids[0])!.layerId)
    doc.select([id])
  },
}

const planarSrf: Command = {
  name: 'PlanarSrf',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select closed planar curves')).filter((id) => curveOf(ctx, id))
    await kernel(ctx)
    const created: number[] = []
    for (const id of ids) {
      const face = planarFace(curveOf(ctx, id)!)
      if (face) created.push(doc.add(toBrep(face), doc.objects.get(id)!.layerId).id)
    }
    doc.select(created)
    log(created.length === ids.length ? `${plural('surface', created.length)} created` : `${created.length} of ${ids.length} curves were closed and planar`)
  },
}

/** Solids for booleans: picks breps from a selection and loads their exact shapes. */
function shapesOf(ctx: CommandContext, ids: number[]): { ids: number[]; shapes: AnyShape[] } {
  const breps = ids.filter((id) => brepOf(ctx, id))
  return { ids: breps, shapes: breps.map((id) => shapeOf(brepOf(ctx, id)!)) }
}

function booleanCommand(name: string, kind: BooleanKind): Command {
  return {
    name,
    async run(ctx) {
      const { doc, input } = ctx
      await kernel(ctx)
      let first: number[]
      let others: number[]
      if (kind === 'difference') {
        first = await input.getObjects('Select solids to subtract from')
        doc.clearSelection()
        others = await input.getObjects('Select solids to subtract with')
      } else {
        const all = await input.getObjects(`Select solids to ${kind === 'union' ? 'unite' : 'intersect'}`)
        first = all.slice(0, 1)
        others = all.slice(1)
      }
      const a = shapesOf(ctx, first)
      const b = shapesOf(ctx, others.filter((id) => !first.includes(id)))
      if (a.shapes.length === 0 || b.shapes.length === 0) throw new Error('Select surfaces or solids on both sides')
      const layerId = doc.objects.get(a.ids[0])!.layerId
      // Several solids to subtract from are each cut by all the tools.
      const targets = kind === 'difference' ? a.shapes.map((s, i) => ({ shape: s, id: a.ids[i] })) : [{ shape: a.shapes[0], id: a.ids[0] }]
      const created = targets.map(({ shape }) => addShape(ctx, () => boolean(kind, shape, b.shapes), `compute the boolean ${kind}`, layerId))
      for (const id of [...a.ids, ...b.ids]) doc.remove(id)
      doc.select(created)
    },
  }
}

/** Index of the brep edge nearest to a point (the edges are in the kernel's order). */
function nearestEdge(g: BrepGeometry, p: Vector3): number {
  let best = Infinity
  let index = -1
  wireframe(g).forEach((pts, i) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]
      const ab = pts[k].clone().sub(a)
      const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-24)))
      const d = a.clone().addScaledVector(ab, t).distanceTo(p)
      if (d < best) {
        best = d
        index = i
      }
    }
  })
  return index
}

const filletEdge: Command = {
  name: 'FilletEdge',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    let target: number | null = null
    const edges: number[] = []
    for (;;) {
      const pick = await input.getPick(edges.length === 0 ? 'Select edges to fillet' : 'Select more edges. Press Enter to fillet', [valueOption('Radius', memory.filletRadius)])
      if (pick.kind === 'option' && isOption(pick.option, 'Radius')) {
        const r = await input.getNumber('Fillet radius', memory.filletRadius)
        if (typeof r === 'number' && r > 0) memory.filletRadius = r
        continue
      }
      if (pick.kind !== 'pick') break
      const g = brepOf(ctx, pick.id)
      if (!g) {
        log('Pick an edge of a surface or solid')
        continue
      }
      if (target !== null && pick.id !== target) {
        log('All edges must belong to the same object')
        continue
      }
      target = pick.id
      const edge = nearestEdge(g, pick.point)
      if (!edges.includes(edge)) edges.push(edge)
      display.setPreview(edges.map((i) => wireframe(g)[i]), true)
    }
    display.setPreview([])
    if (target === null || edges.length === 0) return
    const g = brepOf(ctx, target)!
    await kernel(ctx)
    const layerId = doc.objects.get(target)!.layerId
    const id = addShape(ctx, () => filletEdges(shapeOf(g), edges, memory.filletRadius), 'fillet these edges (the radius may be too large)', layerId)
    doc.remove(target)
    doc.select([id])
    log(`${plural('edge', edges.length)} filleted`)
  },
}

const sweep1: Command = {
  name: 'Sweep1',
  async run(ctx) {
    const { doc, input, log } = ctx
    const rail = await input.getPick('Select rail (the path to sweep along)')
    if (rail.kind !== 'pick') return
    const path = curveOf(ctx, rail.id)
    if (!path) throw new Error('The rail must be a curve')
    // The cross-sections are selected next, so start from an empty selection.
    doc.clearSelection()
    const ids = (await input.getObjects('Select cross-section curves')).filter((id) => id !== rail.id && curveOf(ctx, id))
    if (ids.length === 0) throw new Error('Select at least one cross-section curve')
    await kernel(ctx)
    const created = ids.map((id) => addShape(ctx, () => sweep(curveOf(ctx, id)!, path), 'sweep the curve', doc.objects.get(id)!.layerId))
    doc.select(created)
    log(`${plural('object', created.length)} created`)
  },
}

/** Triangles of one face, as small closed outlines for highlighting it. */
function faceOutline(g: BrepGeometry, face: number): Vector3[][] {
  const range = g.display.faceTriangles?.[face]
  if (!range) return []
  const { vertices: v, triangles: t } = g.display
  const at = (i: number) => new Vector3(v[t[i] * 3], v[t[i] * 3 + 1], v[t[i] * 3 + 2])
  const lines: Vector3[][] = []
  for (let i = range[0]; i < range[0] + range[1]; i += 3) lines.push([at(i), at(i + 1), at(i + 2), at(i)])
  return lines
}

const shell: Command = {
  name: 'Shell',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    await kernel(ctx)
    let target: number | null = null
    let geometry: BrepGeometry | null = null
    const faces: number[] = []
    for (;;) {
      const pick = await input.getPick(faces.length === 0 ? 'Select faces to remove (they stay open)' : 'Select more faces. Press Enter to shell')
      if (pick.kind !== 'pick') break
      const g = brepOf(ctx, pick.id)
      if (!g || g.kind !== 'solid') {
        log('Pick a face of a closed solid')
        continue
      }
      if (target !== null && pick.id !== target) {
        log('All faces must belong to the same solid')
        continue
      }
      target = pick.id
      // Breps saved before faces were tracked get their face data from the kernel.
      geometry ??= g.display.faceTriangles ? g : toBrep(shapeOf(g))
      const face = nearestFace(geometry, pick.point)
      if (face >= 0 && !faces.includes(face)) faces.push(face)
      display.setPreview(faces.flatMap((f) => faceOutline(geometry!, f)), true)
    }
    display.setPreview([])
    if (target === null || faces.length === 0 || !geometry) return
    const thickness = await input.getNumber('Wall thickness', memory.shellThickness)
    if (typeof thickness !== 'number' || thickness <= 0) return
    memory.shellThickness = thickness
    const solid = geometry
    const layerId = doc.objects.get(target)!.layerId
    const id = addShape(ctx, () => shellSolid(shapeOf(solid), faces, thickness), 'shell the solid (the thickness may be too large)', layerId)
    doc.remove(target)
    doc.select([id])
  },
}

/** Adds section curves through the selected surfaces and solids for each plane. */
function addSections(ctx: CommandContext, ids: number[], planes: { origin: Vector3; normal: Vector3 }[]): number {
  let count = 0
  for (const id of ids) {
    const g = brepOf(ctx, id)
    if (!g) continue
    const shape = shapeOf(g)
    for (const { origin, normal } of planes) {
      for (const curve of sectionCurves(shape, origin, normal)) {
        ctx.doc.add(curve)
        count++
      }
    }
  }
  return count
}

const section: Command = {
  name: 'Section',
  async run(ctx) {
    const { input, log } = ctx
    const ids = (await input.getObjects('Select surfaces and solids to section')).filter((id) => brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select surfaces or solids')
    const start = await input.getPoint({ prompt: 'Start of section plane' })
    if (start.kind !== 'point') return
    const end = await input.getPoint({ prompt: 'End of section plane', base: start.point })
    if (end.kind !== 'point') return
    // The cutting plane stands on the drawn line, perpendicular to the construction plane.
    const normal = end.point.clone().sub(start.point).cross(start.viewport.cplane.normal)
    if (normal.length() < 1e-9) throw new Error('The section line has no length')
    await kernel(ctx)
    const count = addSections(ctx, ids, [{ origin: start.point, normal: normal.normalize() }])
    log(count === 0 ? 'The plane does not cut the selected objects' : `${plural('section curve', count)} created`)
  },
}

const contour: Command = {
  name: 'Contour',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces and solids to contour')).filter((id) => brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select surfaces or solids')
    const base = await input.getPoint({ prompt: 'Base point for contours' })
    if (base.kind !== 'point') return
    const end = await input.getPoint({ prompt: 'Direction perpendicular to the contours (e.g. up in a side view)', base: base.point })
    if (end.kind !== 'point') return
    const direction = end.point.clone().sub(base.point)
    if (direction.length() < 1e-9) throw new Error('The direction has no length')
    direction.normalize()
    const spacing = await input.getNumber('Distance between contours', memory.contourSpacing)
    if (typeof spacing !== 'number' || spacing <= 0) return
    memory.contourSpacing = spacing

    // Planes every `spacing` from the base point, across the extent of the objects.
    let min = Infinity
    let max = -Infinity
    for (const id of ids) {
      const v = brepOf(ctx, id)!.display.vertices
      for (let i = 0; i < v.length; i += 3) {
        const t = new Vector3(v[i], v[i + 1], v[i + 2]).sub(base.point).dot(direction)
        min = Math.min(min, t)
        max = Math.max(max, t)
      }
    }
    const planes: { origin: Vector3; normal: Vector3 }[] = []
    for (let k = Math.ceil(min / spacing); k * spacing <= max && planes.length < 500; k++) {
      planes.push({ origin: base.point.clone().addScaledVector(direction, k * spacing), normal: direction })
    }
    await kernel(ctx)
    const count = addSections(ctx, ids, planes)
    doc.clearSelection()
    log(`${plural('contour curve', count)} on ${plural('plane', planes.length)}`)
  },
}

brepHooks.join = async (ctx, ids) => {
  if (ids.length < 2) return null
  await kernel(ctx)
  const layerId = ctx.doc.objects.get(ids[0])!.layerId
  const id = addShape(ctx, () => joinShapes(ids.map((i) => shapeOf(brepOf(ctx, i)!))), 'join the surfaces', layerId)
  for (const i of ids) ctx.doc.remove(i)
  ctx.doc.select([id])
  const kind = brepOf(ctx, id)!.kind
  return `${plural('surface', ids.length)} joined into ${kind === 'solid' ? 'a closed solid' : 'an open polysurface'}`
}

brepHooks.explode = async (ctx, ids) => {
  const multi = ids.filter((id) => brepOf(ctx, id)!.faces > 1)
  if (multi.length === 0) return 0
  await kernel(ctx)
  let count = 0
  for (const id of multi) {
    const layerId = ctx.doc.objects.get(id)!.layerId
    for (const face of explodeShape(shapeOf(brepOf(ctx, id)!))) {
      ctx.doc.add(toBrep(face), layerId)
      count++
    }
    ctx.doc.remove(id)
  }
  return count
}

export const solidCommands: Command[] = [
  sweep1,
  shell,
  section,
  contour,
  boxCommand,
  cylinderCommand,
  sphereCommand,
  extrudeCrv,
  revolve,
  loft,
  planarSrf,
  booleanCommand('BooleanUnion', 'union'),
  booleanCommand('BooleanDifference', 'difference'),
  booleanCommand('BooleanIntersection', 'intersection'),
  filletEdge,
]
