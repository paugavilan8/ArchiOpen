import { Vector3 } from 'three'
import * as R from 'replicad'
import { pointMap, type Deformation } from '../core/deformations'

/**
 * Deforming surfaces and solids: each face's surface and each edge's curve made a NURBS (B-spline)
 * and their control points moved by a mapping, then the faces sewn back together. For an affine
 * mapping (a scale along one or two axes, a shear) this is exact, as NURBS follow their control
 * points under those. For others (twist, taper, bend, flow) the shapes are refined first, so the
 * moved control points follow the mapping closely.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()

export type PointMap = (p: Vector3) => Vector3

export interface DeformOptions {
  /** Knots added in each direction of each surface and along each edge (0 for an affine mapping). */
  refine?: number
}

const xyz = (p: { X(): number; Y(): number; Z(): number }) => new Vector3(p.X(), p.Y(), p.Z())

/** The values of the `count` cubic B-spline basis functions, clamped and uniform over [lo, hi], at t. */
function basis(count: number, lo: number, hi: number, t: number): number[] {
  const p = 3
  const spans = count - p
  const knots = [...Array(p).fill(lo), ...Array.from({ length: spans + 1 }, (_, i) => lo + ((hi - lo) * i) / spans), ...Array(p).fill(hi)]
  // Cox-de Boor, from degree 0 up.
  let n: number[] = knots.slice(0, -1).map((k0, i) => (t >= k0 && t < knots[i + 1]) || (t === hi && k0 < hi && knots[i + 1] === hi) ? 1 : 0)
  for (let d = 1; d <= p; d++)
    n = n.slice(0, -1).map((_, i) => {
      const a = knots[i + d] - knots[i] > 0 ? ((t - knots[i]) / (knots[i + d] - knots[i])) * n[i] : 0
      const b = knots[i + d + 1] - knots[i + 1] > 0 ? ((knots[i + d + 1] - t) / (knots[i + d + 1] - knots[i + 1])) * n[i + 1] : 0
      return a + b
    })
  return n
}

/** Solves A x = b in place (Gaussian elimination with pivoting) for several right-hand sides. */
export function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length
  const a = A.map((r) => [...r])
  const b = B.map((r) => [...r])
  for (let c = 0; c < n; c++) {
    let best = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[best][c])) best = r
    ;[a[c], a[best]] = [a[best], a[c]]
    ;[b[c], b[best]] = [b[best], b[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      if (f === 0) continue
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k]
      for (let k = 0; k < b[r].length; k++) b[r][k] -= f * b[c][k]
    }
  }
  return b.map((row, r) => row.map((x) => x / a[r][r]))
}

/** The least-squares projector of a clamped uniform cubic B-spline of `count` poles over samples at `params`. */
function fitter(count: number, lo: number, hi: number, params: number[]): number[][] {
  const A = params.map((t) => basis(count, lo, hi, t))
  const AtA = Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => A.reduce((s, row) => s + row[i] * row[j], 0)))
  const At = Array.from({ length: count }, (_, i) => A.map((row) => row[i]))
  return solve(AtA, At)
}

const S = () => oc().GeomAbs_SurfaceType

/** True for the surfaces surfaceOf turns into B-splines exactly (planes and B-splines). */
export function exactlyBSpline(face: ReturnType<ReturnType<typeof oc>['TopoDS']['Face']>): boolean {
  const adaptor = new (oc().BRepAdaptor_Surface)(face, false)
  const type = adaptor.GetType()
  adaptor.delete()
  return ([S().GeomAbs_Plane, S().GeomAbs_BSplineSurface, S().GeomAbs_BezierSurface] as string[]).includes(type)
}

/**
 * A B-spline surface close to a face's surface over the face's range, in the same parameters (so
 * the face's curves on it stay where they were), exact where it can be.
 */
