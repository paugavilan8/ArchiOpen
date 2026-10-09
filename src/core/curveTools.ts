import { Box3, Vector3 } from 'three'
import { approximate } from '../math/nurbs'
import { closestPoint, length } from './curves'
import { AnyCurve, ArcGeometry, CurveGeometry, domain, isClosed, pointAt, PolylineGeometry, samples, SegmentGeometry, tangentAt, tessellate } from './geometry'
import { intersect } from './intersect'
import { interpolate } from '../math/nurbs'

/** Drawing tools for curves: ellipses, polygons, helices, rebuilding, extending and blending. */

const W = Math.SQRT1_2

/** An exact ellipse: a rational quadratic curve with semi-axes a along `xaxis` and b along `yaxis`. */
export function ellipse(center: Vector3, xaxis: Vector3, yaxis: Vector3, a: number, b: number): CurveGeometry {
  const unit: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
  ]
  return {
    type: 'curve',
    degree: 2,
    points: unit.map(([x, y]) => center.clone().addScaledVector(xaxis, a * x).addScaledVector(yaxis, b * y)),
    knots: [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4],
    weights: [1, W, 1, W, 1, W, 1, W, 1],
  }
}

/**
 * A regular polygon. Inscribed, its corners are `radius` from the center and the first one lies at
 * `angle`; circumscribed, the middles of its sides are, with the first side's middle at `angle`.
 */
export function polygon(center: Vector3, xaxis: Vector3, yaxis: Vector3, radius: number, sides: number, angle: number, circumscribed: boolean): PolylineGeometry {
  const n = Math.max(3, Math.round(sides))
  const r = circumscribed ? radius / Math.cos(Math.PI / n) : radius
  const start = circumscribed ? angle - Math.PI / n : angle
  const points: Vector3[] = []
  for (let i = 0; i < n; i++) {
    const t = start + (2 * Math.PI * i) / n
    points.push(center.clone().addScaledVector(xaxis, r * Math.cos(t)).addScaledVector(yaxis, r * Math.sin(t)))
  }
  return { type: 'polyline', points, closed: true }
}

/** A helix around the axis from `base` to `top`, starting at `start` (its distance from the axis is the radius). */
export function helix(base: Vector3, top: Vector3, start: Vector3, turns: number): CurveGeometry | null {
  const axis = top.clone().sub(base)
  const height = axis.length()
  if (height < 1e-12 || turns <= 0) return null
  const n = axis.clone().normalize()
  const radial = start.clone().sub(base)
  radial.addScaledVector(n, -radial.dot(n))
  const r = radial.length()
  if (r < 1e-12) return null
  const x = radial.normalize()
  const y = n.clone().cross(x)
  const count = Math.max(8, Math.ceil(turns * 24))
  const points: Vector3[] = []
  for (let i = 0; i <= count; i++) {
    const f = i / count
    const t = 2 * Math.PI * turns * f
    points.push(base.clone().addScaledVector(axis, f).addScaledVector(x, r * Math.cos(t)).addScaledVector(y, r * Math.sin(t)))
  }
  return { type: 'curve', ...interpolate(points, 3) }
}

/** A smooth curve with a given number of control points and degree, fitted to the curve's shape. */
export function rebuild(g: AnyCurve, pointCount: number, degree: number): CurveGeometry {
  const [t0, t1] = domain(g)
  // Points evenly spaced along the curve's length, so long and short spans weigh alike.
  const dense = tessellate(g)
  const total = length(g)
  const samples = Math.max(100, pointCount * 12)
  const points: Vector3[] = []
  let walked = 0
  let i = 1
  for (let k = 0; k <= samples; k++) {
    const target = (total * k) / samples
    while (i < dense.length - 1 && walked + dense[i].distanceTo(dense[i - 1]) < target) {
      walked += dense[i].distanceTo(dense[i - 1])
      i++
    }
    const seg = dense[i].distanceTo(dense[i - 1]) || 1
    points.push(dense[i - 1].clone().lerp(dense[i], Math.min(1, Math.max(0, (target - walked) / seg))))
  }
  points[0] = pointAt(g, t0)
  points[points.length - 1] = pointAt(g, t1)
  // Parameter correction: each point takes the parameter of its closest point on the last fit.
  let fit: CurveGeometry = { type: 'curve', ...approximate(points, pointCount, degree) }
  for (let pass = 0; pass < 4; pass++) {
    const params = points.map((q, k) => (k === 0 ? 0 : k === points.length - 1 ? 1 : closestPoint(fit, q).t))
    if (params.some((u, k) => k > 0 && u <= params[k - 1])) break
    fit = { type: 'curve', ...approximate(points, pointCount, degree, params) }
  }
  return fit
}

