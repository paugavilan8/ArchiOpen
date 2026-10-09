import * as R from 'replicad'
import type { BrepGeometry } from '../core/geometry'
import { curveDomain, ISO, isoFlag, TRIM, writeBrep, type OnBrep, type OnCurve, type OnSurface } from '../io/openNurbs'
import { shapeOf } from './brep'

/**
 * Exact polysurfaces for Rhino files: an Open CASCADE shape described as openNURBS describes a brep
 * (surfaces, 3D edge curves, 2D trim curves, vertices, loops and faces). Each face keeps its surface's
 * parameters, so its trim curves carry over unchanged: planes stay planes, cylinders, cones, spheres,
 * tori and revolved curves become surfaces of revolution, extruded curves sums of a curve and a line,
 * and B-splines stay B-splines. Throws on what has no exact counterpart (offset surfaces, revolved
 * ellipses, ...), so the caller can fall back to a mesh.
 */

type OC = ReturnType<typeof R.getOC>
type Shape = R.AnyShape['wrapped']
type Vec = [number, number, number]
type Domain = [[number, number], [number, number]]

const oc = (): OC => R.getOC()

const xyz = (p: { X(): number; Y(): number; Z(): number }): Vec => [p.X(), p.Y(), p.Z()]
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s]
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec): Vec => scale(a, 1 / len(a))
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Shapes of one kind inside a shape, as an explorer finds them (with orientations composed). */
function explore(shape: Shape, kind: 'FACE' | 'WIRE' | 'EDGE' | 'VERTEX'): Shape[] {
  const k = oc()
  const out: Shape[] = []
  const ex = new k.TopExp_Explorer(shape, k.TopAbs_ShapeEnum[`TopAbs_${kind}`], k.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; ex.More(); ex.Next()) out.push(ex.Current())
  ex.delete()
  return out
}

const reversed = (s: Shape) => s.Orientation() === oc().TopAbs_Orientation.TopAbs_REVERSED

/** Sub-shapes numbered in the order first seen, the same edge or vertex in any orientation alike. */
class ShapeIndex {
  private readonly buckets = new Map<number, { shape: Shape; index: number }[]>()
  count = 0

  /** The shape's number, or -1 if it has none yet. */
  find(shape: Shape): number {
    const bucket = this.buckets.get(this.hash(shape)) ?? []
    return bucket.find((e) => e.shape.IsSame(shape))?.index ?? -1
  }

  add(shape: Shape): number {
    const hash = this.hash(shape)
    const bucket = this.buckets.get(hash) ?? []
    this.buckets.set(hash, bucket)
    bucket.push({ shape, index: this.count })
    return this.count++
  }

  private hash(shape: Shape): number {
    return (oc() as unknown as { ReplicadShapeHasher: { HashCode(s: Shape, max: number): number } }).ReplicadShapeHasher.HashCode(shape, 2 ** 31 - 1)
  }
}

/** Distinct knots with multiplicities expanded, without the outermost two (openNURBS's convention). */
function onKnots(count: number, knot: (i: number) => number, mult: (i: number) => number): number[] {
  const all: number[] = []
  for (let i = 1; i <= count; i++) for (let m = 0; m < mult(i); m++) all.push(knot(i))
  return all.slice(1, -1)
}

type BSpline3 = InstanceType<OC['Geom_BSplineCurve']>
type BSpline2 = InstanceType<OC['Geom2d_BSplineCurve']>

function nurbsCurve(c: BSpline3 | BSpline2, dim: 2 | 3): OnCurve {
  const n = c.NbPoles()
  const points: number[][] = []
  const weights: number[] = []
  for (let i = 1; i <= n; i++) {
    const p = c.Pole(i)
    points.push(dim === 3 ? xyz(p as ReturnType<BSpline3['Pole']>) : [p.X(), p.Y()])
    p.delete()
    weights.push(c.Weight(i))
  }
  const knots = onKnots(
    c.NbKnots(),
    (i) => c.Knot(i),
    (i) => c.Multiplicity(i),
  )
  const rational = weights.some((w) => Math.abs(w - 1) > 1e-14)
  return { kind: 'nurbs', dim, degree: c.Degree(), knots, points, ...(rational ? { weights } : {}) }
}

