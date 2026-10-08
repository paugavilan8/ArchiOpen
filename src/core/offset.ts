import { Vector3 } from 'three'
import { interpolate } from '../math/nurbs'
import { chain, closestPoint, explode } from './curves'
import { domain, endPoint, AnyCurve, isClosed, pointAt, PolylineGeometry, startPoint, tangentAt, TOLERANCE } from './geometry'

/** Direction to the left of the curve at t, within the plane with normal n. */
function leftNormal(g: AnyCurve, t: number, n: Vector3): Vector3 {
  return n.clone().cross(tangentAt(g, t)).normalize()
}

/** Intersection of two lines p + a·u and q + b·w lying in the plane with normal n. */
function lineIntersection(p: Vector3, u: Vector3, q: Vector3, w: Vector3, n: Vector3): Vector3 | null {
  const denom = u.clone().cross(w).dot(n)
  if (Math.abs(denom) < 1e-12) return null
  const a = q.clone().sub(p).cross(w).dot(n) / denom
  return p.clone().addScaledVector(u, a)
}

const isLine = (g: AnyCurve): g is PolylineGeometry => g.type === 'polyline' && g.points.length === 2

/** Offsets one smooth piece by `distance` along its left normal (negative goes right). */
function offsetPiece(g: AnyCurve, distance: number, n: Vector3): AnyCurve | null {
  switch (g.type) {
    case 'polyline': {
      const shift = leftNormal(g, 0.5, n).multiplyScalar(distance)
      return { ...g, points: g.points.map((p) => p.clone().add(shift)) }
    }
    case 'circle':
    case 'arc': {
      // The left normal points either towards the center or away from it, along the whole arc.
      const t = g.type === 'arc' ? g.angle / 2 : 0
      const p = pointAt(g, t)
      const outward = p.clone().sub(g.center).normalize()
      const radius = g.radius + distance * leftNormal(g, t, n).dot(outward)
      return radius > TOLERANCE ? { ...g, radius } : null
    }
    case 'curve': {
      // Offset a dense set of points and fit a cubic through them.
      const [t0, t1] = domain(g)
      const count = Math.max(40, 24 * (g.points.length - g.degree))
      const pts: Vector3[] = []
      for (let i = 0; i <= count; i++) {
        const t = t0 + ((t1 - t0) * i) / count
        pts.push(pointAt(g, t).addScaledVector(leftNormal(g, t, n), distance))
      }
      return { type: 'curve', ...interpolate(pts, 3) }
    }
    case 'polycurve':
      return null
  }
}

/**
 * Offsets a planar curve by `distance` to the side of `through`, in the plane with normal n.
 * Corners between straight segments are extended to meet; other gaps are bridged with lines.
 */
export function offset(g: AnyCurve, distance: number, through: Vector3, n: Vector3): AnyCurve | null {
  const hit = closestPoint(g, through)
  const side = leftNormal(g, hit.t, n).dot(through.clone().sub(hit.point)) >= 0 ? 1 : -1
  const signed = side * distance

  if (g.type === 'circle' || g.type === 'arc' || g.type === 'curve' || isLine(g)) return offsetPiece(g, signed, n)

  const closed = isClosed(g)
  const pieces = explode(g).map((s) => offsetPiece(s, signed, n))
  if (pieces.some((p) => p === null)) return null
  const parts = pieces as AnyCurve[]

  const bridges: (AnyCurve | null)[] = parts.map(() => null)
  const joints = closed ? parts.length : parts.length - 1
  for (let j = 0; j < joints; j++) {
    const a = parts[j]
    const k = (j + 1) % parts.length
    const b = parts[k]
    const end = endPoint(a)
    const start = startPoint(b)
    if (end.distanceTo(start) < TOLERANCE) continue
    if (isLine(a) && isLine(b)) {
      const corner = lineIntersection(a.points[0], a.points[1].clone().sub(a.points[0]), b.points[0], b.points[1].clone().sub(b.points[0]), n)
      if (corner) {
        parts[j] = { ...a, points: [a.points[0], corner] }
        parts[k] = { ...b, points: [corner.clone(), b.points[1]] }
        continue
      }
    }
    bridges[j] = { type: 'polyline', points: [end, start], closed: false }
  }
  // A closed curve's first piece may have changed at the closing corner after it was visited.
  const ordered: AnyCurve[] = []
  parts.forEach((p, j) => {
    ordered.push(p)
    if (bridges[j]) ordered.push(bridges[j]!)
  })
  return chain(ordered)
}