/** Point, unit tangent pointing away from the curve, and parameter at one of its ends. */
export function curveEnd(g: AnyCurve, atStart: boolean): { point: Vector3; out: Vector3; t: number } {
  const [t0, t1] = domain(g)
  const t = atStart ? t0 : t1
  const tangent = tangentAt(g, t)
  return { point: pointAt(g, t), out: atStart ? tangent.negate() : tangent, t }
}

/** Curvature vector (towards the center of curvature, length 1/radius) at a parameter, estimated from nearby points. */
export function curvatureAt(g: AnyCurve, t: number): Vector3 {
  const [t0, t1] = domain(g)
  const h = (t1 - t0) * 1e-3
  // Centered when possible, one-sided at the ends.
  const a = Math.max(t0, Math.min(t1 - 2 * h, t - h))
  const p0 = pointAt(g, a)
  const p1 = pointAt(g, a + h)
  const p2 = pointAt(g, a + 2 * h)
  const u = p1.clone().sub(p0)
  const v = p2.clone().sub(p0)
  const n = u.clone().cross(v)
  if (n.lengthSq() < 1e-30) return new Vector3()
  // Circumcenter of the three points.
  const center = p0
    .clone()
    .add(n.clone().cross(u).multiplyScalar(v.lengthSq()).add(v.clone().cross(n).multiplyScalar(u.lengthSq())).divideScalar(2 * n.lengthSq()))
  const r = center.distanceTo(p1)
  return center.sub(p1).divideScalar(r * r)
}

export type Continuity = 'position' | 'tangency' | 'curvature'

/**
 * A curve joining the end of one curve to the end of another: straight (position), meeting their
 * directions (tangency, a cubic), or their directions and curvature (curvature, a quintic).
 */
export function blend(a: AnyCurve, aStart: boolean, b: AnyCurve, bStart: boolean, continuity: Continuity): AnyCurve {
  const ea = curveEnd(a, aStart)
  const eb = curveEnd(b, bStart)
  const gap = ea.point.distanceTo(eb.point)
  if (continuity === 'position') return { type: 'polyline', points: [ea.point, eb.point], closed: false }
  if (continuity === 'tangency') {
    const k = gap / 3
    return bezier([ea.point, ea.point.clone().addScaledVector(ea.out, k), eb.point.clone().addScaledVector(eb.out, k), eb.point])
  }
  const n = 5
  const k = gap / 4
  const p1 = ea.point.clone().addScaledVector(ea.out, k)
  const p4 = eb.point.clone().addScaledVector(eb.out, k)
  // With C'(0) = n·k·T, matching the curvature vector K needs P2 − 2·P1 + P0 = n·k²·K / (n − 1).
  const bend = (n * k * k) / (n - 1)
  const p2 = p1.clone().multiplyScalar(2).sub(ea.point).addScaledVector(curvatureAt(a, ea.t), bend)
  const p3 = p4.clone().multiplyScalar(2).sub(eb.point).addScaledVector(curvatureAt(b, eb.t), bend)
  return bezier([ea.point, p1, p2, p3, p4, eb.point])
}

function bezier(points: Vector3[]): CurveGeometry {
  const p = points.length - 1
  return { type: 'curve', degree: p, points, knots: [...new Array(p + 1).fill(0), ...new Array(p + 1).fill(1)] }
}

/** How far a ray from `from` along `dir` goes before it meets a boundary, or null if it does not. */
function rayHit(from: Vector3, dir: Vector3, reach: number, boundaries: AnyCurve[]): number | null {
  const ray: PolylineGeometry = { type: 'polyline', points: [from, from.clone().addScaledVector(dir, reach)], closed: false }
  let best: number | null = null
  for (const b of boundaries) {
    for (const hit of intersect(ray, b)) {
      const d = hit.ta * reach
      if (d > reach * 1e-9 && (best === null || d < best)) best = d
    }
  }
  return best
}

