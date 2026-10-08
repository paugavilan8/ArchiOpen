import { Box3, Vector3 } from 'three'
import { clampedKnots, evalBSpline } from '../math/nurbs'

export interface Plane {
  origin: Vector3
  xaxis: Vector3
  yaxis: Vector3
  normal: Vector3
}

/** Straight segments through the points. A line is a polyline with two points. */
export interface PolylineGeometry {
  type: 'polyline'
  points: Vector3[]
  closed: boolean
}

export interface CircleGeometry {
  type: 'circle'
  center: Vector3
  xaxis: Vector3
  yaxis: Vector3
  radius: number
}

/** Circular arc that starts on `xaxis` and turns `angle` radians towards `yaxis`. */
export interface ArcGeometry {
  type: 'arc'
  center: Vector3
  xaxis: Vector3
  yaxis: Vector3
  radius: number
  angle: number
}

/** Non-rational B-spline curve with a clamped knot vector. */
export interface CurveGeometry {
  type: 'curve'
  degree: number
  points: Vector3[]
  knots: number[]
}

/** Open curves that can be chained into a polycurve. */
export type SegmentGeometry = PolylineGeometry | ArcGeometry | CurveGeometry

/** Curves joined end to end. */
export interface PolycurveGeometry {
  type: 'polycurve'
  segments: SegmentGeometry[]
}

// Geometry values are immutable: edits produce a new value, which keeps the caches below valid.
export type Geometry = PolylineGeometry | CircleGeometry | ArcGeometry | CurveGeometry | PolycurveGeometry

export interface SnapPoints {
  end: Vector3[]
  mid: Vector3[]
  cen: Vector3[]
  quad: Vector3[]
}

/** Model tolerance: points closer than this are the same point. */
export const TOLERANCE = 1e-3

const CIRCLE_SEGMENTS = 96
const SAMPLES_PER_SPAN = 16
const TWO_PI = Math.PI * 2

// --- Evaluation --------------------------------------------------------------------
// Every curve has a parameter domain. Polylines use [0, segment count], circles [0, 2π], arcs
// [0, angle], B-splines their knot domain, and polycurves [0, segment count] with each segment
// mapped linearly onto one unit.

export function domain(g: Geometry): [number, number] {
  switch (g.type) {
    case 'polyline':
      return [0, g.closed ? g.points.length : g.points.length - 1]
    case 'circle':
      return [0, TWO_PI]
    case 'arc':
      return [0, g.angle]
    case 'curve':
      return [g.knots[g.degree], g.knots[g.points.length]]
    case 'polycurve':
      return [0, g.segments.length]
  }
}

/** Closed curves have no ends; parameters wrap around. */
export function isClosed(g: Geometry): boolean {
  switch (g.type) {
    case 'polyline':
      return g.closed
    case 'circle':
      return true
    case 'arc':
      return false
    case 'curve':
    case 'polycurve':
      return pointAt(g, domain(g)[0]).distanceTo(pointAt(g, domain(g)[1])) < TOLERANCE
  }
}

function circlePoint(c: CircleGeometry | ArcGeometry, angle: number): Vector3 {
  return c.center
    .clone()
    .addScaledVector(c.xaxis, c.radius * Math.cos(angle))
    .addScaledVector(c.yaxis, c.radius * Math.sin(angle))
}

/** For a polycurve parameter: the segment index and the parameter within that segment. */
export function segmentParam(g: PolycurveGeometry, t: number): [number, number] {
  const i = Math.min(g.segments.length - 1, Math.max(0, Math.floor(t)))
  const [s0, s1] = domain(g.segments[i])
  return [i, s0 + (s1 - s0) * (t - i)]
}

