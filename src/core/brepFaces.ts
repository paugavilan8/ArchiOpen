import { Box3, Vector3 } from 'three'
import type { BrepGeometry } from './geometry'

/** Questions about surfaces and solids that their display mesh answers, without the kernel. */

/** Index of the face of a brep closest to a point (from its display mesh), or -1. */
export function nearestFace(g: BrepGeometry, p: Vector3): number {
  const { vertices: v, triangles: t, faceTriangles } = g.display
  if (!faceTriangles) return -1
  let best = Infinity
  let index = -1
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const q = new Vector3()
  faceTriangles.forEach(([start, count], face) => {
    for (let i = start; i < start + count; i += 3) {
      a.fromArray(v, t[i] * 3)
      b.fromArray(v, t[i + 1] * 3)
      c.fromArray(v, t[i + 2] * 3)
      const d = closestOnTriangle(p, a, b, c, q).distanceTo(p)
      if (d < best) {
        best = d
        index = face
      }
    }
  })
  return index
}

/** Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: Vector3): Vector3 {
  const ab = b.clone().sub(a)
  const ac = c.clone().sub(a)
  const ap = p.clone().sub(a)
  const d1 = ab.dot(ap)
  const d2 = ac.dot(ap)
  if (d1 <= 0 && d2 <= 0) return out.copy(a)
  const bp = p.clone().sub(b)
  const d3 = ab.dot(bp)
  const d4 = ac.dot(bp)
  if (d3 >= 0 && d4 <= d3) return out.copy(b)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3))
  const cp = p.clone().sub(c)
  const d5 = ab.dot(cp)
  const d6 = ac.dot(cp)
  if (d6 >= 0 && d5 <= d6) return out.copy(c)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(c.clone().sub(b), (d4 - d3) / (d4 - d3 + (d5 - d6)))
  const denom = 1 / (va + vb + vc)
  return out
    .copy(a)
    .addScaledVector(ab, vb * denom)
    .addScaledVector(ac, vc * denom)
}

/** Bounding box of a brep's display mesh (no kernel needed). */
export function displayBox(g: BrepGeometry): Box3 {
  const box = new Box3()
  const v = g.display.vertices
  for (let i = 0; i < v.length; i += 3) box.expandByPoint(new Vector3(v[i], v[i + 1], v[i + 2]))
  return box
}
