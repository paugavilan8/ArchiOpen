import { Vector3 } from 'three'
import { closestPoint, length } from './curves'
import { atLengths } from './curveTools'
import { domain, isClosed, pointAt, tessellate, type AnyCurve, type Geometry, type MeshGeometry } from './geometry'
import { approximate } from '../math/nurbs'

/**
 * Deformations as Rhino has them: Twist, Taper, Bend and Flow (along a curve). Each is a mapping of
 * points, described by data (so it can be sent to the kernel's worker, which deforms surfaces and
 * solids with it, refining their NURBS so they follow it closely). Curves are sampled, deformed and
 * fitted again; meshes and points have their points moved.
 */

export type Deformation =
  | { kind: 'twist'; start: Vector3; end: Vector3; angle: number; infinite: boolean }
  | { kind: 'taper'; start: Vector3; end: Vector3; startScale: number; endScale: number; infinite: boolean }
  | { kind: 'bend'; start: Vector3; end: Vector3; toward: Vector3; angle: number }
  | { kind: 'flow'; base: AnyCurve; target: AnyCurve; stretch: boolean; up: Vector3 }
  /**
   * CageEdit: a box (`min` to `max`) with a grid of `counts` points across it in x, y and z, where
   * they are now (x fastest, then y, then z). Space follows the points as a Bézier volume: with the
   * points where the grid put them, nothing moves.
   */
  | { kind: 'cage'; min: Vector3; max: Vector3; counts: [number, number, number]; points: Vector3[] }

/** Where a point is along an axis: 0 at its start, 1 at its end (held to that range unless infinite). */
function along(start: Vector3, end: Vector3, p: Vector3, infinite: boolean): { t: number; foot: Vector3; axis: Vector3 } {
  const axis = end.clone().sub(start)
  const l2 = axis.lengthSq()
  const raw = l2 > 0 ? p.clone().sub(start).dot(axis) / l2 : 0
  const foot = start.clone().addScaledVector(axis, raw)
  return { t: infinite ? raw : Math.min(1, Math.max(0, raw)), foot, axis: axis.normalize() }
}

/** A frame along a curve at a length: point, tangent, and two normals (`up` kept as near upright as can be). */
function frameAt(curve: AnyCurve, s: number, up: Vector3) {
  const { points, tangents } = atLengths(curve, [s])
  const t = tangents[0].clone().normalize()
  let n = new Vector3().crossVectors(up, t)
  if (n.lengthSq() < 1e-12) n = new Vector3().crossVectors(new Vector3(1, 0, 0), t)
  if (n.lengthSq() < 1e-12) n = new Vector3().crossVectors(new Vector3(0, 1, 0), t)
  n.normalize()
  const b = new Vector3().crossVectors(t, n)
  return { point: points[0], t, n, b }
}

/** The mapping of points a deformation is. */
export function pointMap(d: Deformation): (p: Vector3) => Vector3 {
  switch (d.kind) {
    case 'twist':
      return (p) => {
        const { t, foot, axis } = along(d.start, d.end, p, d.infinite)
        return p.clone().sub(foot).applyAxisAngle(axis, d.angle * t).add(foot)
      }
    case 'taper':
      return (p) => {
        const { t, foot } = along(d.start, d.end, p, d.infinite)
        const k = d.startScale + (d.endScale - d.startScale) * t
        return foot.clone().add(p.clone().sub(foot).multiplyScalar(k))
      }
    case 'bend': {
      // The axis becomes an arc of the same length turning by `angle` toward `toward`; past its end
      // the rest goes on straight.
      const axis = d.end.clone().sub(d.start)
      const L = axis.length()
      const a = axis.clone().normalize()
      const side = d.toward.clone().sub(d.start)
      side.addScaledVector(a, -side.dot(a))
      if (side.lengthSq() < 1e-12 || Math.abs(d.angle) < 1e-9 || L < 1e-12) return (p) => p.clone()
      side.normalize()
      const w = new Vector3().crossVectors(a, side)
      const R = L / d.angle
      return (p) => {
        const r = p.clone().sub(d.start)
        const s = r.dot(a)
        const u = r.dot(side)
        const v = r.dot(w)
        const th = Math.min(Math.max(s, 0), L) / R
        const radius = R - u
        const centre = d.start.clone().addScaledVector(side, R)
        const onArc = centre.clone().addScaledVector(side, -radius * Math.cos(th)).addScaledVector(a, radius * Math.sin(th)).addScaledVector(w, v)
        // Before the start, straight on; after the end, straight on along the arc's end.
        if (s < 0) return onArc.addScaledVector(a, s)
        if (s > L) return onArc.addScaledVector(a.clone().multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th)), s - L)
        return onArc
      }
    }
    case 'cage': {
      const [nu, nv, nw] = d.counts
      const size = d.max.clone().sub(d.min)
      const bern = (n: number, t: number) => {
        // Bernstein polynomials of degree n - 1.
        const out = new Array<number>(n).fill(0)
        if (n === 1) return [1]
        out[0] = 1
        for (let k = 1; k < n; k++) {
          for (let i = k; i > 0; i--) out[i] = out[i] * (1 - t) + out[i - 1] * t
          out[0] *= 1 - t
        }
        return out
      }
      const at = (lo: number, extent: number, x: number) => (extent > 0 ? (x - lo) / extent : 0)
      return (p) => {
        const [bu, bv, bw] = [bern(nu, at(d.min.x, size.x, p.x)), bern(nv, at(d.min.y, size.y, p.y)), bern(nw, at(d.min.z, size.z, p.z))]
        const out = new Vector3()
        for (let k = 0; k < nw; k++)
          for (let j = 0; j < nv; j++)
            for (let i = 0; i < nu; i++) out.addScaledVector(d.points[i + nu * (j + nv * k)], bu[i] * bv[j] * bw[k])
        return out
      }
    }
    case 'flow': {
      const [lb, lt] = [length(d.base), length(d.target)]
      return (p) => {
        const c = closestPoint(d.base, p)
        const [t0] = domain(d.base)
        const s = c.t <= t0 ? 0 : arcLength(d.base, c.t)
        const f = frameAt(d.base, s, d.up)
        const r = p.clone().sub(f.point)
        const [x, y, z] = [r.dot(f.t), r.dot(f.n), r.dot(f.b)]
        const target = d.stretch ? (s / (lb || 1)) * lt : Math.min(s, lt)
        const g = frameAt(d.target, target, d.up)
        return g.point.clone().addScaledVector(g.t, x).addScaledVector(g.n, y).addScaledVector(g.b, z)
      }
    }
  }
}

