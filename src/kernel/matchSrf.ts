import { Vector3 } from 'three'
import * as R from 'replicad'
import { basisAt, solve } from '../math/nurbs'
import { joinShapes } from './brep'
import { closestOn } from './surfaceEdit'

/**
 * MatchSrf: changes a surface near one of its edges so that it meets an edge of another surface,
 * with continuity of position, tangency or curvature. The surface is taken as a NURBS surface over
 * its face's range; the rows of control points at the edge (one, two or three of them) are moved:
 * - the first so that the edge runs along the target edge;
 * - the second so that the surface leaves the edge in the target's tangent plane, going on from it;
 * - the third so that its curvature across the edge is the target's.
 * The rest of the surface is kept; knots are added near the edge first so that the change stays
 * close to it.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()
const xyz = (p: { X(): number; Y(): number; Z(): number }) => new Vector3(p.X(), p.Y(), p.Z())

export type Continuity = 'position' | 'tangency' | 'curvature'
const ORDER: Record<Continuity, number> = { position: 0, tangency: 1, curvature: 2 }

/** The knot vector of a B-spline surface direction, each knot repeated by its multiplicity. */
function flatKnots(count: number, knot: (i: number) => number, mult: (i: number) => number): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i++) for (let m = 0; m < mult(i); m++) out.push(knot(i))
  return out
}

/**
 * Matches face `faceA` of `a` (at its edge nearest `pickA`) to edge `edgeB` of `b`. Returns `a`
 * with that face changed (and its other faces joined back to it).
 */