/** A curve on [t0, t1] as an exact B-spline over its own parameters (which may change). */
function curve3d(curve: InstanceType<OC['Geom_Curve']>, t0: number, t1: number): OnCurve {
  const k = oc()
  const trimmed = new k.Geom_TrimmedCurve(curve, t0, t1, true, true)
  let bs = k.GeomConvert.CurveToBSplineCurve(trimmed, k.Convert_ParameterisationType.Convert_TgtThetaOver2)
  if (bs.IsPeriodic()) {
    bs = new k.Geom_BSplineCurve(bs)
    bs.SetNotPeriodic()
  }
  const out = nurbsCurve(bs, 3)
  trimmed.delete()
  return out
}

/** A trim curve on [t0, t1], run backwards if `backwards`, as an exact 2D B-spline. */
function curve2d(curve: InstanceType<OC['Geom2d_Curve']>, t0: number, t1: number, backwards: boolean): OnCurve {
  const k = oc()
  const trimmed = new k.Geom2d_TrimmedCurve(curve, t0, t1, true, true)
  if (backwards) trimmed.Reverse()
  let bs = k.Geom2dConvert.CurveToBSplineCurve(trimmed, k.Convert_ParameterisationType.Convert_TgtThetaOver2)
  if (bs.IsPeriodic()) {
    bs = new k.Geom2d_BSplineCurve(bs)
    bs.SetNotPeriodic()
  }
  const out = nurbsCurve(bs, 2)
  trimmed.delete()
  return out
}

type Adaptor3d = ReturnType<InstanceType<OC['BRepAdaptor_Surface']>['BasisCurve']>

/**
 * A curve that keeps its parameter t on [t0, t1]: a line as a degree 1 B-spline, a circle as an arc
 * whose parameter is the angle, B-splines as they are. These are the profiles of revolved and extruded
 * surfaces, whose parameters the trim curves rely on.
 */
function sameParameterCurve(c: Adaptor3d, t0: number, t1: number): OnCurve {
  const k = oc()
  const T = k.GeomAbs_CurveType
  switch (c.GetType()) {
    case T.GeomAbs_Line: {
      const [a, b] = [c.Value(t0), c.Value(t1)]
      const out: OnCurve = { kind: 'nurbs', dim: 3, degree: 1, knots: [t0, t1], points: [xyz(a), xyz(b)] }
      a.delete()
      b.delete()
      return out
    }
    case T.GeomAbs_Circle: {
      const circle = c.Circle()
      const frame = circle.Position()
      const out: OnCurve = {
        kind: 'arc',
        center: xyz(frame.Location()),
        xaxis: xyz(frame.XDirection()),
        yaxis: xyz(frame.YDirection()),
        radius: circle.Radius(),
        angles: [t0, t1],
      }
      frame.delete()
      circle.delete()
      return out
    }
    case T.GeomAbs_BSplineCurve: {
      let bs = c.BSpline()
      if (bs.IsPeriodic()) {
        bs = new k.Geom_BSplineCurve(bs)
        bs.SetNotPeriodic()
      }
      return nurbsCurve(bs, 3)
    }
    case T.GeomAbs_BezierCurve:
      return nurbsCurve(k.GeomConvert.CurveToBSplineCurve(c.Bezier(), k.Convert_ParameterisationType.Convert_TgtThetaOver2), 3)
    default:
      throw new Error(`No exact profile for ${c.GetType()}`)
  }
}

/** Bounding box of a surface over a parameter range, from a grid of points, with a margin. */
function sampledBox(at: (u: number, v: number) => Vec, d: Domain): [Vec, Vec] {
  const min: Vec = [Infinity, Infinity, Infinity]
  const max: Vec = [-Infinity, -Infinity, -Infinity]
  const n = 24
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p = at(d[0][0] + ((d[0][1] - d[0][0]) * i) / n, d[1][0] + ((d[1][1] - d[1][0]) * j) / n)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p[c])
        max[c] = Math.max(max[c], p[c])
      }
    }
  }
  const pad = Math.max(1e-9, len(sub(max, min)) * 0.02)
  return [sub(min, [pad, pad, pad]), add(max, [pad, pad, pad])]
}

/** The parameter ranges of an openNURBS surface. */
export function surfaceDomain(s: OnSurface): Domain {
  switch (s.kind) {
    case 'plane':
      return s.domain
    case 'nurbs':
      return [
        [s.knotsU[s.degreeU - 1], s.knotsU[s.knotsU.length - s.degreeU]],
        [s.knotsV[s.degreeV - 1], s.knotsV[s.knotsV.length - s.degreeV]],
      ]
    case 'revolution':
      return [s.angles, curveDomain(s.curve)]
    case 'sum':
      return [curveDomain(s.curves[0]), curveDomain(s.curves[1])]
  }
}

