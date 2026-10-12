import { Vector3 } from 'three'
import type { AnyCurve } from '../core/geometry'
import { tessellate } from '../core/geometry'
import { joinShapes, planarFace } from './brep'
import { borderCurves, closestOn, curveCutter, splitShape } from './surfaceEdit'

/**
 * CurveBoolean: the regions curves enclose in a plane, picked by points inside them. A plane larger
 * than every curve is split by them; the pieces the points are in are kept, and pieces next to each
 * other merge into one region. Returns each region's outline (outer loop and holes).
 */
export function curveRegions(curves: AnyCurve[], points: Vector3[], origin: Vector3, xaxis: Vector3, yaxis: Vector3, normal: Vector3): AnyCurve[] {
  const n = normal.clone().normalize()
  // The curves' extent in the plane, with room round it.
  let [u0, v0, u1, v1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of [...curves.flatMap((c) => tessellate(c)), ...points]) {
    const d = p.clone().sub(origin)
    const [u, v] = [d.dot(xaxis), d.dot(yaxis)]
    ;[u0, v0, u1, v1] = [Math.min(u0, u), Math.min(v0, v), Math.max(u1, u), Math.max(v1, v)]
  }
  if (!Number.isFinite(u0)) throw new Error('Select curves')
  const margin = Math.max(u1 - u0, v1 - v0) * 0.1 + 1
  const at = (u: number, v: number) => origin.clone().addScaledVector(xaxis, u).addScaledVector(yaxis, v)
  const corners = [at(u0 - margin, v0 - margin), at(u1 + margin, v0 - margin), at(u1 + margin, v1 + margin), at(u0 - margin, v1 + margin)]
  const plane = planarFace({ type: 'polyline', points: corners, closed: true })
  if (!plane) throw new Error('Could not make the plane to split')
  const pieces = splitShape(
    plane,
    curves.map((c) => curveCutter(c, n, [plane])),
  )
  const size = Math.max(u1 - u0, v1 - v0, 1)
  const touchesFrame = (piece: (typeof pieces)[number]) =>
    piece.edges.some((e) => {
      const mid = e.pointAt(0.5)
      const d = new Vector3(mid.x, mid.y, mid.z).sub(origin)
      const [u, v] = [d.dot(xaxis), d.dot(yaxis)]
      const tol = size * 1e-6
      return Math.abs(u - (u0 - margin)) < tol || Math.abs(u - (u1 + margin)) < tol || Math.abs(v - (v0 - margin)) < tol || Math.abs(v - (v1 + margin)) < tol
    })
  const chosen = new Set<number>()
  for (const p of points) {
    // The point brought onto the plane.
    const onPlane = p.clone().addScaledVector(n, -p.clone().sub(origin).dot(n))
    const i = pieces.findIndex((piece) => (closestOn(piece, onPlane)?.distance ?? Infinity) < size * 1e-7)
    if (i < 0) throw new Error('A point is on a curve: pick inside a region')
    if (touchesFrame(pieces[i])) throw new Error('A point is not inside closed curves (the region is open)')
    chosen.add(i)
  }
  if (chosen.size === 0) return []
  // Neighbouring pieces sewn into one region; its free edges are its outline.
  return borderCurves(joinShapes([...chosen].map((i) => pieces[i]), size * 1e-6))
}
