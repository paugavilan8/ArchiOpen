import { Vector3 } from 'three'
import * as R from 'replicad'
import { basisOn, exactlyBSpline, solve, spanOf, surfaceOf } from './deform'

/**
 * ExtendSrf: a surface made longer past one of its edges, smoothly. The B-spline's last span runs
 * on past the edge: the surface carries on as it was going (a plane stays a plane, a cylinder bends
 * round as a circle). That span's polynomial is put back into B-spline form with the end knots moved
 * out, exactly, rational surfaces in their weighted (homogeneous) form.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()

/**
 * Rows of homogeneous points (one row for each pole across), each a B-spline in u, run on past the
 * end to `end`. Returns the new rows.
 */
function extendRows(rows: number[][][], knots: number[], p: number, end: number): number[][][] {
  const n = rows[0].length
  const newKnots = [...knots.slice(0, n), ...Array(p + 1).fill(end)]
  const start = knots[p]
  const samples = Array.from({ length: 4 * n + 8 }, (_, i) => start + ((end - start) * i) / (4 * n + 7))
  // Least squares in the longer knot vector: the run-on curve is in its span, so it comes out exact.
  const A = samples.map((t) => {
    const row = new Array<number>(n).fill(0)
    const i = spanOf(newKnots, p, n, t)
    basisOn(newKnots, p, i, t).forEach((b, r) => (row[i - p + r] = b))
    return row
  })
  const AtA = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => A.reduce((s, r) => s + r[a] * r[b], 0)))
  return rows.map((poles) => {
    const values = samples.map((t) => {
      const i = spanOf(knots, p, n, t)
      const out = [0, 0, 0, 0]
      basisOn(knots, p, i, t).forEach((b, r) => poles[i - p + r].forEach((x, c) => (out[c] += b * x)))
      return out
    })
    const Atb = Array.from({ length: n }, (_, a) => [0, 1, 2, 3].map((c) => A.reduce((s, r, k) => s + r[a] * values[k][c], 0)))
    return solve(AtA, Atb)
  })
}

const xyz = (p: { X(): number; Y(): number; Z(): number }) => new Vector3(p.X(), p.Y(), p.Z())

