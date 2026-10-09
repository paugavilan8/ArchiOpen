import { Vector3 } from 'three'
import * as R from 'replicad'
import { join, translate } from '../core/curves'
import { AnyCurve, pointAt, domain } from '../core/geometry'
import { interpolate } from '../math/nurbs'
import { extrudeCurve, joinShapes } from './brep'
import { edgeToCurve } from './edges'

/**
 * Editing surfaces and solids: splitting and trimming them with curves or other surfaces, capping
 * holes, offsetting, extruding surfaces, projecting and pulling curves onto them, and taking faces
 * and edges out of them. Needs the kernel.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()

const list = (shapes: AnyShape[]) => {
  const l = new (oc().NCollection_List_TopoDS_Shape)()
  for (const s of shapes) l.Append(s.wrapped)
  return l
}

/** Size of a shape's bounding box diagonal. */
function sizeOf(shapes: AnyShape[]): number {
  let size = 0
  for (const s of shapes) {
    const b = s.boundingBox
    size = Math.max(size, Math.hypot(b.width, b.height, b.depth))
  }
  return Math.max(size, 1e-6)
}

/**
 * Surfaces that cut like a curve seen along `direction`: the curve extruded through the whole
 * region of the shapes, the way a curve drawn in a view cuts what is behind it.
 */
export function curveCutter(curve: AnyCurve, direction: Vector3, around: AnyShape[]): AnyShape {
  const reach = sizeOf(around) * 2 + 1
  const d = direction.clone().normalize()
  const start = translate(curve, d.clone().multiplyScalar(-reach))
  return extrudeCurve(start, d.multiplyScalar(2 * reach), false)
}

/**
 * Faces sharing edges, grouped, each group sewn into one surface or polysurface. Edges for which
 * `cut` is true (those made by a split) keep the faces on either side apart.
 */
function connectedPieces(faces: R.Face[], cut: (edge: R.Edge) => boolean = () => false): AnyShape[] {
  const owner = faces.map((_, i) => i)
  const find = (i: number): number => (owner[i] === i ? i : (owner[i] = find(owner[i])))
  const byEdge = new Map<number, number>()
  const cuts = new Map<number, boolean>()
  faces.forEach((face, i) => {
    for (const edge of face.edges) {
      if (!cuts.has(edge.hashCode)) cuts.set(edge.hashCode, cut(edge))
      if (cuts.get(edge.hashCode)) continue
      const other = byEdge.get(edge.hashCode)
      if (other === undefined) byEdge.set(edge.hashCode, i)
      else owner[find(i)] = find(other)
    }
  })
  const groups = new Map<number, R.Face[]>()
  faces.forEach((face, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), face]))
  return [...groups.values()].map((group) => (group.length === 1 ? group[0] : joinShapes(group)))
}

/**
 * Splits a surface, polysurface or solid with other shapes (cutting surfaces, or solids). Solids
 * split into solids; surfaces into the connected pieces left between the cuts.
 */
export function splitShape(shape: AnyShape, tools: AnyShape[]): AnyShape[] {
  const k = oc()
  const splitter = new k.BRepAlgoAPI_Splitter()
  const args = list([shape])
  const cutters = list(tools)
  splitter.SetArguments(args)
  splitter.SetTools(cutters)
  splitter.Build()
  if (!splitter.IsDone()) {
    splitter.delete()
    throw new Error('The split failed')
  }
  const result = R.cast(splitter.Shape())
  splitter.delete()
  args.delete()
  cutters.delete()
  const solids = (shape as R.Shape3D).solids?.length ?? 0
  if (solids > 0) return (result as R.Shape3D).solids
  // Pieces stay apart along the cuts: edges lying on a cutting shape.
  const tolerance = sizeOf([shape]) * 1e-6 + 1e-7
  const onTool = (edge: R.Edge) => {
    const mid = edge.pointAt(0.5)
    const p = new Vector3(mid.x, mid.y, mid.z)
    return tools.some((t) => (closestOn(t, p)?.distance ?? Infinity) <= tolerance)
  }
  return connectedPieces(result.faces, onTool)
}

