import * as R from 'replicad'
import type { BrepFaceData, BrepLoopData, NurbsCurveData, NurbsSurfaceData, RhinoBrepData } from '../io/rhinoBrepData'

/**
 * Rebuilds Rhino polysurfaces as exact Open CASCADE shapes. rhino3dm does not expose the 2D trim
 * curves, so each face is made from its NURBS surface and its 3D boundary edges, repaired with
 * ShapeFix (which computes the missing curves on the surface), and the faces are sewn together.
 */

type OC = ReturnType<typeof R.getOC>
type TopoShape = ReturnType<OC['BRepToolsWrapper']['Read']>

const oc = (): OC => R.getOC()

/**
 * A new handle to the same shape. replicad deletes a wrapper's handle when the wrapper is garbage
 * collected, so shapes handed to (or taken from) short-lived wrappers must be separate handles.
 */
function copy(shape: TopoShape): TopoShape {
  const reversed = shape.Reversed()
  const same = reversed.Reversed()
  reversed.delete()
  return same
}

/** Distinct knot values and their multiplicities, as OCCT wants them. */
function knotArrays(knots: number[]) {
  const values: number[] = []
  const mults: number[] = []
  for (const u of knots) {
    if (values.length > 0 && Math.abs(u - values[values.length - 1]) < 1e-12) mults[mults.length - 1]++
    else {
      values.push(u)
      mults.push(1)
    }
  }
  const k = oc()
  const valueArray = new k.NCollection_Array1_double(1, values.length)
  const multArray = new k.NCollection_Array1_int(1, mults.length)
  values.forEach((u, i) => valueArray.SetValue(i + 1, u))
  mults.forEach((m, i) => multArray.SetValue(i + 1, m))
  return { values: valueArray, mults: multArray }
}

function curveEdge(d: NurbsCurveData): TopoShape {
  const k = oc()
  try {
    const poles = new k.NCollection_Array1_gp_Pnt(1, d.points.length)
    d.points.forEach((p, i) => poles.SetValue(i + 1, new k.gp_Pnt(p[0], p[1], p[2])))
    const { values, mults } = knotArrays(d.knots)
    let curve
    if (d.weights) {
      const weights = new k.NCollection_Array1_double(1, d.weights.length)
      d.weights.forEach((w, i) => weights.SetValue(i + 1, w))
      curve = new k.Geom_BSplineCurve(poles, weights, values, mults, d.degree, false)
    } else curve = new k.Geom_BSplineCurve(poles, values, mults, d.degree, false)
    const maker = new k.BRepBuilderAPI_MakeEdge(curve)
    const edge = maker.Edge()
    maker.delete()
    return edge
  } catch {
    // Unusual knot vectors (e.g. periodic curves) fall back to a close approximation.
    return copy(R.makeBSplineApproximation(d.samples as [number, number, number][]).wrapped)
  }
}

function surfaceOf(d: NurbsSurfaceData) {
  const k = oc()
  const nu = d.points.length
  const nv = d.points[0].length
  const poles = new k.NCollection_Array2_gp_Pnt(1, nu, 1, nv)
  d.points.forEach((row, u) => row.forEach((p, v) => poles.SetValue(u + 1, v + 1, new k.gp_Pnt(p[0], p[1], p[2]))))
  const ku = knotArrays(d.knotsU)
  const kv = knotArrays(d.knotsV)
  if (!d.weights) return new k.Geom_BSplineSurface(poles, ku.values, kv.values, ku.mults, kv.mults, d.degreeU, d.degreeV, false, false)
  const weights = new k.NCollection_Array2_double(1, nu, 1, nv)
  d.weights.forEach((row, u) => row.forEach((w, v) => weights.SetValue(u + 1, v + 1, w)))
  return new k.Geom_BSplineSurface(poles, weights, ku.values, kv.values, ku.mults, kv.mults, d.degreeU, d.degreeV, false, false)
}

function wireOf(loop: BrepLoopData, edges: TopoShape[]) {
  const k = oc()
  const list = new k.NCollection_List_TopoDS_Shape()
  for (const trim of loop.trims) {
    if (trim.edge < 0) continue
    const edge = edges[trim.edge]
    list.Append(trim.reversed ? edge.Reversed() : edge)
  }
  const maker = new k.BRepBuilderAPI_MakeWire()
  maker.Add(list)
  const wire = maker.Wire()
  maker.delete()
  return wire
}

const lengthOf = (shape: TopoShape) => R.measureLength(R.cast(copy(shape)) as R.Edge)

/**
 * True when a face is not trimmed: its boundary is only seams and collapsed sides, or its edges add
 * up to the perimeter of the whole surface. Such faces are built from the surface's own bounds.
 */
function isUntrimmed(face: BrepFaceData, edges: TopoShape[], natural: TopoShape): boolean {
  if (face.loops.length !== 1) return false
  const used = face.loops[0].trims.filter((t) => t.edge >= 0).map((t) => t.edge)
  if (used.every((e) => used.filter((x) => x === e).length === 2)) return true
  const loopLength = used.reduce((sum, e) => sum + lengthOf(edges[e]), 0)
  const naturalLength = R.cast(copy(natural)).edges.reduce((sum, e) => sum + R.measureLength(e), 0)
  return Math.abs(loopLength - naturalLength) <= 1e-4 * Math.max(1, naturalLength)
}

