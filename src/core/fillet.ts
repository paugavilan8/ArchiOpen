import { Vector3 } from 'three'
import { chain } from './curves'
import { ArcGeometry, AnyCurve, PolylineGeometry, TOLERANCE } from './geometry'

export type FilletResult = { ok: true; a: PolylineGeometry; b: PolylineGeometry; arc: ArcGeometry | null } | { ok: false; error: string }

/** Arc of radius r tangent to the rays from `corner` along unit vectors u and w (angle between them < π). */
function cornerArc(corner: Vector3, u: Vector3, w: Vector3, r: number): { arc: ArcGeometry; setback: number } {
  const theta = u.angleTo(w)
  const setback = r / Math.tan(theta / 2)
  const ta = corner.clone().addScaledVector(u, setback)
  const tb = corner.clone().addScaledVector(w, setback)
  const center = corner.clone().addScaledVector(u.clone().add(w).normalize(), r / Math.sin(theta / 2))
  const xaxis = ta.clone().sub(center).normalize()
  const towardEnd = tb.clone().sub(center)
  const yaxis = towardEnd.addScaledVector(xaxis, -towardEnd.dot(xaxis)).normalize()
  return { arc: { type: 'arc', center, xaxis, yaxis, radius: r, angle: Math.PI - theta }, setback }
}

interface LineCorner {
  corner: Vector3
  /** Unit directions from the corner along the kept side of each line. */
  u: Vector3
  w: Vector3
  /** The ends of the lines away from the corner. */
  farA: Vector3
  farB: Vector3
}

/** Where two coplanar lines meet, and which side of each was picked. */
function lineCorner(a: PolylineGeometry, pickA: Vector3, b: PolylineGeometry, pickB: Vector3): LineCorner | { error: string } {
  const [a0, a1] = a.points
  const [b0, b1] = b.points
  const da = a1.clone().sub(a0).normalize()
  const db = b1.clone().sub(b0).normalize()
  const normal = da.clone().cross(db)
  if (normal.length() < 1e-9) return { error: 'The lines are parallel' }

  // Closest points of the two infinite lines; they must meet for the lines to be coplanar.
  const w0 = a0.clone().sub(b0)
  const bdot = da.dot(db)
  const denom = 1 - bdot * bdot
  const sa = (bdot * db.dot(w0) - da.dot(w0)) / denom
  const sb = (db.dot(w0) - bdot * da.dot(w0)) / denom
  const corner = a0.clone().addScaledVector(da, sa)
  if (corner.distanceTo(b0.clone().addScaledVector(db, sb)) > TOLERANCE) return { error: 'The lines are not in the same plane' }

  // Keep the side of each line where it was picked.
  const keepDirection = (dir: Vector3, pick: Vector3, p0: Vector3, p1: Vector3) => {
    let side = pick.clone().sub(corner).dot(dir)
    if (Math.abs(side) < 1e-9) side = Math.max(p0.clone().sub(corner).dot(dir), p1.clone().sub(corner).dot(dir))
    return dir.clone().multiplyScalar(side >= 0 ? 1 : -1)
  }
  const u = keepDirection(da, pickA, a0, a1)
  const w = keepDirection(db, pickB, b0, b1)
  const farA = a0.clone().sub(corner).dot(u) > a1.clone().sub(corner).dot(u) ? a0 : a1
  const farB = b0.clone().sub(corner).dot(w) > b1.clone().sub(corner).dot(w) ? b0 : b1
  return { corner, u, w, farA, farB }
}

/**
 * Rounds the corner between two lines with an arc of radius r, trimming or extending both lines to
 * the arc. The picked points say which side of each line to keep. Radius 0 makes a sharp corner.
 */
