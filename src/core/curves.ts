import { Matrix3, Matrix4, Vector3 } from 'three'
import { clampedKnots, interpolate, reverseBSpline, splitBSpline } from '../math/nurbs'
import {
  AnnotationGeometry,
  AnyCurve,
  HatchGeometry,
  InstanceGeometry,
  ArcGeometry,
  BrepGeometry,
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

/** True when the matrix keeps angles and only scales uniformly (move, rotate, mirror, uniform scale). */
export function isSimilarity(m: Matrix4): boolean {
  const e = m.elements
  const x = new Vector3(e[0], e[1], e[2])
  const y = new Vector3(e[4], e[5], e[6])
  const z = new Vector3(e[8], e[9], e[10])
  const s = x.lengthSq()
  const eps = 1e-9 * Math.max(1, s)
  return Math.abs(y.lengthSq() - s) < eps && Math.abs(z.lengthSq() - s) < eps && Math.abs(x.dot(y)) < eps && Math.abs(y.dot(z)) < eps && Math.abs(x.dot(z)) < eps
}

/** A cubic curve through points of a circle or arc, for transforms that would not keep it circular. */
function arcAsCurve(g: CircleGeometry | ArcGeometry): CurveGeometry {
  const sweep = g.type === 'circle' ? TWO_PI : g.angle
  const count = Math.max(8, Math.ceil((48 * sweep) / TWO_PI))
  const pts: Vector3[] = []
  for (let i = 0; i <= count; i++) pts.push(pointAt(g, (sweep * i) / count))
  return { type: 'curve', ...interpolate(pts, 3) }
}

/**
 * Applies an affine transform. Under a non-uniform scale, circles and arcs cannot stay circular, so
 * they become (closely approximating) curves.
 */
export function transform<G extends Geometry>(
  g: G,
  m: Matrix4,
): G extends BrepGeometry
  ? BrepGeometry
  : G extends AnnotationGeometry
    ? AnnotationGeometry
    : G extends HatchGeometry
      ? HatchGeometry
      : G extends InstanceGeometry
        ? InstanceGeometry
        : AnyCurve
export function transform(g: Geometry, m: Matrix4): Geometry {
  if (g.type === 'brep') return transformBrep(g, m)
  const linear = new Matrix3().setFromMatrix4(m)
  if (g.type === 'annotation') return transformAnnotation(g, m, linear)
  if (g.type === 'instance') return { ...g, matrix: m.clone().multiply(new Matrix4().fromArray(g.matrix)).toArray() }
  if (g.type === 'hatch') {
    const x = g.xaxis.clone().applyMatrix3(linear)
    const y = g.yaxis.clone().applyMatrix3(linear)
    const scale = Math.sqrt(x.length() * y.length())
    x.normalize()
    y.addScaledVector(x, -y.dot(x)).normalize()
    return {
      ...g,
      loops: g.loops.map((loop) => transform(loop, m)),
      origin: g.origin.clone().applyMatrix4(m),
      xaxis: x,
      yaxis: y,
      scale: g.scale * scale,
    }
  }
  const point = (p: Vector3) => p.clone().applyMatrix4(m)
  switch (g.type) {
    case 'polyline':
      return { ...g, points: g.points.map(point) }
    case 'circle':
    case 'arc': {
      if (!isSimilarity(m)) return transform(arcAsCurve(g), m)
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

/**
 * Moves the defining points and turns the annotation's plane with them. Text keeps reading
 * forwards after a mirror, and its height follows the scale.
 */
function transformAnnotation(g: AnnotationGeometry, m: Matrix4, linear: Matrix3): AnnotationGeometry {
  const x = g.xaxis.clone().applyMatrix3(linear)
  const y = g.yaxis.clone().applyMatrix3(linear)
  const scale = Math.sqrt(x.length() * y.length())
  x.normalize()
  y.addScaledVector(x, -y.dot(x)).normalize()
  if (linear.determinant() < 0) x.negate()
  return { ...g, points: g.points.map((p) => p.clone().applyMatrix4(m)), xaxis: x, yaxis: y, height: g.height * scale }
}

/** Records the transform on the brep and moves its display data; the exact shape is updated lazily. */
function transformBrep(g: BrepGeometry, m: Matrix4): BrepGeometry {
  const matrix = g.matrix ? m.clone().multiply(new Matrix4().fromArray(g.matrix)) : m.clone()
  const normalMatrix = new Matrix3().getNormalMatrix(m)
  const p = new Vector3()
  const mapPoints = (flat: number[], apply: (v: Vector3) => Vector3) => {
    const out = new Array<number>(flat.length)
    for (let i = 0; i < flat.length; i += 3) {
      apply(p.set(flat[i], flat[i + 1], flat[i + 2]))
      out[i] = p.x
      out[i + 1] = p.y
      out[i + 2] = p.z
    }
    return out
  }
  const toWorld = (v: Vector3) => v.applyMatrix4(m)
  const toNormal = (v: Vector3) => v.applyMatrix3(normalMatrix).normalize()
  // A mirror flips the winding of the triangles, so they are reversed to keep facing outwards.
  const flips = m.determinant() < 0
  const triangles = flips ? g.display.triangles.map((_, i, t) => t[i - (i % 3) + 2 - (i % 3)]) : g.display.triangles
  return {
    ...g,
    matrix: matrix.toArray(),
    display: {
      vertices: mapPoints(g.display.vertices, toWorld),
      normals: mapPoints(g.display.normals, toNormal),
      triangles,
      edges: g.display.edges.map((e) => mapPoints(e, toWorld)),
      faceTriangles: g.display.faceTriangles,
    },
  }
}

export function translate<G extends Geometry>(g: G, delta: Vector3): G extends BrepGeometry ? BrepGeometry : AnyCurve
export function translate(g: Geometry, delta: Vector3): Geometry {
  return transform(g, new Matrix4().makeTranslation(delta.x, delta.y, delta.z))
}

/** Same curve, opposite direction. */
export function reverse<G extends AnyCurve>(g: G): G
export function reverse(g: AnyCurve): AnyCurve {
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
function openPiece(g: AnyCurve, t0: number, t1: number): AnyCurve | null {
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
      const pieces: (AnyCurve | null)[] = []
      if (i0 === i1) pieces.push(openPiece(g.segments[i0], s0, s1))
      else {
        pieces.push(openPiece(g.segments[i0], s0, domain(g.segments[i0])[1]))
        for (let i = i0 + 1; i < i1; i++) pieces.push(g.segments[i])
        pieces.push(openPiece(g.segments[i1], domain(g.segments[i1])[0], s1))
      }
      return chain(pieces.filter((p): p is AnyCurve => p !== null))
    }
  }
}

/**
 * The part of the curve from t0 to t1. On a closed curve, t0 >= t1 means the piece that runs
 * through the seam.
 */
export function subCurve(g: AnyCurve, t0: number, t1: number): AnyCurve | null {
  const [d0, d1] = domain(g)
  if (t0 < t1 || !isClosed(g)) return openPiece(g, Math.max(d0, t0), Math.min(d1, t1))
  if (g.type === 'circle') return rotatedArc(g, t0, TWO_PI - t0 + t1)
  const pieces = [openPiece(g, t0, d1), openPiece(g, d0, t1)].filter((p): p is AnyCurve => p !== null)
  return chain(pieces)
}

/** Cuts the curve at the given parameters. A closed curve cut at n points gives n pieces. */
export function split(g: AnyCurve, params: number[]): AnyCurve[] {
  const [d0, d1] = domain(g)
  const eps = (d1 - d0) * 1e-9
  const closed = isClosed(g)
  const cuts = params
    .map((t) => (closed && t >= d1 - eps ? d0 : t))
    .filter((t) => (closed ? t >= d0 - eps : t > d0 + eps && t < d1 - eps))
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - all[i - 1] > eps)

  if (cuts.length === 0) return [g]
  const pieces: (AnyCurve | null)[] = []
  if (closed) {
    for (let i = 0; i < cuts.length - 1; i++) pieces.push(subCurve(g, cuts[i], cuts[i + 1]))
    pieces.push(subCurve(g, cuts[cuts.length - 1], cuts[0]))
  } else {
    const bounds = [d0, ...cuts, d1]
    for (let i = 0; i < bounds.length - 1; i++) pieces.push(openPiece(g, bounds[i], bounds[i + 1]))
  }
  return pieces.filter((p): p is AnyCurve => p !== null)
}

/** Flattens curves into their segments, with polylines broken into lines. */
export function explode(g: AnyCurve): AnyCurve[] {
  switch (g.type) {
    case 'polyline': {
      if (g.points.length === 2 && !g.closed) return [g]
      const lines: AnyCurve[] = []
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
export function chain(pieces: AnyCurve[]): AnyCurve | null {
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
export function join(curves: AnyCurve[], tolerance = TOLERANCE): { geometry: AnyCurve; used: number[] }[] {
  const used = new Set<number>()
  const result: { geometry: AnyCurve; used: number[] }[] = []
  const near = (a: Vector3, b: Vector3) => a.distanceTo(b) <= tolerance

  for (let seed = 0; seed < curves.length; seed++) {
    if (used.has(seed)) continue
    used.add(seed)
    if (isClosed(curves[seed])) {
      result.push({ geometry: curves[seed], used: [seed] })
      continue
    }
    let pieces: AnyCurve[] = [curves[seed]]
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
function snapStart(g: AnyCurve, point: Vector3): AnyCurve {
  if (g.type === 'polyline') return { ...g, points: [point.clone(), ...g.points.slice(1)] }
  if (g.type === 'curve') return { ...g, points: [point.clone(), ...g.points.slice(1)] }
  return g
}

// --- Measurement ---------------------------------------------------------------------

export function length(g: AnyCurve): number {
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
export function closestPoint(g: AnyCurve, p: Vector3): CurvePoint {
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

// --- Control points ------------------------------------------------------------------

/** The points that define a polyline or curve, which the user can edit directly. Null for other types. */
export function controlPoints(g: Geometry): Vector3[] | null {
  return g.type === 'polyline' || g.type === 'curve' || g.type === 'annotation' ? g.points : null
}

/** The same polyline or curve with new control points (same count). */
export function withControlPoints(g: Geometry, points: Vector3[]): Geometry {
  if (g.type === 'polyline' || g.type === 'curve' || g.type === 'annotation') return { ...g, points }
  return g
}

/** Removes control points, or returns null if too few would be left. */
export function removeControlPoints(g: Geometry, indices: Set<number>): Geometry | null {
  if (g.type !== 'polyline' && g.type !== 'curve') return null
  const points = g.points.filter((_, i) => !indices.has(i))
  if (g.type === 'polyline') {
    if (points.length < 2) return null
    return { ...g, points, closed: g.closed && points.length > 2 }
  }
  if (points.length < 2) return null
  // Fewer points may force a lower degree; the knots become uniform again.
  const degree = Math.min(g.degree, points.length - 1)
  return { type: 'curve', degree, points, knots: clampedKnots(points.length, degree) }
}

// --- Circles through points ------------------------------------------------------------

/** Center of the circle through three points, and the normal of their plane; null if collinear. */
function circleCenter(p1: Vector3, p2: Vector3, p3: Vector3): { center: Vector3; normal: Vector3 } | null {
  const a = p1.clone().sub(p3)
  const b = p2.clone().sub(p3)
  const axb = a.clone().cross(b)
  const d = 2 * axb.lengthSq()
  if (d < 1e-24) return null
  const num = b.clone().multiplyScalar(a.lengthSq()).sub(a.clone().multiplyScalar(b.lengthSq())).cross(axb)
  return { center: p3.clone().add(num.divideScalar(d)), normal: axb.normalize() }
}

/** The circle through three points (starting at the first), or null if they are collinear. */
export function circleThrough(p1: Vector3, p2: Vector3, p3: Vector3): CircleGeometry | null {
  const c = circleCenter(p1, p2, p3)
  if (!c) return null
  const xaxis = p1.clone().sub(c.center)
  const radius = xaxis.length()
  xaxis.normalize()
  return { type: 'circle', center: c.center, xaxis, yaxis: c.normal.clone().cross(xaxis).normalize(), radius }
}

/** The arc from `start` through `through` to `end`, or null if the points are collinear. */
export function arcThrough(start: Vector3, through: Vector3, end: Vector3): ArcGeometry | null {
  const circle = circleThrough(start, through, end)
  if (!circle) return null
  const angleOf = (p: Vector3, y: Vector3) => {
    const d = p.clone().sub(circle.center)
    const t = Math.atan2(d.dot(y), d.dot(circle.xaxis))
    return t < 0 ? t + TWO_PI : t
  }
  let yaxis = circle.yaxis
  // Turn the way that passes through the middle point.
  if (angleOf(through, yaxis) > angleOf(end, yaxis)) yaxis = yaxis.clone().negate()
  return { type: 'arc', center: circle.center, xaxis: circle.xaxis, yaxis, radius: circle.radius, angle: angleOf(end, yaxis) }
}
