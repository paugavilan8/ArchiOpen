import { Vector3 } from 'three'
import type { MeshGeometry } from './geometry'

/**
 * Terrain: a surface through survey points and contour lines, as the triangles of their Delaunay
 * triangulation in plan, each point at its height. It can be cut to a boundary drawn in plan, and
 * given a base: sides down to a depth and a bottom, so it is a closed solid that sections cut and
 * fill like the building.
 */

/**
 * The Delaunay triangulation of points in plan (Bowyer–Watson): triangles as index triples into
 * `points`, counter-clockwise seen from above. Points closer than `tolerance` to an earlier one are
 * left out.
 */
export function delaunay(points: readonly [number, number][], tolerance = 1e-9): [number, number, number][] {
  const n = points.length
  if (n < 3) return []
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of points) [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)]
  const size = Math.max(maxX - minX, maxY - minY, 1e-9)
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2]
  // A triangle round everything, its corners after the points.
  const pts: [number, number][] = [...points, [cx - 20 * size, cy - size], [cx, cy + 20 * size], [cx + 20 * size, cy - size]]
  interface Tri {
    a: number
    b: number
    c: number
    x: number
    y: number
    r2: number
  }
  const circle = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const [qx, qy] = pts[c]
    const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by))
    if (Math.abs(d) < 1e-300) return { a, b, c, x: 0, y: 0, r2: Infinity }
    const a2 = ax * ax + ay * ay
    const b2 = bx * bx + by * by
    const c2 = qx * qx + qy * qy
    const x = (a2 * (by - qy) + b2 * (qy - ay) + c2 * (ay - by)) / d
    const y = (a2 * (qx - bx) + b2 * (ax - qx) + c2 * (bx - ax)) / d
    return { a, b, c, x, y, r2: (ax - x) ** 2 + (ay - y) ** 2 }
  }
  let tris: Tri[] = [circle(n, n + 1, n + 2)]
  const kept: number[] = []
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i]
    if (kept.some((j) => Math.hypot(pts[j][0] - px, pts[j][1] - py) <= tolerance)) continue
    kept.push(i)
    const bad: Tri[] = []
    const good: Tri[] = []
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 * (1 + 1e-12) ? bad : good).push(t)
    // The hole's edges: those of bad triangles not shared by two of them.
    const edges = new Map<string, [number, number]>()
    for (const t of bad) {
      for (const [u, v] of [
        [t.a, t.b],
        [t.b, t.c],
        [t.c, t.a],
      ]) {
        const key = u < v ? `${u},${v}` : `${v},${u}`
        if (edges.has(key)) edges.delete(key)
        else edges.set(key, [u, v])
      }
    }
    tris = good
    for (const [u, v] of edges.values()) tris.push(circle(u, v, i))
  }
  const out: [number, number, number][] = []
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue
    const [ax, ay] = pts[t.a]
    const [bx, by] = pts[t.b]
    const [qx, qy] = pts[t.c]
    const cross = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
    if (Math.abs(cross) < 1e-12 * size * size) continue
    out.push(cross > 0 ? [t.a, t.b, t.c] : [t.a, t.c, t.b])
  }
  return out
}

/** Is a point inside a polygon in plan (even-odd)? */
export function insidePolygon(x: number, y: number, polygon: readonly [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Points every `spacing` along a polyline (its corners kept), for sampling contour lines. */
export function resample(points: readonly Vector3[], spacing: number): Vector3[] {
  if (points.length === 0 || !(spacing > 0)) return [...points]
  const out = [points[0].clone()]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / spacing))
    for (let k = 1; k <= steps; k++) out.push(a.clone().lerp(b, k / steps))
  }
  return out
}

export interface TerrainOptions {
  /** Keep only triangles whose middle lies inside this polygon (in plan). */
  boundary?: [number, number][]
  /** Depth of the base below the lowest point; 0 or missing for the surface only. */
  base?: number
  /** Leave out triangles with an edge longer than this in plan (gaps at concave edges). */
  maxEdge?: number
}

/**
 * The terrain through points: a triangle mesh (faces as quads repeating their last corner), with
 * sides and a bottom when it has a base.
 */
export function terrainMesh(points: readonly Vector3[], options: TerrainOptions = {}): MeshGeometry {
  const plan = points.map((p) => [p.x, p.y] as [number, number])
  let tris = delaunay(plan, 1e-6)
  const at = (i: number) => points[i]
  if (options.boundary && options.boundary.length >= 3) {
    const b = options.boundary
    tris = tris.filter(([a, c, d]) => insidePolygon((at(a).x + at(c).x + at(d).x) / 3, (at(a).y + at(c).y + at(d).y) / 3, b))
  }
  if (options.maxEdge && options.maxEdge > 0) {
    const m = options.maxEdge
    const long = (i: number, j: number) => Math.hypot(at(i).x - at(j).x, at(i).y - at(j).y) > m
    tris = tris.filter(([a, c, d]) => !long(a, c) && !long(c, d) && !long(d, a))
  }
  if (tris.length === 0) throw new Error('The terrain needs at least three points not all in a line (inside the boundary)')
  // Only the points the triangles use, renumbered.
  const used = [...new Set(tris.flat())]
  const index = new Map(used.map((i, k) => [i, k]))
  const vertices: number[] = used.flatMap((i) => [at(i).x, at(i).y, at(i).z])
  const faces: number[] = tris.flatMap(([a, b, c]) => [index.get(a)!, index.get(b)!, index.get(c)!, index.get(c)!])
  if (!(options.base && options.base > 0)) return { type: 'mesh', vertices, faces }

  // The base: the same points at the bottom, the triangles turned over, and sides along the
  // open edges (those of one triangle only).
  const count = used.length
  const bottom = Math.min(...used.map((i) => at(i).z)) - options.base
  for (const i of used) vertices.push(at(i).x, at(i).y, bottom)
  for (const [a, b, c] of tris) faces.push(index.get(a)! + count, index.get(c)! + count, index.get(b)! + count, index.get(b)! + count)
  const edges = new Map<string, [number, number]>()
  for (const [a, b, c] of tris) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`
      if (edges.has(key)) edges.delete(key)
      else edges.set(key, [u, v])
    }
  }
  for (const [u, v] of edges.values()) {
    const [p, q] = [index.get(u)!, index.get(v)!]
    // Outward: the open edge runs counter-clockwise round the top, so its side faces out this way.
    faces.push(q, p, p + count, q + count)
  }
  return { type: 'mesh', vertices, faces }
}