/** The length of a curve from its start to a parameter. */
function arcLength(g: AnyCurve, t: number): number {
  const { points, params } = sampled(g)
  let s = 0
  for (let i = 1; i < points.length; i++) {
    if (params[i] >= t) {
      const f = (t - params[i - 1]) / (params[i] - params[i - 1] || 1)
      return s + points[i].distanceTo(points[i - 1]) * f
    }
    s += points[i].distanceTo(points[i - 1])
  }
  return s
}

const sampledCache = new WeakMap<AnyCurve, { points: Vector3[]; params: number[] }>()
function sampled(g: AnyCurve) {
  let s = sampledCache.get(g)
  if (!s) {
    const [t0, t1] = domain(g)
    const n = 2000
    const params = Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n)
    s = { params, points: params.map((t) => pointAt(g, t)) }
    sampledCache.set(g, s)
  }
  return s
}


/**
 * A curve deformed: sampled finely, its points moved, and a smooth curve fitted through them (a
 * polyline keeps its corners: each side is sampled and the corners kept).
 */
export function deformCurve(g: AnyCurve, map: (p: Vector3) => Vector3): AnyCurve {
  const pts = tessellate(g)
  // Enough samples for the deformation to show, without losing the shape.
  const dense: Vector3[] = []
  for (let i = 0; i < pts.length; i++) {
    dense.push(pts[i])
    if (i + 1 < pts.length) for (let k = 1; k < 8; k++) dense.push(pts[i].clone().lerp(pts[i + 1], k / 8))
  }
  const moved = dense.map(map)
  if (g.type === 'polyline' && g.points.length <= 2 && moved.length <= 2) return { type: 'polyline', points: moved, closed: false }
  const closed = isClosed(g)
  if (closed && moved.length > 2 && moved[0].distanceTo(moved[moved.length - 1]) > 1e-9) moved.push(moved[0].clone())
  const fitted = approximate(moved, Math.min(moved.length, Math.max(16, Math.round(moved.length / 4))), 3)
  return { type: 'curve', ...fitted }
}

/** Points, curves and meshes deformed here; surfaces and solids go to the kernel (null). */
export function deformGeometry(g: Geometry, map: (p: Vector3) => Vector3): Geometry | null {
  switch (g.type) {
    case 'point':
      return { ...g, point: map(g.point) }
    case 'mesh': {
      const vertices = [...g.vertices]
      for (let i = 0; i < vertices.length; i += 3) {
        const q = map(new Vector3(vertices[i], vertices[i + 1], vertices[i + 2]))
        vertices[i] = q.x
        vertices[i + 1] = q.y
        vertices[i + 2] = q.z
      }
      return { ...g, vertices } satisfies MeshGeometry
    }
    case 'polyline':
    case 'circle':
    case 'arc':
    case 'curve':
    case 'polycurve':
      return deformCurve(g, map)
    default:
      return null
  }
}