/** True when all control points lie in one plane, so the surface is (part of) a plane. */
function isPlanar(d: NurbsSurfaceData): boolean {
  const pts = d.points.flat()
  const [a] = pts
  const span = Math.max(...pts.map((p) => Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2])), 1e-12)
  let normal: number[] | null = null
  for (let i = 1; i < pts.length && !normal; i++) {
    for (let j = i + 1; j < pts.length && !normal; j++) {
      const u = [pts[i][0] - a[0], pts[i][1] - a[1], pts[i][2] - a[2]]
      const w = [pts[j][0] - a[0], pts[j][1] - a[1], pts[j][2] - a[2]]
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      const len = Math.hypot(n[0], n[1], n[2])
      if (len > 1e-9 * span * span) normal = n.map((c) => c / len)
    }
  }
  if (!normal) return false
  const n = normal
  return pts.every((p) => Math.abs((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) < 1e-9 * span)
}

/** A trimmed planar face, built on the exact plane of its outer boundary. */
function planarFaceOf(loops: BrepLoopData[], edges: TopoShape[]): TopoShape {
  const k = oc()
  const maker = new k.BRepBuilderAPI_MakeFace(k.TopoDS.Wire(wireOf(loops[0], edges)), true)
  for (const loop of loops.slice(1)) maker.Add(k.TopoDS.Wire(wireOf(loop, edges)))
  const fix = new k.ShapeFix_Face(maker.Face())
  fix.FixOrientation()
  const result = fix.Face()
  fix.delete()
  maker.delete()
  return result
}

function faceOf(face: BrepFaceData, edges: TopoShape[], tolerance: number): TopoShape {
  const k = oc()
  const surface = surfaceOf(face.surface)
  const naturalMaker = new k.BRepBuilderAPI_MakeFace(surface, 1e-7)
  let result: TopoShape = naturalMaker.Face()
  naturalMaker.delete()

  if (!isUntrimmed(face, edges, result)) {
    const loops = [...face.loops].sort((a, b) => Number(b.outer) - Number(a.outer))
    if (isPlanar(face.surface)) {
      // The face lies in the plane of its boundary; its side follows Rhino's surface normal below.
      const planar = planarFaceOf(loops, edges)
      const natural = R.cast(copy(result)) as R.Face
      const flipped = R.cast(copy(planar)) as R.Face
      const agree = natural.normalAt().dot(flipped.normalAt()) > 0
      return agree !== face.reversed ? planar : planar.Reversed()
    }
    const maker = new k.BRepBuilderAPI_MakeFace(surface, k.TopoDS.Wire(wireOf(loops[0], edges)), true)
    for (const loop of loops.slice(1)) maker.Add(k.TopoDS.Wire(wireOf(loop, edges)))
    const fix = new k.ShapeFix_Face(maker.Face())
    // A tight precision keeps the computed curves on the surface close to the exact edges.
    fix.SetPrecision(Math.min(tolerance, 1e-6))
    fix.Perform()
    // Make the outer boundary run so that the face is the finite region inside it.
    fix.FixOrientation()
    result = fix.Face()
    fix.delete()
    maker.delete()
  }
  return face.reversed ? result.Reversed() : result
}

/** A solid bounded by one closed face (a sphere, a closed revolve), which welding cannot handle. */
function solidOfFace(face: TopoShape): R.AnyShape {
  const k = oc()
  const builder = new k.TopoDS_Builder()
  const shell = new k.TopoDS_Shell()
  builder.MakeShell(shell)
  builder.Add(shell, face)
  const fixer = new k.ShapeFix_Solid()
  try {
    const solid = R.cast(fixer.SolidFromShell(shell))
    if (!(solid instanceof R.Solid)) throw new Error('Not a solid')
    return solid
  } finally {
    fixer.delete()
    builder.delete()
  }
}

/** Builds the exact shape of a Rhino polysurface. Throws if no face could be made. */
export function shapeFromRhino(data: RhinoBrepData, tolerance: number): R.AnyShape {
  const k = oc()
  const edges = data.edges.map(curveEdge)
  const faces: TopoShape[] = []
  for (const face of data.faces) {
    try {
      faces.push(faceOf(face, edges, tolerance))
    } catch (error) {
      console.warn('Could not rebuild a face', error)
    }
  }
  if (faces.length === 0) throw new Error('No face of the polysurface could be rebuilt')
  if (data.solid && faces.length === data.faces.length) {
    // A closed polysurface becomes a solid, oriented outwards; if that fails it stays a shell.
    try {
      return faces.length === 1 ? solidOfFace(faces[0]) : R.makeSolid(faces.map((f) => new R.Face(copy(f))))
    } catch (error) {
      console.warn('Could not close the polysurface into a solid', error)
    }
  }
  if (faces.length === 1) return R.cast(faces[0])

  const sewing = new k.BRepBuilderAPI_Sewing(Math.max(tolerance, 1e-7) * 5, true, true, true, false)
  for (const face of faces) sewing.Add(face)
  sewing.Perform()
  const shape = R.cast(sewing.SewedShape())
  sewing.delete()
  return shape
}
