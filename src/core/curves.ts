import { Matrix3, Matrix4, Vector3 } from 'three'
import { reverseBSpline, splitBSpline } from '../math/nurbs'
import {
  ArcGeometry,
  CircleGeometry,
  CurveGeometry,
  domain,
  endPoint,
  Geometry,
  isClosed,
  pointAt,
  PolylineGeometry,
  samples,
  SegmentGeometry,
  segmentParam,
  startPoint,
  TOLERANCE,
} from './geometry'

const TWO_PI = Math.PI * 2

// --- Transforms ----------------------------------------------------------------------

/**
 * Applies a similarity transform (move, rotate, mirror, uniform scale). Circles and arcs would not
 * stay circular under a non-uniform scale, so those transforms are not supported here.
 */
export function transform(g: Geometry, m: Matrix4): Geometry {
  const linear = new Matrix3().setFromMatrix4(m)
  const point = (p: Vector3) => p.clone().applyMatrix4(m)
  switch (g.type) {
    case 'polyline':
      return { ...g, points: g.points.map(point) }
    case 'circle':
    case 'arc': {
      const x = g.xaxis.clone().applyMatrix3(linear)
      const y = g.yaxis.clone().applyMatrix3(linear)
      return { ...g, center: point(g.center), radius: g.radius * x.length(), xaxis: x.normalize(), yaxis: y.normalize() }
    }
    case 'curve':
      return { ...g, points: g.points.map(point) }
    case 'polycurve':
      return { type: 'polycurve', segments: g.segments.map((s) => transform(s, m) as SegmentGeometry) }
  }
}

export function translate(g: Geometry, delta: Vector3): Geometry {
  return transform(g, new Matrix4().makeTranslation(delta.x, delta.y, delta.z))
}

/** Same curve, opposite direction. */
export function reverse<G extends Geometry>(g: G): G
export function reverse(g: Geometry): Geometry {
  switch (g.type) {
    case 'polyline':
      return { ...g, points: [...g.points].reverse() }
    case 'circle':
      return { ...g, yaxis: g.yaxis.clone().negate() }
    case 'arc': {
      // Start where the arc used to end and turn the other way.
      const c = Math.cos(g.angle)
      const s = Math.sin(g.angle)
      const xaxis = g.xaxis.clone().multiplyScalar(c).addScaledVector(g.yaxis, s)
      const yaxis = g.xaxis.clone().multiplyScalar(s).addScaledVector(g.yaxis, -c)
      return { ...g, xaxis, yaxis }
    }
    case 'curve':
      return { type: 'curve', ...reverseBSpline(g) }
    case 'polycurve':
      return { type: 'polycurve', segments: [...g.segments].reverse().map((s) => reverse(s)) }
  }
}

// --- Pieces --------------------------------------------------------------------------

function rotatedArc(c: CircleGeometry | ArcGeometry, start: number, angle: number): ArcGeometry {
  const cs = Math.cos(start)
  const sn = Math.sin(start)
  return {
    type: 'arc',
    center: c.center.clone(),
    radius: c.radius,
    xaxis: c.xaxis.clone().multiplyScalar(cs).addScaledVector(c.yaxis, sn),
    yaxis: c.yaxis.clone().multiplyScalar(cs).addScaledVector(c.xaxis, -sn),
    angle,
  }
}

function subCurveOfSpline(g: CurveGeometry, t0: number, t1: number): CurveGeometry {
  let piece: CurveGeometry = g
  const right = splitBSpline(piece, t0)
  if (right) piece = { type: 'curve', ...right[1] }
  const left = splitBSpline(piece, t1)
  if (left) piece = { type: 'curve', ...left[0] }
  return piece
}

/** The part of an open interval [t0, t1] of the curve, with t0 < t1. */
function openPiece(g: Geometry, t0: number, t1: number): Geometry | null {
  if (t1 - t0 <= 1e-12) return null
  switch (g.type) {
    case 'polyline': {
      const n = g.points.length
      const points = [pointAt(g, t0)]
      for (let i = Math.floor(t0) + 1; i < t1; i++) points.push(g.points[i % n].clone())
      points.push(pointAt(g, t1))
      const clean = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-12)
      return clean.length >= 2 ? { type: 'polyline', points: clean, closed: false } : null
    }
    case 'circle':
    case 'arc':
      return rotatedArc(g, t0, t1 - t0)
    case 'curve':
      return subCurveOfSpline(g, t0, t1)
    case 'polycurve': {
      let [i0, s0] = segmentParam(g, t0)
      let [i1, s1] = segmentParam(g, t1)
      // A parameter on a segment boundary belongs to the end of the earlier segment.
      if (i1 > i0 && t1 - Math.floor(t1) < 1e-12) {
        i1 = Math.round(t1) - 1
        s1 = domain(g.segments[i1])[1]
      }
      if (i0 < i1 && Math.abs(s0 - domain(g.segments[i0])[1]) < 1e-12) {
        i0++
        s0 = domain(g.segments[i0])[0]
      }
      const pieces: (Geometry | null)[] = []
      if (i0 === i1) pieces.push(openPiece(g.segments[i0], s0, s1))
      else {
        pieces.push(openPiece(g.segments[i0], s0, domain(g.segments[i0])[1]))
        for (let i = i0 + 1; i < i1; i++) pieces.push(g.segments[i])
        pieces.push(openPiece(g.segments[i1], domain(g.segments[i1])[0], s1))
      }
      return chain(pieces.filter((p): p is Geometry => p !== null))
    }
  }
}