export function matchSurface(a: AnyShape, faceA: number, pickA: Vector3, b: AnyShape, edgeB: number, continuity: Continuity): AnyShape {
  const k = oc()
  const face = a.faces[faceA]
  const edge = b.edges[edgeB]
  if (!face || !edge) throw new Error('There is no such face or edge')
  const order = ORDER[continuity]
  const f = k.TopoDS.Face(face.wrapped)
  const bounds = k.BRepTools.UVBounds(f)

  // The face's surface as a B-spline over the face's range.
  const bs = bsplineOf(f, bounds)
  // Its own parameter range (a fitted surface has its own).
  const range = { UMin: bs.UKnot(1), UMax: bs.UKnot(bs.NbUKnots()), VMin: bs.VKnot(1), VMax: bs.VKnot(bs.NbVKnots()) }

  // Which of its four sides to change: the one nearest the pick.
  const sides = [
    { swap: false, reverse: false },
    { swap: false, reverse: true },
    { swap: true, reverse: false },
    { swap: true, reverse: true },
  ]
  const sideDistance = (swap: boolean, reverse: boolean) => {
    let best = Infinity
    for (let i = 0; i <= 24; i++) {
      const s = i / 24
      const u = reverse ? range.UMax : range.UMin
      const v = reverse ? range.VMax : range.VMin
      const p = swap ? bs.Value(range.UMin + (range.UMax - range.UMin) * s, v) : bs.Value(u, range.VMin + (range.VMax - range.VMin) * s)
      best = Math.min(best, xyz(p).distanceTo(pickA))
      p.delete()
    }
    return best
  }
  const side = sides.reduce((best, s) => (sideDistance(s.swap, s.reverse) < sideDistance(best.swap, best.reverse) ? s : best))
  // Turned so that the side to change is the first row of control points (u at its start).
  if (side.swap) bs.ExchangeUV()
  if (side.reverse) bs.UReverse()

  // Enough degree and control points: across the edge for the rows to move (with knots near the
  // edge so the change stays there), and along it to follow the target edge.
  const degreeU = Math.max(bs.UDegree(), order + 1, 3)
  const degreeV = Math.max(bs.VDegree(), 3)
  if (degreeU > bs.UDegree() || degreeV > bs.VDegree()) bs.IncreaseDegree(degreeU, degreeV)
  const [u0, u1] = [bs.UKnot(1), bs.UKnot(bs.NbUKnots())]
  for (const s of [0.1, 0.25, 0.5]) bs.InsertUKnot(u0 + (u1 - u0) * s, 1, 1e-9, true)
  const [v0, v1] = [bs.VKnot(1), bs.VKnot(bs.NbVKnots())]
  for (let i = 1; i < 12; i++) bs.InsertVKnot(v0 + ((v1 - v0) * i) / 12, 1, 1e-9, true)

  const nu = bs.NbUPoles()
  const nv = bs.NbVPoles()
  const p = bs.UDegree()
  const q = bs.VDegree()
  const U = flatKnots(
    bs.NbUKnots(),
    (i) => bs.UKnot(i),
    (i) => bs.UMultiplicity(i),
  )
  const V = flatKnots(
    bs.NbVKnots(),
    (i) => bs.VKnot(i),
    (i) => bs.VMultiplicity(i),
  )
  const pole = (i: number, j: number) => {
    const g = bs.Pole(i + 1, j + 1)
    const out = xyz(g)
    g.delete()
    return out
  }
  const rows = [0, 1, 2].map((i) => Array.from({ length: nv }, (_, j) => pole(i, j)))
  if (nu < order + 2) throw new Error('The surface is too small to match')

  // The target edge, run the same way as the side.
  const curve = new k.BRepAdaptor_Curve(edge.wrapped)
  const [s0, s1] = [curve.FirstParameter(), curve.LastParameter()]
  const at = (s: number) => {
    const g = curve.Value(s)
    const out = xyz(g)
    g.delete()
    return out
  }
  const flipped = rows[0][0].distanceTo(at(s0)) + rows[0][nv - 1].distanceTo(at(s1)) > rows[0][0].distanceTo(at(s1)) + rows[0][nv - 1].distanceTo(at(s0))
  const target = (v: number) => {
    const t = (v - v0) / (v1 - v0)
    return at(flipped ? s1 + (s0 - s1) * t : s0 + (s1 - s0) * t)
  }

  // The first row: the edge through the target at the control points' Greville parameters.
  const greville = Array.from({ length: nv }, (_, j) => V.slice(j + 1, j + q + 1).reduce((x, y) => x + y, 0) / q)
  const targets = greville.map(target)
  const N = greville.map((v) => basisAt(nv, q, V, v))
  const row0 = solve(
    N,
    targets.map((t) => [t.x, t.y, t.z]),
  ).map(([x, y, z]) => new Vector3(x, y, z))

  const updated = [row0]
  if (order >= 1) {
    const box = face.boundingBox
    const size = Math.max(Math.hypot(box.width, box.height, box.depth), 1e-6)
    const row1: Vector3[] = []
    const row2: Vector3[] = []
    for (let j = 0; j < nv; j++) {
      const c = targets[j]
      // The target surface's tangent plane there, and the direction leaving it across the edge.
      const n = new Vector3(...(normalOf(b, c) ?? [0, 0, 1])).normalize()
      const along = target(Math.min(greville[j] + (v1 - v0) * 1e-4, v1)).sub(target(Math.max(greville[j] - (v1 - v0) * 1e-4, v0)))
      const out = n.clone().cross(along).normalize()
      const h = size * 1e-3
      // Going back against `out` must lead onto the target surface.
      if ((closestOn(b, c.clone().addScaledVector(out, -h))?.distance ?? Infinity) > (closestOn(b, c.clone().addScaledVector(out, h))?.distance ?? Infinity)) out.negate()
      const length = Math.max(rows[1][j].distanceTo(rows[0][j]), 1e-9)
      const p1 = row0[j].clone().addScaledVector(out, length)
      row1.push(p1)
      if (order >= 2) {
        // The target's normal curvature across the edge, from a nearby point on it.
        const step = Math.min(length, size * 0.05)
        const back = closestOn(b, c.clone().addScaledVector(out, -step))!.point
        const curvature = (2 * n.dot(back.clone().sub(c))) / (step * step)
        // Derivatives at the edge (u = u0) of a clamped B-spline, from the first three rows.
        const q0 = out.clone().multiplyScalar((p * length) / (U[p + 1] - U[1]))
        const second = n.clone().multiplyScalar(curvature * q0.lengthSq())
        const q1 = q0.clone().addScaledVector(second, (U[p + 1] - U[2]) / (p - 1))
        row2.push(p1.clone().addScaledVector(q1, (U[p + 2] - U[2]) / p))
      }
    }
    updated.push(row1)
    if (order >= 2) updated.push(row2)
  }
  curve.delete()

  updated.forEach((row, i) =>
    row.forEach((pt, j) => {
      const g = new k.gp_Pnt(pt.x, pt.y, pt.z)
      bs.SetPole(i + 1, j + 1, g)
      g.delete()
      // The derivative formulas above hold for the moved rows without weights.
      if (bs.IsURational() || bs.IsVRational()) bs.SetWeight(i + 1, j + 1, 1)
    }),
  )

  // Back to the surface's own parameters, and to a face facing the same way.
  if (side.reverse) bs.UReverse()
  if (side.swap) bs.ExchangeUV()
  const made = new k.BRepBuilderAPI_MakeFace(bs, 1e-7).Face()
  const reversed = f.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED
  const result = R.cast(reversed ? made.Reversed() : made)
  const faces = a.faces
  if (faces.length === 1) return result
  return joinShapes(faces.map((other, i) => (i === faceA ? result : other)))
}