export function pointAt(g: Geometry, t: number): Vector3 {
  switch (g.type) {
    case 'polyline': {
      const n = g.points.length
      const last = g.closed ? n : n - 1
      const i = Math.min(last - 1, Math.max(0, Math.floor(t)))
      return g.points[i].clone().lerp(g.points[(i + 1) % n], t - i)
    }
    case 'circle':
    case 'arc':
      return circlePoint(g, t)
    case 'curve':
      return evalBSpline(g.points, g.degree, g.knots, t)
    case 'polycurve': {
      const [i, s] = segmentParam(g, t)
      return pointAt(g.segments[i], s)
    }
  }
}

export function startPoint(g: Geometry): Vector3 {
  return pointAt(g, domain(g)[0])
}

export function endPoint(g: Geometry): Vector3 {
  return pointAt(g, domain(g)[1])
}

/** Unit tangent at t, by central differences (one-sided at the ends of open curves). */
export function tangentAt(g: Geometry, t: number): Vector3 {
  const [t0, t1] = domain(g)
  const h = (t1 - t0) * 1e-6
  const closed = isClosed(g)
  let a = t - h
  let b = t + h
  if (!closed) {
    a = Math.max(t0, a)
    b = Math.min(t1, b)
  } else {
    if (a < t0) a += t1 - t0
    if (b > t1) b -= t1 - t0
  }
  return pointAt(g, b).sub(pointAt(g, a)).normalize()
}

// --- Display and snapping ----------------------------------------------------------

export interface Samples {
  points: Vector3[]
  params: number[]
}

const sampleCache = new WeakMap<Geometry, Samples>()
const snapCache = new WeakMap<Geometry, SnapPoints>()

function buildSamples(g: Geometry): Samples {
  const params: number[] = []
  switch (g.type) {
    case 'polyline': {
      const [, t1] = domain(g)
      for (let i = 0; i <= t1; i++) params.push(i)
      break
    }
    case 'circle':
    case 'arc': {
      const sweep = g.type === 'circle' ? TWO_PI : g.angle
      const count = Math.max(8, Math.ceil((CIRCLE_SEGMENTS * sweep) / TWO_PI))
      for (let i = 0; i <= count; i++) params.push((sweep * i) / count)
      break
    }
    case 'curve': {
      const spans = [...new Set(g.knots.slice(g.degree, g.points.length + 1))]
      for (let s = 0; s < spans.length - 1; s++) {
        for (let i = 0; i < SAMPLES_PER_SPAN; i++) params.push(spans[s] + ((spans[s + 1] - spans[s]) * i) / SAMPLES_PER_SPAN)
      }
      params.push(spans[spans.length - 1])
      break
    }
    case 'polycurve': {
      const points: Vector3[] = []
      g.segments.forEach((segment, i) => {
        const sub = samples(segment)
        const [s0, s1] = domain(segment)
        sub.params.forEach((s, k) => {
          if (i > 0 && k === 0) return // Shared with the end of the previous segment.
          params.push(i + (s - s0) / (s1 - s0))
          points.push(sub.points[k])
        })
      })
      return { points, params }
    }
  }
  return { points: params.map((t) => pointAt(g, t)), params }
}

/** Points along the curve with their parameters. Cached; must not be mutated. */
export function samples(g: Geometry): Samples {
  let s = sampleCache.get(g)
  if (!s) {
    s = buildSamples(g)
    sampleCache.set(g, s)
  }
  return s
}

/** Display polyline for a geometry. The result is cached and must not be mutated. */
export function tessellate(g: Geometry): Vector3[] {
  return samples(g).points
}

/** Point halfway along the curve, measured by length. */
function midPoint(g: Geometry): Vector3 {
  const { points } = samples(g)
  let total = 0
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1])
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const d = points[i].distanceTo(points[i - 1])
    if (walked + d >= total / 2) return points[i - 1].clone().lerp(points[i], d === 0 ? 0 : (total / 2 - walked) / d)
    walked += d
  }
  return points[0].clone()
}