/**
 * The part of the curve from t0 to t1. On a closed curve, t0 >= t1 means the piece that runs
 * through the seam.
 */
export function subCurve(g: Geometry, t0: number, t1: number): Geometry | null {
  const [d0, d1] = domain(g)
  if (t0 < t1 || !isClosed(g)) return openPiece(g, Math.max(d0, t0), Math.min(d1, t1))
  if (g.type === 'circle') return rotatedArc(g, t0, TWO_PI - t0 + t1)
  const pieces = [openPiece(g, t0, d1), openPiece(g, d0, t1)].filter((p): p is Geometry => p !== null)
  return chain(pieces)
}

/** Cuts the curve at the given parameters. A closed curve cut at n points gives n pieces. */
export function split(g: Geometry, params: number[]): Geometry[] {
  const [d0, d1] = domain(g)
  const eps = (d1 - d0) * 1e-9
  const closed = isClosed(g)
  const cuts = params
    .map((t) => (closed && t >= d1 - eps ? d0 : t))
    .filter((t) => (closed ? t >= d0 - eps : t > d0 + eps && t < d1 - eps))
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - all[i - 1] > eps)

  if (cuts.length === 0) return [g]
  const pieces: (Geometry | null)[] = []
  if (closed) {
    for (let i = 0; i < cuts.length - 1; i++) pieces.push(subCurve(g, cuts[i], cuts[i + 1]))
    pieces.push(subCurve(g, cuts[cuts.length - 1], cuts[0]))
  } else {
    const bounds = [d0, ...cuts, d1]
    for (let i = 0; i < bounds.length - 1; i++) pieces.push(openPiece(g, bounds[i], bounds[i + 1]))
  }
  return pieces.filter((p): p is Geometry => p !== null)
}

/** Flattens curves into their segments, with polylines broken into lines. */
export function explode(g: Geometry): Geometry[] {
  switch (g.type) {
    case 'polyline': {
      if (g.points.length === 2 && !g.closed) return [g]
      const lines: Geometry[] = []
      const n = g.points.length
      for (let i = 0; i < (g.closed ? n : n - 1); i++) {
        lines.push({ type: 'polyline', points: [g.points[i].clone(), g.points[(i + 1) % n].clone()], closed: false })
      }
      return lines
    }
    case 'polycurve':
      return g.segments.flatMap((s) => explode(s))
    default:
      return [g]
  }
}

/**
 * Concatenates curves that already connect end to start, in order. Lines and polylines merge into
 * one polyline; anything else gives a polycurve. Returns null for an empty list.
 */
export function chain(pieces: Geometry[]): Geometry | null {
  const segments: SegmentGeometry[] = []
  for (const piece of pieces) {
    if (piece.type === 'polycurve') segments.push(...piece.segments)
    else if (piece.type === 'circle') return null
    else if (piece.type === 'polyline' && piece.closed) segments.push({ ...piece, points: [...piece.points, piece.points[0]], closed: false })
    else segments.push(piece)
  }
  if (segments.length === 0) return null
  if (segments.length === 1) return segments[0]

  if (segments.every((s) => s.type === 'polyline')) {
    const points: Vector3[] = []
    for (const s of segments as PolylineGeometry[]) {
      for (const p of s.points) if (points.length === 0 || p.distanceTo(points[points.length - 1]) > 1e-12) points.push(p.clone())
    }
    const closed = points.length > 3 && points[0].distanceTo(points[points.length - 1]) < TOLERANCE
    if (closed) points.pop()
    return { type: 'polyline', points, closed }
  }
  return { type: 'polycurve', segments }
}

/**
 * Joins curves whose ends meet into chains. Returns one entry per chain, with the indices of the
 * input curves it used; curves that join nothing come back alone.
 */