/** The face's surface with its own parameters, over the face's parameter bounds `uv`. */
function surfaceOf(face: Shape, uv: Domain): OnSurface {
  const k = oc()
  const S = k.GeomAbs_SurfaceType
  const adaptor = new k.BRepAdaptor_Surface(face, false)
  const surface = k.BRep_Tool.Surface(face)
  const at = (u: number, v: number): Vec => {
    const p = surface.Value(u, v)
    const out = xyz(p)
    p.delete()
    return out
  }
  try {
    const type = adaptor.GetType()
    switch (type) {
      case S.GeomAbs_Plane: {
        const frame = adaptor.Plane().Position()
        return { kind: 'plane', origin: xyz(frame.Location()), xaxis: xyz(frame.XDirection()), yaxis: xyz(frame.YDirection()), domain: uv }
      }
      case S.GeomAbs_Cylinder:
      case S.GeomAbs_Cone:
      case S.GeomAbs_Sphere:
      case S.GeomAbs_Torus: {
        // All turn a profile (the u = 0 line) about an axis by the angle u; the axis comes from three
        // points a half and a quarter turn apart.
        const [u0, u1] = uv[0]
        if (u1 - u0 > 2 * Math.PI + 1e-9) throw new Error('Face turns more than once')
        let axis: [Vec, Vec] | null = null
        for (const t of [0.5, 0.25, 0.75, 0]) {
          const v = uv[1][0] + (uv[1][1] - uv[1][0]) * t
          const [p0, p1, p2] = [at(0, v), at(Math.PI / 2, v), at(Math.PI, v)]
          const center = scale(add(p0, p2), 0.5)
          const normal = cross(sub(p0, center), sub(p1, center))
          if (len(normal) > 1e-18 * Math.max(1, len(center)) ** 2) {
            axis = [center, add(center, unit(normal))]
            break
          }
        }
        if (!axis) throw new Error('No axis')
        const [v0, v1] = uv[1]
        let curve: OnCurve
        if (type === S.GeomAbs_Cylinder || type === S.GeomAbs_Cone) {
          curve = { kind: 'nurbs', dim: 3, degree: 1, knots: [v0, v1], points: [at(0, v0), at(0, v1)] }
        } else {
          // A circle whose parameter is the angle v.
          const [top, bottom] = [at(0, Math.PI / 2), at(0, -Math.PI / 2)]
          const center = scale(add(top, bottom), 0.5)
          const x = sub(at(0, 0), center)
          curve = { kind: 'arc', center, xaxis: unit(x), yaxis: unit(sub(top, center)), radius: len(x), angles: [v0, v1] }
        }
        return { kind: 'revolution', axis, angles: [u0, u1], curve, box: sampledBox(at, uv) }
      }
      case S.GeomAbs_SurfaceOfRevolution: {
        const [u0, u1] = uv[0]
        if (u1 - u0 > 2 * Math.PI + 1e-9) throw new Error('Face turns more than once')
        const ax = adaptor.AxeOfRevolution()
        const origin = xyz(ax.Location())
        const axis: [Vec, Vec] = [origin, add(origin, xyz(ax.Direction()))]
        const basis = adaptor.BasisCurve()
        const curve = sameParameterCurve(basis, uv[1][0], uv[1][1])
        return { kind: 'revolution', axis, angles: [u0, u1], curve, box: sampledBox(at, [uv[0], curveDomain(curve)]) }
      }
      case S.GeomAbs_SurfaceOfExtrusion: {
        const basis = adaptor.BasisCurve()
        const profile = sameParameterCurve(basis, uv[0][0], uv[0][1])
        const [v0, v1] = uv[1]
        const d = xyz(adaptor.Direction())
        const line: OnCurve = { kind: 'nurbs', dim: 3, degree: 1, knots: [v0, v1], points: [scale(d, v0), scale(d, v1)] }
        return { kind: 'sum', curves: [profile, line], box: sampledBox(at, [curveDomain(profile), uv[1]]) }
      }
      case S.GeomAbs_BSplineSurface:
      case S.GeomAbs_BezierSurface: {
        let bs = type === S.GeomAbs_BSplineSurface ? adaptor.BSpline() : k.GeomConvert.SurfaceToBSplineSurface(surface)
        if (bs.IsUPeriodic() || bs.IsVPeriodic()) {
          bs = new k.Geom_BSplineSurface(bs)
          if (bs.IsUPeriodic()) bs.SetUNotPeriodic()
          if (bs.IsVPeriodic()) bs.SetVNotPeriodic()
        }
        const [nu, nv] = [bs.NbUPoles(), bs.NbVPoles()]
        const points: Vec[][] = []
        const weights: number[][] = []
        let rational = false
        for (let i = 1; i <= nu; i++) {
          const row: Vec[] = []
          const wrow: number[] = []
          for (let j = 1; j <= nv; j++) {
            const p = bs.Pole(i, j)
            row.push(xyz(p))
            p.delete()
            const w = bs.Weight(i, j)
            if (Math.abs(w - 1) > 1e-14) rational = true
            wrow.push(w)
          }
          points.push(row)
          weights.push(wrow)
        }
        return {
          kind: 'nurbs',
          degreeU: bs.UDegree(),
          degreeV: bs.VDegree(),
          knotsU: onKnots(
            bs.NbUKnots(),
            (i) => bs.UKnot(i),
            (i) => bs.UMultiplicity(i),
          ),
          knotsV: onKnots(
            bs.NbVKnots(),
            (i) => bs.VKnot(i),
            (i) => bs.VMultiplicity(i),
          ),
          points,
          ...(rational ? { weights } : {}),
        }
      }
      default:
        throw new Error(`No exact surface for ${type}`)
    }
  } finally {
    adaptor.delete()
  }
}

