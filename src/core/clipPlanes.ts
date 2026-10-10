import { Vector3 } from 'three'
import { split } from './curves'
import type { Document } from './document'
import { clippingNormal, domain, isClosed, pointAt, samples, type AnyCurve, type MeshGeometry } from './geometry'

/**
 * Clipping planes for drawings (Make2D, layout details, printing), as plain data the kernel worker
 * can take: what lies on the side of `normal` stays (normal · p + constant ≥ 0), the rest is cut
 * away. The views on screen use Three.js planes instead (view/clipping.ts).
 */
export interface ClipPlane {
  normal: Vector3
  constant: number
  /** A point on the plane, for building section curves and cutting boxes. */
  origin: Vector3
}

/**
 * The clipping planes of a document that cut drawings: those visible and on in `view` (a viewport
 * name), or every visible one when no view is given.
 */
export function drawingClipPlanes(doc: Document, view?: string): ClipPlane[] {
  const planes: ClipPlane[] = []
  for (const obj of doc.objects.values()) {
    const g = obj.geometry
    if (g.type !== 'clipping' || !doc.isVisible(obj) || (view !== undefined && !g.views.includes(view))) continue
    const normal = clippingNormal(g)
    planes.push({ normal, constant: -normal.dot(g.center), origin: g.center.clone() })
  }
  return planes
}

/** Signed distance from the plane: negative where it cuts away. */
export const planeDistance = (plane: ClipPlane, p: Vector3) => plane.normal.dot(p) + plane.constant

/** A size-relative slack, so what lies on a plane stays. */
const kept = (plane: ClipPlane, p: Vector3) => planeDistance(plane, p) >= -1e-9 * Math.max(1, Math.abs(plane.constant), p.length())

export const isKept = (planes: readonly ClipPlane[], p: Vector3) => planes.every((plane) => kept(plane, p))

/** The pieces of a polyline that the planes keep. */
export function clipPolyline(points: Vector3[], planes: readonly ClipPlane[]): Vector3[][] {
  let pieces = [points]
  for (const plane of planes) {
    const next: Vector3[][] = []
    for (const line of pieces) {
      let run: Vector3[] = []
      for (let i = 0; i < line.length; i++) {
        const p = line[i]
        const inside = kept(plane, p)
        if (i > 0) {
          const q = line[i - 1]
          const dq = planeDistance(plane, q)
          const dp = planeDistance(plane, p)
          // Crossing the plane: the run ends or starts where it crosses.
          if (kept(plane, q) !== inside && dq !== dp) {
            const at = q.clone().lerp(p, dq / (dq - dp))
            if (inside) run = [at]
            else {
              run.push(at)
              if (run.length > 1) next.push(run)
              run = []
            }
          }
        }
        if (inside) run.push(p)
      }
      if (run.length > 1) next.push(run)
    }
    pieces = next
  }
  return pieces
}

/**
 * The pieces of a curve that the planes keep, as curves of the same kind (an arc stays an arc).
 * The curve is split where it crosses a plane, found from its display samples and refined by
 * bisection.
 */
export function clipCurve(g: AnyCurve, planes: readonly ClipPlane[]): AnyCurve[] {
  if (planes.length === 0) return [g]
  const { params } = samples(g)
  const cuts: number[] = []
  for (const plane of planes) {
    const f = (t: number) => planeDistance(plane, pointAt(g, t))
    for (let i = 1; i < params.length; i++) {
      let lo = params[i - 1]
      let hi = params[i]
      let flo = f(lo)
      const fhi = f(hi)
      // On the plane at a sample: a cut there (an extra one where it only touches does no harm).
      if (flo === 0) cuts.push(lo)
      if (fhi === 0) cuts.push(hi)
      if (flo === 0 || fhi === 0 || flo * fhi > 0) continue
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2
        const fm = f(mid)
        if (flo * fm <= 0) hi = mid
        else {
          lo = mid
          flo = fm
        }
      }
      cuts.push((lo + hi) / 2)
    }
  }
  const [t0, t1] = domain(g)
  // A closed curve can be cut at its start too (split takes it there).
  const closed = isClosed(g)
  const at = [...new Set(cuts)].filter((t) => (closed ? t >= t0 - 1e-12 && t <= t1 + 1e-12 : t > t0 + 1e-12 && t < t1 - 1e-12)).sort((a, b) => a - b)
  const pieces = at.length > 0 ? split(g, at) : [g]
  return pieces.filter((piece) => {
    const [a, b] = domain(piece)
    return isKept(planes, pointAt(piece, (a + b) / 2))
  })
}

/**
 * A mesh with what the planes cut away removed: faces across a plane are cut along it. Null if
 * nothing is left. The cut leaves the mesh open there, so drawings show the cut as its border.
 */
export function clipMesh(g: MeshGeometry, planes: readonly ClipPlane[]): MeshGeometry | null {
  if (planes.length === 0) return g
  const vertices: number[] = []
  const faces: number[] = []
  const point = (i: number) => new Vector3(g.vertices[3 * i], g.vertices[3 * i + 1], g.vertices[3 * i + 2])
  const add = (p: Vector3) => {
    vertices.push(p.x, p.y, p.z)
    return vertices.length / 3 - 1
  }
  for (let f = 0; f < g.faces.length; f += 4) {
    const ids = g.faces.slice(f, f + 4)
    let polygon = (ids[2] === ids[3] ? ids.slice(0, 3) : ids).map(point)
    for (const plane of planes) {
      if (polygon.length === 0) break
      const out: Vector3[] = []
      polygon.forEach((p, i) => {
        const q = polygon[(i + 1) % polygon.length]
        const dp = planeDistance(plane, p)
        const dq = planeDistance(plane, q)
        if (kept(plane, p)) out.push(p)
        if (kept(plane, p) !== kept(plane, q) && dp !== dq) out.push(p.clone().lerp(q, dp / (dp - dq)))
      })
      polygon = out
    }
    if (polygon.length < 3) continue
    // Fan triangles (and quads where the face stays whole).
    const index = polygon.map(add)
    if (index.length === 4) faces.push(...index)
    else for (let k = 1; k + 1 < index.length; k++) faces.push(index[0], index[k], index[k + 1], index[k + 1])
  }
  return faces.length > 0 ? { type: 'mesh', vertices, faces } : null
}