/** Extends a single surface by `length` past the edge nearest `pick`. */
export function extendSurface(shape: AnyShape, pick: Vector3, length: number): AnyShape {
  const k = oc()
  if (shape.faces.length !== 1) throw new Error('ExtendSrf works on single surfaces (use ExtractSrf first)')
  if (length <= 0) throw new Error('The length must be more than zero')
  const face = k.TopoDS.Face(shape.faces[0].wrapped)
  const forward = k.TopoDS.Face(face.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD))
  const bs = surfaceOf(forward, 0)
  // A trimmed surface would lose its trims.
  const natural = R.measureArea(R.cast(new k.BRepBuilderAPI_MakeFace(bs, 1e-7).Face()) as never)
  const area = R.measureArea(shape.faces[0])
  if (Math.abs(natural - area) > 1e-6 * Math.max(natural, 1)) throw new Error('ExtendSrf extends untrimmed surfaces only')

  const range = () => ({ u0: bs.UKnot(1), u1: bs.UKnot(bs.NbUKnots()), v0: bs.VKnot(1), v1: bs.VKnot(bs.NbVKnots()) })
  // Which side: the one nearest the pick, as the side at the end of u (swapping and reversing).
  const sideDistance = (swap: boolean, last: boolean) => {
    const { u0, u1, v0, v1 } = range()
    let best = Infinity
    for (let i = 0; i <= 24; i++) {
      const s = i / 24
      const p = swap ? bs.Value(u0 + (u1 - u0) * s, last ? v1 : v0) : bs.Value(last ? u1 : u0, v0 + (v1 - v0) * s)
      best = Math.min(best, xyz(p).distanceTo(pick))
      p.delete()
    }
    return best
  }
  const sides = [
    { swap: false, last: true },
    { swap: false, last: false },
    { swap: true, last: true },
    { swap: true, last: false },
  ]
  const side = sides.reduce((best, s) => (sideDistance(s.swap, s.last) < sideDistance(best.swap, best.last) ? s : best))
  if (side.swap) bs.ExchangeUV()
  if (!side.last) bs.UReverse()
  if (bs.IsUPeriodic()) bs.SetUNotPeriodic()

  const { u0, u1, v0, v1 } = range()
  // How far in u makes `length` in space, from the speed across the edge.
  let speed = 0
  const h = (u1 - u0) * 1e-4
  for (let i = 0; i <= 8; i++) {
    const v = v0 + ((v1 - v0) * i) / 8
    const a = bs.Value(u1 - h, v)
    const b = bs.Value(u1, v)
    speed += xyz(a).distanceTo(xyz(b)) / h / 9
    a.delete()
    b.delete()
  }
  if (speed < 1e-12) throw new Error('That edge is a point; pick another edge')
  const end = u1 + length / speed

  if (!exactlyBSpline(forward)) {
    // A cylinder, cone, sphere, ...: the surface itself runs on, so it is fitted again further out.
    const b = k.BRepTools.UVBounds(forward)
    const more = end - u1
    const range = { UMin: b.UMin, UMax: b.UMax, VMin: b.VMin, VMax: b.VMax }
    if (!side.swap) side.last ? (range.UMax += more) : (range.UMin -= more)
    else side.last ? (range.VMax += more) : (range.VMin -= more)
    let made = new k.BRepBuilderAPI_MakeFace(surfaceOf(forward, 0, range), 1e-7).Face()
    if (face.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) made = k.TopoDS.Face(made.Reversed())
    return R.cast(made)
  }

  const p = bs.UDegree()
  const knots: number[] = []
  for (let i = 1; i <= bs.NbUKnots(); i++) for (let m = 0; m < bs.UMultiplicity(i); m++) knots.push(bs.UKnot(i))
  const [nu, nv] = [bs.NbUPoles(), bs.NbVPoles()]
  const rational = bs.IsURational() || bs.IsVRational()
  // One row along u for each pole across, in homogeneous form.
  const rows = Array.from({ length: nv }, (_, j) =>
    Array.from({ length: nu }, (_, i) => {
      const q = bs.Pole(i + 1, j + 1)
      const w = rational ? bs.Weight(i + 1, j + 1) : 1
      const out = [q.X() * w, q.Y() * w, q.Z() * w, w]
      q.delete()
      return out
    }),
  )
  const longer = extendRows(rows, knots, p, end)

  const poles = new k.NCollection_Array2_gp_Pnt(1, nu, 1, nv)
  const weights = new k.NCollection_Array2_double(1, nu, 1, nv)
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const [x, y, z, w] = longer[j][i]
      const g = new k.gp_Pnt(x / w, y / w, z / w)
      poles.SetValue(i + 1, j + 1, g)
      g.delete()
      weights.SetValue(i + 1, j + 1, w)
    }
  const uKnots = new k.NCollection_Array1_double(1, bs.NbUKnots())
  const uMults = new k.NCollection_Array1_int(1, bs.NbUKnots())
  for (let i = 1; i <= bs.NbUKnots(); i++) {
    uKnots.SetValue(i, i === bs.NbUKnots() ? end : bs.UKnot(i))
    uMults.SetValue(i, bs.UMultiplicity(i))
  }
  const vKnots = new k.NCollection_Array1_double(1, bs.NbVKnots())
  const vMults = new k.NCollection_Array1_int(1, bs.NbVKnots())
  for (let i = 1; i <= bs.NbVKnots(); i++) {
    vKnots.SetValue(i, bs.VKnot(i))
    vMults.SetValue(i, bs.VMultiplicity(i))
  }
  const out = new k.Geom_BSplineSurface(poles, weights, uKnots, vKnots, uMults, vMults, p, bs.VDegree(), false, false)
  if (!side.last) out.UReverse()
  if (side.swap) out.ExchangeUV()
  let made = new k.BRepBuilderAPI_MakeFace(out, 1e-7).Face()
  if (face.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED) made = k.TopoDS.Face(made.Reversed())
  return R.cast(made)
}