const start = (c: OnCurve) => (c.kind === 'nurbs' ? c.points[0] : [])
const end = (c: OnCurve) => (c.kind === 'nurbs' ? c.points[c.points.length - 1] : [])
const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** A wire's trims in running order: each starting where the one before ends. */
function chain<T extends { curve: OnCurve }>(trims: T[]): T[] {
  const left = [...trims]
  const out = [left.shift()!]
  while (left.length > 0) {
    const tail = end(out[out.length - 1].curve)
    let best = 0
    for (let i = 1; i < left.length; i++) if (gap(start(left[i].curve), tail) < gap(start(left[best].curve), tail)) best = i
    out.push(left.splice(best, 1)[0])
  }
  return out
}

/** Describes a shape as an openNURBS polysurface. */
export function brepFromShape(shape: Shape): OnBrep {
  const k = oc()
  const vertexMap = new ShapeIndex()
  const edgeMap = new ShapeIndex()
  const brep: OnBrep = {
    curves2d: [],
    curves3d: [],
    surfaces: [],
    vertices: [],
    edges: [],
    trims: [],
    loops: [],
    faces: [],
    box: [
      [0, 0, 0],
      [0, 0, 0],
    ],
  }
  for (const v of explore(shape, 'VERTEX')) {
    if (vertexMap.find(v) >= 0) continue
    vertexMap.add(v)
    const vertex = k.TopoDS.Vertex(v)
    const p = k.BRep_Tool.Pnt(vertex)
    brep.vertices.push({ point: xyz(p), edges: [], tolerance: k.BRep_Tool.Tolerance(vertex) })
    p.delete()
  }
  const vertexIndex = (v: Shape) => vertexMap.find(v)

  // Edges with their 3D curves; degenerate ones (the poles of a sphere) have none.
  const edgeIndex = new Map<number, number>()
  for (const e of explore(shape, 'EDGE')) {
    if (edgeMap.find(e) >= 0) continue
    const mapIndex = edgeMap.add(e)
    const edge = k.TopoDS.Edge(e)
    if (k.BRep_Tool.Degenerated(edge)) continue
    const { returnValue: curve, First, Last } = k.BRep_Tool.Curve(edge, 0, 0)
    const forward = edge.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD)
    const ends = explore(forward, 'VERTEX')
    const first = ends.find((v) => v.Orientation() === k.TopAbs_Orientation.TopAbs_FORWARD) ?? ends[0]
    const last = ends.find((v) => v.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) ?? ends[ends.length - 1]
    const index = brep.edges.length
    edgeIndex.set(mapIndex, index)
    brep.curves3d.push(curve3d(curve, First, Last))
    const vertices: [number, number] = [vertexIndex(first), vertexIndex(last)]
    brep.edges.push({ curve: index, vertices, trims: [], tolerance: k.BRep_Tool.Tolerance(edge) })
    for (const vi of vertices) brep.vertices[vi].edges.push(index)
  }

  for (const f of explore(shape, 'FACE')) {
    // Loops run in the surface's own parameters; a face turned over only flips its normal.
    const face = k.TopoDS.Face(f.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD))
    const fi = brep.faces.length
    const outer = k.BRepTools.OuterWire(face)
    const loops: { outer: boolean; trims: { curve: OnCurve; edge: number; vertices: [number, number]; reversed: boolean; seam: boolean }[] }[] = []
    for (const w of explore(face, 'WIRE')) {
      const trims = []
      for (const e of explore(w, 'EDGE')) {
        const edge = k.TopoDS.Edge(e)
        const backwards = reversed(e)
        const pcurve = new k.BRepAdaptor_Curve2d(edge, face)
        const curve = curve2d(pcurve.Curve(), pcurve.FirstParameter(), pcurve.LastParameter(), backwards)
        pcurve.delete()
        const ei = edgeIndex.get(edgeMap.find(e)) ?? -1
        let vertices: [number, number]
        if (ei < 0) {
          const v = vertexIndex(explore(e, 'VERTEX')[0])
          vertices = [v, v]
        } else {
          const ev = brep.edges[ei].vertices
          vertices = backwards ? [ev[1], ev[0]] : [ev[0], ev[1]]
        }
        trims.push({ curve, edge: ei, vertices, reversed: backwards, seam: false })
      }
      if (trims.length > 0) loops.push({ outer: w.IsSame(outer), trims: chain(trims) })
    }
    // A seam is an edge the face meets on both sides, both in one loop.
    for (const loop of loops) {
      for (const t of loop.trims) t.seam = t.edge >= 0 && loop.trims.filter((o) => o.edge === t.edge).length === 2
    }
    loops.sort((a, b) => Number(b.outer) - Number(a.outer))
    if (loops.length > 0) loops[0].outer = true

    // The trims meet exactly, as openNURBS requires.
    for (const loop of loops) {
      loop.trims.forEach((t, i) => {
        const next = loop.trims[(i + 1) % loop.trims.length]
        const [a, b] = [end(t.curve), start(next.curve)]
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        a.splice(0, 2, ...mid)
        b.splice(0, 2, ...mid)
      })
    }

    const bounds = k.BRepTools.UVBounds(face)
    const uv: Domain = [
      [bounds.UMin, bounds.UMax],
      [bounds.VMin, bounds.VMax],
    ]
    const surface = surfaceOf(face, uv)
    const domain = surfaceDomain(surface)
    brep.surfaces.push(surface)
    const face_ = { loops: [] as number[], surface: fi, reversed: reversed(f) }
    for (const loop of loops) {
      const li = brep.loops.length
      const ti0 = brep.trims.length
      for (const t of loop.trims) {
        const ti = brep.trims.length
        brep.curves2d.push(t.curve)
        const iso = isoFlag(t.curve, domain)
        brep.trims.push({
          curve: ti,
          edge: t.edge,
          vertices: t.vertices,
          reversed: t.reversed,
          type: t.edge < 0 ? TRIM.singular : t.seam ? TRIM.seam : TRIM.boundary,
          iso,
          loop: li,
        })
        if (t.edge >= 0) brep.edges[t.edge].trims.push(ti)
      }
      brep.loops.push({ trims: Array.from({ length: loop.trims.length }, (_, i) => ti0 + i), outer: loop.outer, face: fi })
      face_.loops.push(li)
    }
    brep.faces.push(face_)
  }

  // Edges shared by two faces join them.
  for (const t of brep.trims) if (t.type === TRIM.boundary && brep.edges[t.edge].trims.length > 1) t.type = TRIM.mated
  for (const t of brep.trims)
    if ((t.type === TRIM.singular || t.type === TRIM.seam) && t.iso === ISO.none) throw new Error('Seam or pole off the side of its surface')

  const box = new k.Bnd_Box()
  k.BRepBndLib.Add(shape, box, false)
  brep.box = [xyz(box.CornerMin()), xyz(box.CornerMax())]
  box.delete()
  return brep
}

/** The openNURBS bytes of a surface or solid, or null if some face has no exact counterpart. */
export function exactRhinoBrep(g: BrepGeometry): Uint8Array | null {
  try {
    return writeBrep(brepFromShape(shapeOf(g).wrapped))
  } catch (error) {
    console.warn('Written as a mesh:', error)
    return null
  }
}
