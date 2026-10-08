import { Box3, Vector3 } from 'three'
import { clampedKnots, evalBSpline } from '../math/nurbs'

export interface Plane {
  origin: Vector3
  xaxis: Vector3
  yaxis: Vector3
  normal: Vector3
}

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

/** Control-point B-spline curve with a clamped uniform knot vector. */
export interface CurveGeometry {
  type: 'curve'
  degree: number
  points: Vector3[]
}

// Geometry values are immutable: edits produce a new value, which keeps the caches below valid.
export type Geometry = PolylineGeometry | CircleGeometry | CurveGeometry

export interface SnapPoints {
  end: Vector3[]
  mid: Vector3[]
  cen: Vector3[]
  quad: Vector3[]
}

const CIRCLE_SEGMENTS = 96
const SAMPLES_PER_SPAN = 16

const tessellationCache = new WeakMap<Geometry, Vector3[]>()
const snapCache = new WeakMap<Geometry, SnapPoints>()

function circlePoint(c: CircleGeometry, angle: number): Vector3 {
  return c.center
    .clone()
    .addScaledVector(c.xaxis, c.radius * Math.cos(angle))
    .addScaledVector(c.yaxis, c.radius * Math.sin(angle))
}

function curveDegree(c: CurveGeometry): number {
  return Math.min(c.degree, c.points.length - 1)
}

function buildTessellation(g: Geometry): Vector3[] {
  switch (g.type) {
    case 'polyline':
      return g.closed && g.points.length > 2 ? [...g.points, g.points[0]] : g.points
    case 'circle': {
      const pts: Vector3[] = []
      for (let i = 0; i <= CIRCLE_SEGMENTS; i++) pts.push(circlePoint(g, (i / CIRCLE_SEGMENTS) * Math.PI * 2))
      return pts
    }
    case 'curve': {
      if (g.points.length < 2) return g.points
      const degree = curveDegree(g)
      const knots = clampedKnots(g.points.length, degree)
      const tmax = g.points.length - degree
      const samples = tmax * SAMPLES_PER_SPAN
      const pts: Vector3[] = []
      for (let i = 0; i <= samples; i++) pts.push(evalBSpline(g.points, degree, knots, (tmax * i) / samples))
      return pts
    }
  }
}

/** Display polyline for a geometry. The result is cached and must not be mutated. */
export function tessellate(g: Geometry): Vector3[] {
  let pts = tessellationCache.get(g)
  if (!pts) {
    pts = buildTessellation(g)
    tessellationCache.set(g, pts)
  }
  return pts
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
    case 'curve': {
      if (g.points.length < 2) break
      const degree = curveDegree(g)
      const knots = clampedKnots(g.points.length, degree)
      snaps.end = [g.points[0], g.points[g.points.length - 1]]
      snaps.mid = [evalBSpline(g.points, degree, knots, (g.points.length - degree) / 2)]
      break
    }
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

export function translate(g: Geometry, delta: Vector3): Geometry {
  switch (g.type) {
    case 'polyline':
      return { ...g, points: g.points.map((p) => p.clone().add(delta)) }
    case 'circle':
      return { ...g, center: g.center.clone().add(delta) }
    case 'curve':
      return { ...g, points: g.points.map((p) => p.clone().add(delta)) }
  }
}

export function expandBox(box: Box3, g: Geometry): void {
  for (const p of tessellate(g)) box.expandByPoint(p)
}

export function typeName(g: Geometry): string {
  if (g.type === 'polyline') return g.points.length === 2 ? 'line' : 'polyline'
  return g.type
}

type Triple = [number, number, number]

const toTriple = (v: Vector3): Triple => [v.x, v.y, v.z]
const fromTriple = (t: Triple): Vector3 => new Vector3(t[0], t[1], t[2])

export function geometryToJSON(g: Geometry): unknown {
  switch (g.type) {
    case 'polyline':
      return { type: g.type, points: g.points.map(toTriple), closed: g.closed }
    case 'circle':
      return {
        type: g.type,
        center: toTriple(g.center),
        xaxis: toTriple(g.xaxis),
        yaxis: toTriple(g.yaxis),
        radius: g.radius,
      }
    case 'curve':
      return { type: g.type, degree: g.degree, points: g.points.map(toTriple) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geometryFromJSON(j: any): Geometry {
  switch (j.type) {
    case 'polyline':
      return { type: 'polyline', points: j.points.map(fromTriple), closed: !!j.closed }
    case 'circle':
      return {
        type: 'circle',
        center: fromTriple(j.center),
        xaxis: fromTriple(j.xaxis),
        yaxis: fromTriple(j.yaxis),
        radius: j.radius,
      }
    case 'curve':
      return { type: 'curve', degree: j.degree, points: j.points.map(fromTriple) }
    default:
      throw new Error(`Unknown geometry type: ${j.type}`)
  }
}