export function join(curves: Geometry[], tolerance = TOLERANCE): { geometry: Geometry; used: number[] }[] {
  const used = new Set<number>()
  const result: { geometry: Geometry; used: number[] }[] = []
  const near = (a: Vector3, b: Vector3) => a.distanceTo(b) <= tolerance

  for (let seed = 0; seed < curves.length; seed++) {
    if (used.has(seed)) continue
    used.add(seed)
    if (isClosed(curves[seed])) {
      result.push({ geometry: curves[seed], used: [seed] })
      continue
    }
    let pieces: Geometry[] = [curves[seed]]
    const members = [seed]
    let grew = true
    while (grew) {
      grew = false
      const head = startPoint(pieces[0])
      const tail = endPoint(pieces[pieces.length - 1])
      if (near(head, tail) && pieces.length > 1) break
      for (let i = 0; i < curves.length; i++) {
        if (used.has(i) || isClosed(curves[i])) continue
        const c = curves[i]
        let attached: 'tail' | 'head' | null = null
        if (near(startPoint(c), tail)) (pieces = [...pieces, c]), (attached = 'tail')
        else if (near(endPoint(c), tail)) (pieces = [...pieces, reverse(c)]), (attached = 'tail')
        else if (near(endPoint(c), head)) (pieces = [c, ...pieces]), (attached = 'head')
        else if (near(startPoint(c), head)) (pieces = [reverse(c), ...pieces]), (attached = 'head')
        if (attached) {
          used.add(i)
          members.push(i)
          grew = true
          break
        }
      }
    }
    // Snap the small gaps the tolerance allowed, so the result is exactly connected.
    const joined = chain(pieces.map((p, i) => (i === 0 ? p : snapStart(p, endPoint(pieces[i - 1])))))
    result.push({ geometry: joined ?? curves[seed], used: members })
  }
  return result
}

/** Moves the start of a curve onto `point` (for closing tolerance-sized gaps). */
function snapStart(g: Geometry, point: Vector3): Geometry {
  if (g.type === 'polyline') return { ...g, points: [point.clone(), ...g.points.slice(1)] }
  if (g.type === 'curve') return { ...g, points: [point.clone(), ...g.points.slice(1)] }
  return g
}

// --- Measurement ---------------------------------------------------------------------

export function length(g: Geometry): number {
  switch (g.type) {
    case 'circle':
      return TWO_PI * g.radius
    case 'arc':
      return g.angle * g.radius
    case 'polyline': {
      const pts = samples(g).points
      let total = 0
      for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1])
      return total
    }
    case 'curve': {
      const [t0, t1] = domain(g)
      const steps = 64 * Math.max(1, g.points.length - g.degree)
      let total = 0
      let prev = pointAt(g, t0)
      for (let i = 1; i <= steps; i++) {
        const p = pointAt(g, t0 + ((t1 - t0) * i) / steps)
        total += p.distanceTo(prev)
        prev = p
      }
      return total
    }
    case 'polycurve':
      return g.segments.reduce((sum, s) => sum + length(s), 0)
  }
}

export interface CurvePoint {
  t: number
  point: Vector3
  distance: number
}

/** Closest point of the curve to p, refined from the display samples. */
export function closestPoint(g: Geometry, p: Vector3): CurvePoint {
  const { points, params } = samples(g)
  let best = Infinity
  let index = 0
  let fraction = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const ab = points[i].clone().sub(a)
    const len2 = ab.lengthSq()
    const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / len2))
    const d = a.clone().addScaledVector(ab, f).distanceTo(p)
    if (d < best) {
      best = d
      index = i
      fraction = f
    }
  }
  if (points.length < 2) return { t: params[0] ?? 0, point: points[0]?.clone() ?? new Vector3(), distance: points[0]?.distanceTo(p) ?? Infinity }

  let t = params[index - 1] + (params[index] - params[index - 1]) * fraction
  if (g.type !== 'polyline') {
    // Golden-section search around the sampled answer.
    let lo = params[Math.max(0, index - 2)]
    let hi = params[Math.min(params.length - 1, index + 1)]
    const f = (s: number) => pointAt(g, s).distanceToSquared(p)
    const r = (Math.sqrt(5) - 1) / 2
    let x1 = hi - r * (hi - lo)
    let x2 = lo + r * (hi - lo)
    let f1 = f(x1)
    let f2 = f(x2)
    for (let i = 0; i < 60; i++) {
      if (f1 < f2) {
        hi = x2
        x2 = x1
        f2 = f1
        x1 = hi - r * (hi - lo)
        f1 = f(x1)
      } else {
        lo = x1
        x1 = x2
        f1 = f2
        x2 = lo + r * (hi - lo)
        f2 = f(x2)
      }
    }
    const refined = (lo + hi) / 2
    if (f(refined) < f(t)) t = refined
  }
  const point = pointAt(g, t)
  return { t, point, distance: point.distanceTo(p) }
}