export function surfaceOf(face: ReturnType<ReturnType<typeof oc>['TopoDS']['Face']>, refine: number, range?: { UMin: number; UMax: number; VMin: number; VMax: number }) {
  const k = oc()
  const b = range ?? k.BRepTools.UVBounds(face)
  const adaptor = new k.BRepAdaptor_Surface(face, false)
  const type = adaptor.GetType()
  const array1 = (values: number[], int = false) => {
    const a = int ? new k.NCollection_Array1_int(1, values.length) : new k.NCollection_Array1_double(1, values.length)
    values.forEach((v, i) => a.SetValue(i + 1, v))
    return a
  }
  let bs
  if (type === S().GeomAbs_Plane) {
    // A plane is its four corners, bilinear.
    const poles = new k.NCollection_Array2_gp_Pnt(1, 2, 1, 2)
    for (const [i, u] of [
      [1, b.UMin],
      [2, b.UMax],
    ])
      for (const [j, v] of [
        [1, b.VMin],
        [2, b.VMax],
      ]) {
        const p = adaptor.Value(u, v)
        poles.SetValue(i, j, p)
        p.delete()
      }
    bs = new k.Geom_BSplineSurface(poles, array1([b.UMin, b.UMax]) as never, array1([b.VMin, b.VMax]) as never, array1([2, 2], true) as never, array1([2, 2], true) as never, 1, 1, false, false)
  } else if (type === S().GeomAbs_BSplineSurface || type === S().GeomAbs_BezierSurface) {
    bs = new k.Geom_BSplineSurface(k.GeomConvert.SurfaceToBSplineSurface(k.BRep_Tool.Surface(face)))
    if (bs.IsUPeriodic()) bs.SetUNotPeriodic()
    if (bs.IsVPeriodic()) bs.SetVNotPeriodic()
    bs.Segment(b.UMin, b.UMax, b.VMin, b.VMax, 1e-9, 1e-9)
  } else {
    // Cylinders, cones, spheres, ...: a least-squares cubic over a grid of their points.
    const count = 16 + 2 * refine
    const samples = 3 * count
    const along = (lo: number, hi: number) => Array.from({ length: samples }, (_, i) => lo + ((hi - lo) * i) / (samples - 1))
    const [us, vs] = [along(b.UMin, b.UMax), along(b.VMin, b.VMax)]
    const [Fu, Fv] = [fitter(count, b.UMin, b.UMax, us), fitter(count, b.VMin, b.VMax, vs)]
    const grid = us.map((u) =>
      vs.map((v) => {
        const p = adaptor.Value(u, v)
        const out = [p.X(), p.Y(), p.Z()]
        p.delete()
        return out
      }),
    )
    // Poles = Fu * grid * Fv^T, for each coordinate.
    const half = grid.map((row) => Fv.map((f) => [0, 1, 2].map((c) => f.reduce((s, w, j) => s + w * row[j][c], 0))))
    const poles = new k.NCollection_Array2_gp_Pnt(1, count, 1, count)
    for (let i = 0; i < count; i++)
      for (let j = 0; j < count; j++) {
        const q = [0, 1, 2].map((c) => Fu[i].reduce((s, w, r) => s + w * half[r][j][c], 0))
        const p = new k.gp_Pnt(q[0], q[1], q[2])
        poles.SetValue(i + 1, j + 1, p)
        p.delete()
      }
    const spans = count - 3
    const knots = (lo: number, hi: number) => array1(Array.from({ length: spans + 1 }, (_, i) => lo + ((hi - lo) * i) / spans))
    const mults = array1([4, ...Array(spans - 1).fill(1), 4], true)
    bs = new k.Geom_BSplineSurface(poles, knots(b.UMin, b.UMax) as never, knots(b.VMin, b.VMax) as never, mults as never, mults as never, 3, 3, false, false)
  }
  adaptor.delete()
  if (refine > 0 && (type === S().GeomAbs_Plane || type === S().GeomAbs_BSplineSurface || type === S().GeomAbs_BezierSurface)) {
    if (bs.UDegree() < 3 || bs.VDegree() < 3) bs.IncreaseDegree(Math.max(3, bs.UDegree()), Math.max(3, bs.VDegree()))
    for (let i = 1; i <= refine; i++) {
      bs.InsertUKnot(b.UMin + ((b.UMax - b.UMin) * i) / (refine + 1), 1, 1e-9, true)
      bs.InsertVKnot(b.VMin + ((b.VMax - b.VMin) * i) / (refine + 1), 1, 1e-9, true)
    }
  }
  return bs
}