/** The angle from an arc's end, going on around its circle, to the nearest boundary; null if none. */
function arcHit(arc: ArcGeometry, atStart: boolean, boundaries: AnyCurve[]): number | null {
  const circle: AnyCurve = { type: 'circle', center: arc.center, xaxis: arc.xaxis, yaxis: arc.yaxis, radius: arc.radius }
  let best: number | null = null
  for (const b of boundaries) {
    for (const hit of intersect(circle, b)) {
      // Circle parameters run with the arc; beyond its end means past `angle`, before its start means below 0.
      const t = ((hit.ta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const extra = atStart ? (2 * Math.PI - t) % (2 * Math.PI) : t - arc.angle
      if (extra > 1e-9 && extra < 2 * Math.PI - arc.angle && (best === null || extra < best)) best = extra
    }
  }
  return best
}

/**
 * Extends an open curve from one end until it meets the boundaries: lines and polylines straight on,
 * arcs around their circle, other curves with a straight line along their end direction.
 */
export function extend(g: AnyCurve, atStart: boolean, boundaries: AnyCurve[]): AnyCurve | null {
  if (isClosed(g)) return null
  const box = new Box3()
  for (const c of [g, ...boundaries]) for (const p of tessellate(c)) box.expandByPoint(p)
  const reach = box.getSize(new Vector3()).length() * 4 + 1
  if (g.type === 'arc') {
    const extra = arcHit(g, atStart, boundaries)
    if (extra === null) return null
    if (!atStart) return { ...g, angle: g.angle + extra }
    const xaxis = g.xaxis.clone().multiplyScalar(Math.cos(-extra)).addScaledVector(g.yaxis, Math.sin(-extra))
    const yaxis = g.yaxis.clone().multiplyScalar(Math.cos(-extra)).addScaledVector(g.xaxis, -Math.sin(-extra))
    return { ...g, xaxis, yaxis, angle: g.angle + extra }
  }
  const end = curveEnd(g, atStart)
  const d = rayHit(end.point, end.out, reach, boundaries)
  if (d === null) return null
  const tip = end.point.clone().addScaledVector(end.out, d)
  if (g.type === 'polyline') {
    const points = g.points.map((p) => p.clone())
    points[atStart ? 0 : points.length - 1] = tip
    return { ...g, points }
  }
  const line: PolylineGeometry = { type: 'polyline', points: atStart ? [tip, end.point] : [end.point, tip], closed: false }
  const segments: SegmentGeometry[] = g.type === 'polycurve' ? g.segments : [g as SegmentGeometry]
  return { type: 'polycurve', segments: atStart ? [line, ...segments] : [...segments, line] }
}

/**
 * Points at the given distances along a curve from its start (by length), with the curve's unit
 * tangent and parameter at each. Distances past the end stop at the end.
 */
export function atLengths(g: AnyCurve, distances: number[]): { points: Vector3[]; tangents: Vector3[]; params: number[] } {
  // Fine samples of length against parameter; the closest ones are refined linearly.
  const [t0, t1] = domain(g)
  const spans = g.type === 'curve' ? Math.max(1, g.points.length - g.degree) : g.type === 'polycurve' ? g.segments.length : 1
  const n = g.type === 'polyline' ? 0 : Math.min(20000, 256 * spans)
  const ts = g.type === 'polyline' ? samples(g).params : Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n)
  const pts = ts.map((t) => pointAt(g, t))
  const cumulative = [0]
  for (let i = 1; i < pts.length; i++) cumulative.push(cumulative[i - 1] + pts[i].distanceTo(pts[i - 1]))
  const points: Vector3[] = []
  const tangents: Vector3[] = []
  const params: number[] = []
  for (const s of distances) {
    let lo = 0
    let hi = cumulative.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cumulative[mid] < s) lo = mid
      else hi = mid
    }
    const span = cumulative[hi] - cumulative[lo]
    const f = span > 0 ? Math.min(1, Math.max(0, (s - cumulative[lo]) / span)) : 0
    const t = ts[lo] + (ts[hi] - ts[lo]) * f
    params.push(t)
    points.push(pointAt(g, t))
    tangents.push(tangentAt(g, t))
  }
  return { points, tangents, params }
}

/**
 * `count` points spread evenly by length along a curve (ends included), with the curve's unit
 * tangent at each.
 */
export function alongCurve(g: AnyCurve, count: number): { points: Vector3[]; tangents: Vector3[]; params: number[] } {
  const total = length(g)
  return atLengths(g, Array.from({ length: count }, (_, i) => (total * i) / (count - 1)))
}
