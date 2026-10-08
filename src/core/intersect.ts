import { Box3, Vector3 } from 'three'
import { domain, AnyCurve, isClosed, pointAt, samples, TOLERANCE } from './geometry'

export interface Intersection {
  /** Parameter on the first curve. */
  ta: number
  /** Parameter on the second curve. */
  tb: number
  point: Vector3
}

/** Derivative (not normalized) by central differences. */
function derivativeAt(g: AnyCurve, t: number): Vector3 {
  const [t0, t1] = domain(g)
  const h = (t1 - t0) * 1e-7
  const a = Math.max(t0, t - h)
  const b = Math.min(t1, t + h)
  return pointAt(g, b).sub(pointAt(g, a)).divideScalar(b - a)
}

/** Closest points between segments p0-p1 and q0-q1: fractions along each and their distance. */
function segmentClosest(p0: Vector3, p1: Vector3, q0: Vector3, q1: Vector3): { s: number; u: number; distance: number } {
  const d1 = p1.clone().sub(p0)
  const d2 = q1.clone().sub(q0)
  const r = p0.clone().sub(q0)
  const a = d1.dot(d1)
  const e = d2.dot(d2)
  const f = d2.dot(r)
  let s = 0
  let u = 0
  if (a <= 1e-24 && e <= 1e-24) return { s, u, distance: p0.distanceTo(q0) }
  if (a <= 1e-24) u = Math.min(1, Math.max(0, f / e))
  else {
    const c = d1.dot(r)
    if (e <= 1e-24) s = Math.min(1, Math.max(0, -c / a))
    else {
      const b = d1.dot(d2)
      const denom = a * e - b * b
      s = denom > 1e-24 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0
      u = (b * s + f) / e
      if (u < 0) {
        u = 0
        s = Math.min(1, Math.max(0, -c / a))
      } else if (u > 1) {
        u = 1
        s = Math.min(1, Math.max(0, (b - c) / a))
      }
    }
  }
  const pa = p0.clone().addScaledVector(d1, s)
  const pb = q0.clone().addScaledVector(d2, u)
  return { s, u, distance: pa.distanceTo(pb) }
}

function clampParam(g: AnyCurve, t: number): number {
  const [t0, t1] = domain(g)
  if (isClosed(g)) {
    const span = t1 - t0
    return t0 + ((((t - t0) % span) + span) % span)
  }
  return Math.min(t1, Math.max(t0, t))
}

/** Newton iteration on A(ta) = B(tb), in the least-squares sense for curves in 3D. */
function refine(a: AnyCurve, b: AnyCurve, ta: number, tb: number): { ta: number; tb: number; distance: number } {
  for (let iter = 0; iter < 30; iter++) {
    const F = pointAt(a, ta).sub(pointAt(b, tb))
    if (F.lengthSq() < 1e-24) break
    const da = derivativeAt(a, ta)
    const db = derivativeAt(b, tb)
    const m11 = da.dot(da)
    const m12 = -da.dot(db)
    const m22 = db.dot(db)
    const r1 = -da.dot(F)
    const r2 = db.dot(F)
    const det = m11 * m22 - m12 * m12
    if (Math.abs(det) < 1e-20) break
    const dta = (r1 * m22 - m12 * r2) / det
    const dtb = (m11 * r2 - m12 * r1) / det
    ta = clampParam(a, ta + dta)
    tb = clampParam(b, tb + dtb)
    if (Math.abs(dta) + Math.abs(dtb) < 1e-14) break
  }
  return { ta, tb, distance: pointAt(a, ta).distanceTo(pointAt(b, tb)) }
}

function boxOf(points: Vector3[], margin: number): Box3 {
  return new Box3().setFromPoints(points).expandByScalar(margin)
}

/** Points where two curves cross or touch, within the model tolerance. */
export function intersect(a: AnyCurve, b: AnyCurve, tolerance = TOLERANCE): Intersection[] {
  const sa = samples(a)
  const sb = samples(b)
  if (!boxOf(sa.points, tolerance).intersectsBox(boxOf(sb.points, tolerance))) return []
  const exact = a.type === 'polyline' && b.type === 'polyline'

  const found: Intersection[] = []
  for (let i = 1; i < sa.points.length; i++) {
    const p0 = sa.points[i - 1]
    const p1 = sa.points[i]
    const segBox = boxOf([p0, p1], tolerance + p0.distanceTo(p1) * 0.05)
    for (let j = 1; j < sb.points.length; j++) {
      const q0 = sb.points[j - 1]
      const q1 = sb.points[j]
      if (!segBox.intersectsBox(boxOf([q0, q1], tolerance))) continue
      const hit = segmentClosest(p0, p1, q0, q1)
      // Chords sag below the true curves, so curved candidates get some slack before refining.
      const slack = exact ? tolerance : Math.max(tolerance, 0.05 * (p0.distanceTo(p1) + q0.distanceTo(q1)))
      if (hit.distance > slack) continue
      let ta = sa.params[i - 1] + (sa.params[i] - sa.params[i - 1]) * hit.s
      let tb = sb.params[j - 1] + (sb.params[j] - sb.params[j - 1]) * hit.u
      if (!exact) {
        const refined = refine(a, b, ta, tb)
        if (refined.distance > tolerance) continue
        ta = refined.ta
        tb = refined.tb
      }
      const point = pointAt(a, ta)
      if (!found.some((f) => f.point.distanceTo(point) < tolerance * 10)) found.push({ ta, tb, point })
    }
  }
  return found.sort((x, y) => x.ta - y.ta)
}