/** The p + 1 basis functions non-zero on span `i` of a knot vector, at t (also past the span's ends). */
export function basisOn(knots: number[], p: number, i: number, t: number): number[] {
  const N = [1]
  const left: number[] = []
  const right: number[] = []
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[i + 1 - j]
    right[j] = knots[i + j] - t
    let saved = 0
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r])
      N[r] = saved + right[r + 1] * temp
      saved = left[j - r] * temp
    }
    N[j] = saved
  }
  return N
}

/** The span a parameter is in, the last one for anything past the end. */
export function spanOf(knots: number[], p: number, n: number, t: number): number {
  if (t >= knots[n]) return n - 1
  let i = p
  while (i < n - 1 && t >= knots[i + 1]) i++
  return i
}

/** A B-spline surface's knots, each repeated by its multiplicity. */
function flatKnots(count: number, knot: (i: number) => number, mult: (i: number) => number): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i++) for (let m = 0; m < mult(i); m++) out.push(knot(i))
  return out
}

/** The least-squares projector onto B-splines with these knots, from samples at `params`. */
function projector(knots: number[], p: number, n: number, params: number[]): number[][] {
  const A = params.map((t) => {
    const row = new Array<number>(n).fill(0)
    const i = spanOf(knots, p, n, t)
    basisOn(knots, p, i, t).forEach((b, r) => (row[i - p + r] = b))
    return row
  })
  const AtA = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => A.reduce((s, r) => s + r[a] * r[b], 0)))
  const At = Array.from({ length: n }, (_, a) => A.map((r) => r[a]))
  return solve(AtA, At)
}

/**
 * A (non-rational) B-spline surface fitted, with its own knots, to its own points moved by a
 * mapping: much closer to the deformed surface than moving its control points.
 */
function fitMapped(bs: { NbUPoles(): number; NbVPoles(): number; UDegree(): number; VDegree(): number; NbUKnots(): number; NbVKnots(): number; UKnot(i: number): number; VKnot(i: number): number; UMultiplicity(i: number): number; VMultiplicity(i: number): number; Value(u: number, v: number): { X(): number; Y(): number; Z(): number; delete(): void }; SetPole(i: number, j: number, p: unknown): void }, map: PointMap): void {
  const k = oc()
  const [nu, nv, p, q] = [bs.NbUPoles(), bs.NbVPoles(), bs.UDegree(), bs.VDegree()]
  const U = flatKnots(bs.NbUKnots(), (i) => bs.UKnot(i), (i) => bs.UMultiplicity(i))
  const V = flatKnots(bs.NbVKnots(), (i) => bs.VKnot(i), (i) => bs.VMultiplicity(i))
  const params = (K: number[], n: number) => Array.from({ length: 3 * n }, (_, i) => K[0] + ((K[K.length - 1] - K[0]) * i) / (3 * n - 1))
  const [us, vs] = [params(U, nu), params(V, nv)]
  const [Fu, Fv] = [projector(U, p, nu, us), projector(V, q, nv, vs)]
  const grid = us.map((u) =>
    vs.map((v) => {
      const pt = bs.Value(u, v)
      const m = map(xyz(pt))
      pt.delete()
      return [m.x, m.y, m.z]
    }),
  )
  const half = grid.map((row) => Fv.map((f) => [0, 1, 2].map((c) => f.reduce((s, w, j) => s + w * row[j][c], 0))))
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const x = [0, 1, 2].map((c) => Fu[i].reduce((s, w, r) => s + w * half[r][j][c], 0))
      const g = new k.gp_Pnt(x[0], x[1], x[2])
      bs.SetPole(i + 1, j + 1, g)
      g.delete()
    }
}