/** The normal of a shape at (the point of it closest to) a point. */
function normalOf(shape: AnyShape, point: Vector3): [number, number, number] | null {
  let best: R.Face | null = null
  let distance = Infinity
  for (const face of shape.faces) {
    const d = closestOn(face, point)?.distance ?? Infinity
    if (d < distance) [best, distance] = [face, d]
  }
  if (!best) return null
  const n = best.normalAt([point.x, point.y, point.z])
  return [n.x, n.y, n.z]
}

/**
 * A face's surface as a B-spline over the face's parameter range: exactly for B-spline and Bézier
 * surfaces; others (planes, cylinders, ...) fitted through a grid of their points.
 */
function bsplineOf(f: ReturnType<ReturnType<typeof oc>['TopoDS']['Face']>, bounds: { UMin: number; UMax: number; VMin: number; VMax: number }) {
  const k = oc()
  const S = k.GeomAbs_SurfaceType
  const adaptor = new k.BRepAdaptor_Surface(f, false)
  const type = adaptor.GetType()
  let bs
  if (type === S.GeomAbs_BSplineSurface || type === S.GeomAbs_BezierSurface) {
    bs = new k.Geom_BSplineSurface(k.GeomConvert.SurfaceToBSplineSurface(k.BRep_Tool.Surface(f)))
    if (bs.IsUPeriodic()) bs.SetUNotPeriodic()
    if (bs.IsVPeriodic()) bs.SetVNotPeriodic()
    bs.Segment(bounds.UMin, bounds.UMax, bounds.VMin, bounds.VMax, 1e-9, 1e-9)
  } else {
    const n = 16
    const grid = new k.NCollection_Array2_gp_Pnt(1, n, 1, n)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const p = adaptor.Value(bounds.UMin + ((bounds.UMax - bounds.UMin) * i) / (n - 1), bounds.VMin + ((bounds.VMax - bounds.VMin) * j) / (n - 1))
        grid.SetValue(i + 1, j + 1, p)
        p.delete()
      }
    const fit = new k.GeomAPI_PointsToBSplineSurface(grid, 3, 8, k.GeomAbs_Shape.GeomAbs_C2, 1e-6)
    bs = new k.Geom_BSplineSurface(fit.Surface())
    fit.delete()
    grid.delete()
  }
  adaptor.delete()
  return bs
}