function buildSnapPoints(g: Geometry): SnapPoints {
  const snaps: SnapPoints = { end: [], mid: [], cen: [], quad: [] }
  switch (g.type) {
    case 'polyline': {
      const pts = tessellate(g)
      snaps.end = g.points
      for (let i = 0; i < pts.length - 1; i++) snaps.mid.push(pts[i].clone().lerp(pts[i + 1], 0.5))
      break
    }
    case 'circle':
      snaps.cen = [g.center]
      for (let i = 0; i < 4; i++) snaps.quad.push(circlePoint(g, (i * Math.PI) / 2))
      break
    case 'arc':
      snaps.end = [startPoint(g), endPoint(g)]
      snaps.mid = [circlePoint(g, g.angle / 2)]
      snaps.cen = [g.center]
      // Quadrants are measured from the arc's own axes.
      for (let i = 0; i < 4; i++) if ((i * Math.PI) / 2 <= g.angle + 1e-9) snaps.quad.push(circlePoint(g, (i * Math.PI) / 2))
      break
    case 'curve':
      if (g.points.length < 2) break
      snaps.end = [startPoint(g), endPoint(g)]
      snaps.mid = [midPoint(g)]
      break
    case 'polycurve':
      for (const segment of g.segments) {
        const s = snapPoints(segment)
        snaps.end.push(...s.end)
        snaps.mid.push(...s.mid)
        snaps.cen.push(...s.cen)
        snaps.quad.push(...s.quad)
      }
      break
  }
  return snaps
}

export function snapPoints(g: Geometry): SnapPoints {
  let snaps = snapCache.get(g)
  if (!snaps) {
    snaps = buildSnapPoints(g)
    snapCache.set(g, snaps)
  }
  return snaps
}

export function expandBox(box: Box3, g: Geometry): void {
  for (const p of tessellate(g)) box.expandByPoint(p)
}

export function typeName(g: Geometry): string {
  if (g.type === 'polyline') return g.points.length === 2 ? 'line' : 'polyline'
  return g.type
}

// --- Persistence -------------------------------------------------------------------

type Triple = [number, number, number]

const toTriple = (v: Vector3): Triple => [v.x, v.y, v.z]
const fromTriple = (t: Triple): Vector3 => new Vector3(t[0], t[1], t[2])

export function geometryToJSON(g: Geometry): unknown {
  switch (g.type) {
    case 'polyline':
      return { type: g.type, points: g.points.map(toTriple), closed: g.closed }
    case 'circle':
      return { type: g.type, center: toTriple(g.center), xaxis: toTriple(g.xaxis), yaxis: toTriple(g.yaxis), radius: g.radius }
    case 'arc':
      return {
        type: g.type,
        center: toTriple(g.center),
        xaxis: toTriple(g.xaxis),
        yaxis: toTriple(g.yaxis),
        radius: g.radius,
        angle: g.angle,
      }
    case 'curve':
      return { type: g.type, degree: g.degree, points: g.points.map(toTriple), knots: g.knots }
    case 'polycurve':
      return { type: g.type, segments: g.segments.map(geometryToJSON) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geometryFromJSON(j: any): Geometry {
  switch (j.type) {
    case 'polyline':
      return { type: 'polyline', points: j.points.map(fromTriple), closed: !!j.closed }
    case 'circle':
      return { type: 'circle', center: fromTriple(j.center), xaxis: fromTriple(j.xaxis), yaxis: fromTriple(j.yaxis), radius: j.radius }
    case 'arc':
      return {
        type: 'arc',
        center: fromTriple(j.center),
        xaxis: fromTriple(j.xaxis),
        yaxis: fromTriple(j.yaxis),
        radius: j.radius,
        angle: j.angle,
      }
    case 'curve': {
      const points: Vector3[] = j.points.map(fromTriple)
      const degree = Math.min(j.degree, points.length - 1)
      // Files from before knots were stored used uniform clamped knots.
      return { type: 'curve', degree, points, knots: j.knots ?? clampedKnots(points.length, degree) }
    }
    case 'polycurve':
      return { type: 'polycurve', segments: j.segments.map(geometryFromJSON) }
    default:
      throw new Error(`Unknown geometry type: ${j.type}`)
  }
}