/** Moves a B-spline surface's or curve's control points. */
function mapPoles(bs: { NbPoles?: () => number; Pole: (...a: number[]) => unknown; SetPole: (...a: unknown[]) => void; NbUPoles?: () => number; NbVPoles?: () => number }, map: PointMap): void {
  const k = oc()
  const move = (pole: { X(): number; Y(): number; Z(): number; delete(): void }) => {
    const q = map(xyz(pole))
    pole.delete()
    return new k.gp_Pnt(q.x, q.y, q.z)
  }
  if (bs.NbUPoles && bs.NbVPoles) {
    for (let i = 1; i <= bs.NbUPoles(); i++)
      for (let j = 1; j <= bs.NbVPoles(); j++) {
        const p = move(bs.Pole(i, j) as never)
        bs.SetPole(i, j, p)
        p.delete()
      }
  } else {
    for (let i = 1; i <= bs.NbPoles!(); i++) {
      const p = move(bs.Pole(i) as never)
      bs.SetPole(i, p)
      p.delete()
    }
  }
}

/** Deforms a shape (surfaces, polysurfaces and solids) by a mapping of points. */
export function deformShape(shape: AnyShape, map: PointMap, options: DeformOptions = {}): AnyShape {
  const k = oc()
  const refine = options.refine ?? 0
  const box = shape.boundingBox
  const size = Math.max(Math.hypot(box.width, box.height, box.depth), 1e-6)
  const tolerance = size * 1e-5

  // Each face on its moved surface, bounded by its own curves on its surface (the surface keeps
  // its parameters), then all sewn together again.
  // Each vertex once, moved, so the faces' edges meet.
  const vertices: { from: ReturnType<typeof k.TopoDS.Vertex>; to: ReturnType<typeof k.TopoDS.Vertex> }[] = []
  const vertexFor = (v: ReturnType<typeof k.TopoDS.Vertex>) => {
    const known = vertices.find((x) => x.from.IsSame(v))
    if (known) return known.to
    const p = k.BRep_Tool.Pnt(v)
    const q = map(xyz(p))
    p.delete()
    const g = new k.gp_Pnt(q.x, q.y, q.z)
    const made = new k.BRepBuilderAPI_MakeVertex(g)
    const to = made.Vertex()
    made.delete()
    g.delete()
    vertices.push({ from: v, to })
    return to
  }
  /** An edge's first and last vertices, along it. */
  const endsOf = (e: ReturnType<typeof k.TopoDS.Edge>) => {
    const forward = e.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD)
    const ex = new k.TopExp_Explorer(forward, k.TopAbs_ShapeEnum.TopAbs_VERTEX, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
    let first: ReturnType<typeof k.TopoDS.Vertex> | null = null
    let last: ReturnType<typeof k.TopoDS.Vertex> | null = null
    for (; ex.More(); ex.Next()) {
      const v = k.TopoDS.Vertex(ex.Current())
      if (v.Orientation() === k.TopAbs_Orientation.TopAbs_FORWARD) first = v
      else if (v.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) last = v
    }
    ex.delete()
    return first && last ? [first, last] : null
  }

  const faces: unknown[] = []
  for (const face of shape.faces) {
    const original = k.TopoDS.Face(face.wrapped)
    // Its wires as on its surface (a reversed face's edges come reversed), turned back at the end.
    const f = k.TopoDS.Face(original.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD))
    const surface = surfaceOf(f, refine)
    // Exact for an affine mapping; otherwise fitted to the moved surface.
    if (refine > 0 && !surface.IsURational() && !surface.IsVRational()) fitMapped(surface as never, map)
    else mapPoles(surface as never, map)
    const outer = k.BRepTools.OuterWire(f)
    const built: { wire: unknown; outer: boolean }[] = []
    const wires = new k.TopExp_Explorer(f, k.TopAbs_ShapeEnum.TopAbs_WIRE, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
    for (; wires.More(); wires.Next()) {
      const wire = k.TopoDS.Wire(wires.Current())
      // The edges in any order: the wire puts them end to end.
      const list = new k.NCollection_List_TopoDS_Shape()
      const ex = new k.TopExp_Explorer(wire, k.TopAbs_ShapeEnum.TopAbs_EDGE, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
      for (; ex.More(); ex.Next()) {
        const e = k.TopoDS.Edge(ex.Current())
        const on = new k.BRepAdaptor_Curve2d(e, f)
        const [t0, t1] = [on.FirstParameter(), on.LastParameter()]
        const ends = endsOf(e)
        let edgeMaker = ends ? new k.BRepBuilderAPI_MakeEdge(on.Curve(), surface, vertexFor(ends[0]), vertexFor(ends[1]), t0, t1) : null
        if (!edgeMaker?.IsDone()) {
          edgeMaker?.delete()
          edgeMaker = new k.BRepBuilderAPI_MakeEdge(on.Curve(), surface, t0, t1)
        }
        on.delete()
        if (!edgeMaker.IsDone()) {
          edgeMaker.delete()
          continue
        }
        let edge = edgeMaker.Edge()
        edgeMaker.delete()
        k.BRepLib.BuildCurves3d(edge, 1e-7, k.GeomAbs_Shape.GeomAbs_C1, 14, 64)
        if (e.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) edge = k.TopoDS.Edge(edge.Reversed())
        list.Append(edge)
      }
      ex.delete()
      const make = new k.BRepBuilderAPI_MakeWire()
      make.Add(list)
      list.delete()
      if (make.IsDone()) built.push({ wire: make.Wire(), outer: wire.IsSame(outer) })
      make.delete()
    }
    wires.delete()
    let maker: InstanceType<typeof k.BRepBuilderAPI_MakeFace> | null = null
    for (const w of [...built.filter((b) => b.outer), ...built.filter((b) => !b.outer)]) {
      if (!maker) maker = new k.BRepBuilderAPI_MakeFace(surface, w.wire as never, true)
      else maker.Add(w.wire as never)
    }
    if (!maker || !maker.IsDone()) throw new Error('A face could not be deformed')
    const fix = new k.ShapeFix_Face(k.TopoDS.Face(maker.Face()))
    fix.Perform()
    let made = fix.Face()
    if (original.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) made = k.TopoDS.Face(made.Reversed())
    faces.push(made)
    fix.delete()
    maker.delete()
  }

  const sewing = new k.BRepBuilderAPI_Sewing(tolerance * 10, true, true, true, false)
  for (const f of faces) sewing.Add(f as never)
  sewing.Perform()
  let result = sewing.SewedShape()
  sewing.delete()
  // A solid stays a solid.
  if (((shape as R.Shape3D).solids?.length ?? 0) > 0) {
    const shells: unknown[] = []
    const ex = new k.TopExp_Explorer(result, k.TopAbs_ShapeEnum.TopAbs_SHELL, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
    for (; ex.More(); ex.Next()) shells.push(k.TopoDS.Shell(ex.Current()))
    ex.delete()
    if (shells.length > 0) {
      const solid = new k.BRepBuilderAPI_MakeSolid()
      for (const s of shells) solid.Add(s as never)
      if (solid.IsDone()) {
        const fixer = new k.ShapeFix_Solid(solid.Solid())
        fixer.Perform()
        result = fixer.Solid()
        fixer.delete()
      }
      solid.delete()
    }
  }
  return R.cast(result)
}

/** A surface or solid deformed by Twist, Taper, Bend or Flow: refined so it follows closely. */
export function deformBy(shape: AnyShape, deformation: Deformation): AnyShape {
  return deformShape(shape, pointMap(deformation), { refine: 6 })
}