/** The distance from a point to a shape, and the closest point of the shape; null if it fails. */
function closestOn(shape: AnyShape, point: Vector3): { distance: number; point: Vector3 } | null {
  const vertex = R.makeVertex([point.x, point.y, point.z])
  const dist = new (oc().BRepExtrema_DistShapeShape)()
  dist.LoadS1(vertex.wrapped)
  dist.LoadS2(shape.wrapped)
  dist.Perform()
  let out: { distance: number; point: Vector3 } | null = null
  if (dist.IsDone() && dist.NbSolution() > 0) {
    const q = dist.PointOnShape2(1)
    out = { distance: dist.Value(), point: new Vector3(q.X(), q.Y(), q.Z()) }
  }
  dist.delete()
  return out
}

/** The piece nearest a point. */
export function nearestPiece(pieces: AnyShape[], point: Vector3): number {
  let best = -1
  let bestDistance = Infinity
  pieces.forEach((piece, i) => {
    const d = closestOn(piece, point)?.distance ?? Infinity
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

/** Edges that bound only one face: the open borders of a surface or polysurface. */
function freeEdges(shape: AnyShape): R.Edge[] {
  const count = new Map<number, number>()
  for (const face of shape.faces) for (const edge of face.edges) count.set(edge.hashCode, (count.get(edge.hashCode) ?? 0) + 1)
  return shape.edges.filter((e) => count.get(e.hashCode) === 1)
}

const key = (v: R.Vector) => [v.x, v.y, v.z]
const close = (a: number[], b: number[], tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol

/** Edges chained end to end into closed loops (and leftovers that do not close). */
function loops(edges: R.Edge[], tolerance: number): R.Edge[][] {
  const left = [...edges]
  const out: R.Edge[][] = []
  while (left.length > 0) {
    const loop = [left.shift()!]
    const first = key(loop[0].startPoint)
    let end = key(loop[0].endPoint)
    for (let found = true; found && !close(end, first, tolerance); ) {
      found = false
      for (let i = 0; i < left.length; i++) {
        const e = left[i]
        if (close(key(e.startPoint), end, tolerance)) end = key(e.endPoint)
        else if (close(key(e.endPoint), end, tolerance)) end = key(e.startPoint)
        else continue
        loop.push(e)
        left.splice(i, 1)
        found = true
        break
      }
    }
    out.push(loop)
  }
  return out
}

/** The open borders of a surface or polysurface as curves. */
export function borderCurves(shape: AnyShape): AnyCurve[] {
  const pieces = freeEdges(shape)
    .map(edgeToCurve)
    .filter((c): c is AnyCurve => c !== null)
  return join(pieces).map((j) => j.geometry)
}

/** Edges of a shape, by index in its edge list, as curves. */
export function edgeCurves(shape: AnyShape, indices: number[]): AnyCurve[] {
  const edges = shape.edges
  return indices.map((i) => edges[i] && edgeToCurve(edges[i])).filter((c): c is AnyCurve => !!c)
}

/**
 * Closes the planar holes of an open polysurface with flat faces; if that closes it completely, the
 * result is a solid. Returns the shape and how many holes were capped.
 */
export function capHoles(shape: AnyShape): { shape: AnyShape; capped: number } {
  const tolerance = sizeOf([shape]) * 1e-6 + 1e-7
  const caps: AnyShape[] = []
  for (const loop of loops(freeEdges(shape), tolerance)) {
    try {
      const wire = R.assembleWire(loop)
      if (!wire.isClosed) continue
      caps.push(R.makeFace(wire))
    } catch {
      // Not planar or not closed: left open.
    }
  }
  if (caps.length === 0) return { shape, capped: 0 }
  return { shape: joinShapes([shape, ...caps], tolerance * 100), capped: caps.length }
}

/** A surface offset by a distance along its normals; with `solid`, the solid between the two. */
export function offsetSurface(shape: AnyShape, distance: number, solid: boolean): AnyShape {
  const k = oc()
  const tolerance = 1e-5
  if (solid) {
    // The simple algorithm also closes the sides between a surface and its offset.
    const maker = new k.BRepOffsetAPI_MakeThickSolid()
    maker.MakeThickSolidBySimple(shape.wrapped, distance)
    if (!maker.IsDone()) throw new Error('The offset failed')
    const result = R.cast(maker.Shape())
    maker.delete()
    // Thickening one way can leave the solid inside out; turn it the right way.
    const volume = R.measureShapeVolumeProperties(result as R.Shape3D).volume
    return volume < 0 ? R.cast(result.wrapped.Reversed()) : result
  }
  const maker = new k.BRepOffsetAPI_MakeOffsetShape()
  maker.PerformByJoin(shape.wrapped, distance, tolerance, k.BRepOffset_Mode.BRepOffset_Skin, false, false, k.GeomAbs_JoinType.GeomAbs_Arc, false)
  if (!maker.IsDone()) throw new Error('The offset failed')
  const result = R.cast(maker.Shape())
  maker.delete()
  return result
}

/** A surface swept straight along a vector into a solid (or, for a polysurface, solids). */
export function extrudeSurface(shape: AnyShape, vector: Vector3): AnyShape {
  const k = oc()
  const vec = new k.gp_Vec(vector.x, vector.y, vector.z)
  const prism = new k.BRepPrimAPI_MakePrism(shape.wrapped, vec, false, true)
  const result = R.cast(prism.Shape())
  prism.delete()
  vec.delete()
  // A polysurface makes one solid per face; joined, they are one.
  const solids = (result as R.Shape3D).solids ?? []
  if (solids.length > 1) {
    let fused: AnyShape = solids[0]
    for (const s of solids.slice(1)) fused = (fused as R.Shape3D).fuse(s)
    return fused
  }
  return solids[0] ?? result
}

/** Where shapes meet: the edges of their intersection, joined into curves. */
export function intersectionCurves(a: AnyShape, b: AnyShape): AnyCurve[] {
  const k = oc()
  const section = new k.BRepAlgoAPI_Section(a.wrapped, b.wrapped, true)
  const result = R.cast(section.Shape())
  section.delete()
  const pieces = result.edges.map(edgeToCurve).filter((c): c is AnyCurve => c !== null)
  return join(pieces).map((j) => j.geometry)
}

/** Curves projected onto a surface or solid along a direction (all the places they land). */
export function projectCurves(curves: AnyCurve[], target: AnyShape, direction: Vector3): AnyCurve[] {
  const d = direction.clone().normalize()
  // Where the cutter runs along faces parallel to the direction it leaves lines in that direction,
  // which are not part of the projection.
  const alongDirection = (c: AnyCurve) => c.type === 'polyline' && c.points.length === 2 && Math.abs(c.points[1].clone().sub(c.points[0]).normalize().dot(d)) > 1 - 1e-9
  return curves.flatMap((c) => {
    const k = oc()
    const cutter = curveCutter(c, d, [target])
    const section = new k.BRepAlgoAPI_Section(cutter.wrapped, target.wrapped, true)
    const result = R.cast(section.Shape())
    section.delete()
    const pieces = result.edges.map(edgeToCurve).filter((e): e is AnyCurve => e !== null && !alongDirection(e))
    return join(pieces).map((j) => j.geometry)
  })
}

/** A curve pulled onto a surface: each of its points moved to the closest point of the surface. */
export function pullCurve(curve: AnyCurve, target: AnyShape, samples = 48): AnyCurve | null {
  const [t0, t1] = domain(curve)
  const points: Vector3[] = []
  for (let i = 0; i <= samples; i++) {
    const hit = closestOn(target, pointAt(curve, t0 + ((t1 - t0) * i) / samples))
    if (hit) points.push(hit.point)
  }
  // Drop repeats (a curve beyond the surface's edge pulls many points onto one).
  const distinct = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-9)
  return distinct.length >= 2 ? { type: 'curve', ...interpolate(distinct, 3) } : null
}

/** Faces of a polysurface taken out: the chosen faces on their own, and the rest joined. */
export function extractFaces(shape: AnyShape, indices: number[]): { extracted: AnyShape[]; rest: AnyShape[] } {
  const faces = shape.faces
  const chosen = new Set(indices)
  const extracted = faces.filter((_, i) => chosen.has(i))
  const remaining = faces.filter((_, i) => !chosen.has(i))
  return { extracted, rest: remaining.length > 0 ? connectedPieces(remaining) : [] }
}
