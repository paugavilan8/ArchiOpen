import { Vector3 } from 'three'
import { closestPoint } from './curves'
import { domain, isClosed, pointAt, samples, TOLERANCE, type AnyCurve } from './geometry'

/**
 * Object snaps that depend on more than one object, or on the point the command started from:
 * intersections (Int), perpendicular points (Perp) and tangent points (Tan). Fixed snap points
 * (End, Mid, Cen, Quad, Knot) are in geometry.ts.
 */

/** Where two screen segments cross: the fraction along each, or null if they do not. */
export function crossing(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { s: number; u: number } | null {
  const ex = bx - ax
  const ey = by - ay
  const fx = dx - cx
  const fy = dy - cy
  const det = ex * fy - ey * fx
  // Parallel (or a segment of no length on screen).
  if (Math.abs(det) < 1e-12 * Math.max(1, ex * ex + ey * ey, fx * fx + fy * fy)) return null
  const s = ((cx - ax) * fy - (cy - ay) * fx) / det
  const u = ((cx - ax) * ey - (cy - ay) * ex) / det
  const eps = 1e-9
  if (s < -eps || s > 1 + eps || u < -eps || u > 1 + eps) return null
  return { s: Math.min(1, Math.max(0, s)), u: Math.min(1, Math.max(0, u)) }
}

/**
 * Two curves that cross on screen at `pa` (on a) and `pb` (on b), points on their drawn polylines:
 * their intersection in space if they meet there, or null if they only seem to cross (one passes
 * in front of the other). The points are moved onto each curve in turn until they meet.
 */
export function meetingPoint(a: AnyCurve, b: AnyCurve, pa: Vector3, pb: Vector3): Vector3 | null {
  let p = closestPoint(a, pa).point
  let q = closestPoint(b, pb).point
  // Far apart compared with how far the polylines are from the curves: they pass each other.
  const scale = Math.max(pa.distanceTo(pb), p.distanceTo(pa), q.distanceTo(pb))
  for (let i = 0; i < 50 && p.distanceTo(q) > TOLERANCE * 1e-3; i++) {
    const next = closestPoint(a, q).point
    q = closestPoint(b, next).point
    p = next
  }
  if (p.distanceTo(q) > TOLERANCE || p.distanceTo(pa) > 10 * scale + TOLERANCE) return null
  return p.add(q).multiplyScalar(0.5)
}

/** A function of a point on the curve and its direction there (a unit vector). */
type Condition = (point: Vector3, direction: Vector3) => number

/**
 * Parameters where `condition` is zero along the curve. It is worked out just inside each interval
 * between two display samples, with the direction from inside it (so at a polyline's corners, where
 * the direction jumps, each side is seen on its own), and a change of sign is narrowed down by
 * bisection; one across a sample is a root at the sample. Where it only jumps across zero (at a
 * corner) there is no root: the value found must be small against `scale`.
 */
function roots(g: AnyCurve, condition: Condition, scale: number): number[] {
  const { params } = samples(g)
  const found: number[] = []
  const small = (f: number) => Math.abs(f) <= 1e-6 * scale
  // The condition at t, with the direction over [t - h, t + h] kept within [lo, hi].
  const at = (t: number, h: number, lo: number, hi: number) => {
    const direction = pointAt(g, Math.min(hi, t + h)).sub(pointAt(g, Math.max(lo, t - h)))
    return direction.lengthSq() === 0 ? NaN : condition(pointAt(g, t), direction.normalize())
  }
  const keep = (t: number) => {
    if (!found.some((s) => Math.abs(s - t) < 1e-9 * Math.max(1, Math.abs(t)))) found.push(t)
  }
  // A closed curve goes on past its end into its start.
  const n = params.length
  let previous = NaN
  if (isClosed(g) && n > 1) {
    const h = (params[n - 1] - params[n - 2]) * 1e-6
    previous = at(params[n - 1] - 2 * h, h, params[n - 2], params[n - 1])
  }
  for (let i = 1; i < params.length; i++) {
    const a = params[i - 1]
    const b = params[i]
    const h = (b - a) * 1e-6
    const fa = at(a + 2 * h, h, a, b)
    const fb = at(b - 2 * h, h, a, b)
    // A root at the sample between this interval and the last.
    if (previous * fa <= 0 && small(at(a, h, params[i - 2] ?? a, b))) keep(a)
    previous = fb
    if (!(fa * fb < 0)) continue
    let lo = a + 2 * h
    let hi = b - 2 * h
    let flo = fa
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      const fm = at(mid, h, a, b)
      if (flo * fm <= 0) hi = mid
      else {
        lo = mid
        flo = fm
      }
    }
    const t = (lo + hi) / 2
    if (small(at(t, h, a, b))) keep(t)
  }
  return found
}

/** A size for the curve and point together, so that "small" means the same at any scale. */
function sizeOf(g: AnyCurve, from: Vector3): number {
  const { points } = samples(g)
  let size = 0
  for (const p of points) size = Math.max(size, p.distanceTo(from))
  return Math.max(size, TOLERANCE)
}

/** Points of the curve where a line from `from` meets it at a right angle. */
export function perpendicularPoints(g: AnyCurve, from: Vector3): Vector3[] {
  const scale = sizeOf(g, from)
  return roots(g, (p, d) => p.sub(from).dot(d), scale)
    .map((t) => pointAt(g, t))
    .filter((p) => p.distanceTo(from) > TOLERANCE)
}

/**
 * Points of the curve where a line from `from` touches it, seen along `normal` (the curve's own
 * plane for circles and arcs, otherwise the construction plane's normal).
 */
export function tangentPoints(g: AnyCurve, from: Vector3, normal: Vector3): Vector3[] {
  const n = g.type === 'circle' || g.type === 'arc' ? g.xaxis.clone().cross(g.yaxis).normalize() : normal
  const scale = sizeOf(g, from)
  const [t0, t1] = domain(g)
  const closed = isClosed(g)
  return (
    roots(g, (p, d) => p.sub(from).cross(d).dot(n), scale)
      // A curve's own ends are not tangent points (unless they are where it closes).
      .filter((t) => closed || (Math.abs(t - t0) > 1e-9 && Math.abs(t - t1) > 1e-9))
      .map((t) => pointAt(g, t))
      .filter((p) => p.distanceTo(from) > TOLERANCE)
  )
}