export function filletLines(a: PolylineGeometry, pickA: Vector3, b: PolylineGeometry, pickB: Vector3, r: number): FilletResult {
  const c = lineCorner(a, pickA, b, pickB)
  if ('error' in c) return { ok: false, error: c.error }
  const { corner, u, w, farA, farB } = c
  if (r <= 0) {
    return { ok: true, a: line(farA, corner), b: line(corner, farB), arc: null }
  }
  const { arc, setback } = cornerArc(corner, u, w, r)
  if (setback > farA.clone().sub(corner).dot(u) + TOLERANCE || setback > farB.clone().sub(corner).dot(w) + TOLERANCE) {
    return { ok: false, error: 'The radius is too large for these lines' }
  }
  const ta = corner.clone().addScaledVector(u, setback)
  const tb = corner.clone().addScaledVector(w, setback)
  return { ok: true, a: line(farA, ta), b: line(tb, farB), arc }
}

export type ChamferResult = { ok: true; a: PolylineGeometry; b: PolylineGeometry; chamfer: PolylineGeometry | null } | { ok: false; error: string }

/**
 * Cuts the corner between two lines with a straight line, `da` along the first and `db` along the
 * second from where they meet, trimming or extending both. Zero distances make a sharp corner.
 */
export function chamferLines(a: PolylineGeometry, pickA: Vector3, b: PolylineGeometry, pickB: Vector3, da: number, db: number): ChamferResult {
  const c = lineCorner(a, pickA, b, pickB)
  if ('error' in c) return { ok: false, error: c.error }
  const { corner, u, w, farA, farB } = c
  if (da <= 0 && db <= 0) return { ok: true, a: line(farA, corner), b: line(corner, farB), chamfer: null }
  if (da > farA.clone().sub(corner).dot(u) + TOLERANCE || db > farB.clone().sub(corner).dot(w) + TOLERANCE) {
    return { ok: false, error: 'The distances are too large for these lines' }
  }
  const ta = corner.clone().addScaledVector(u, da)
  const tb = corner.clone().addScaledVector(w, db)
  return { ok: true, a: line(farA, ta), b: line(tb, farB), chamfer: line(ta, tb) }
}

function line(p: Vector3, q: Vector3): PolylineGeometry {
  return { type: 'polyline', points: [p.clone(), q.clone()], closed: false }
}

/** Rounds every corner of a polyline with radius r. Returns an error if a segment is too short. */
export function filletCorners(g: PolylineGeometry, r: number): { ok: true; geometry: AnyCurve } | { ok: false; error: string } {
  const pts = g.points
  const n = pts.length
  const closed = g.closed && n > 2
  const corners: ({ arc: ArcGeometry; setback: number } | null)[] = pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return null
    const u = pts[(i - 1 + n) % n].clone().sub(p).normalize()
    const w = pts[(i + 1) % n].clone().sub(p).normalize()
    // Straight-through vertices and reversals cannot be rounded.
    if (u.angleTo(w) > Math.PI - 1e-6 || u.angleTo(w) < 1e-6) return null
    return cornerArc(p, u, w, r)
  })

  const segmentCount = closed ? n : n - 1
  for (let i = 0; i < segmentCount; i++) {
    const j = (i + 1) % n
    const available = pts[i].distanceTo(pts[j])
    const needed = (corners[i]?.setback ?? 0) + (corners[j]?.setback ?? 0)
    if (needed > available + TOLERANCE) return { ok: false, error: `The radius is too large for segment ${i + 1}` }
  }

  const pieces: AnyCurve[] = []
  for (let i = 0; i < segmentCount; i++) {
    const j = (i + 1) % n
    const dir = pts[j].clone().sub(pts[i]).normalize()
    const start = pts[i].clone().addScaledVector(dir, corners[i]?.setback ?? 0)
    const end = pts[j].clone().addScaledVector(dir, -(corners[j]?.setback ?? 0))
    if (start.distanceTo(end) > 1e-9) pieces.push(line(start, end))
    if (corners[j] && (closed || j !== 0)) pieces.push(corners[j]!.arc)
  }
  const geometry = chain(pieces)
  return geometry ? { ok: true, geometry } : { ok: false, error: 'Nothing to fillet' }
}
