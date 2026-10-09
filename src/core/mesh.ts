import { Matrix4, Vector3 } from 'three'
import type { BrepGeometry, MeshGeometry } from './geometry'

/**
 * Polygon meshes: queries, repairs and primitives. Faces are four vertex indices; a triangle
 * repeats its third one. Everything here returns new meshes; the input is never changed.
 */

/** Above this many vertices, mesh vertices are not offered as snap points. */
export const SNAP_VERTEX_LIMIT = 20000

export const faceCount = (g: MeshGeometry): number => g.faces.length / 4
export const vertexCount = (g: MeshGeometry): number => g.vertices.length / 3
const isTriangle = (f: number[], i: number) => f[i + 2] === f[i + 3]

const vertexAt = (g: MeshGeometry, i: number, out = new Vector3()) => out.fromArray(g.vertices, 3 * i)

/** Builds a mesh from vertices and polygons (3 or 4 indices each). */
export function makeMesh(vertices: number[], polygons: number[][]): MeshGeometry {
  const faces: number[] = []
  for (const p of polygons) {
    if (p.length === 3) faces.push(p[0], p[1], p[2], p[2])
    else if (p.length === 4) faces.push(p[0], p[1], p[2], p[3])
    else for (let i = 1; i + 1 < p.length; i++) faces.push(p[0], p[i], p[i + 1], p[i + 1]) // Larger polygons as a fan.
  }
  return { type: 'mesh', vertices, faces }
}

/** The triangles a surface or solid is drawn with, as a welded mesh (no kernel needed). */
export function brepDisplayMesh(g: BrepGeometry): MeshGeometry {
  const t = g.display.triangles
  const faces: number[] = []
  for (let i = 0; i < t.length; i += 3) faces.push(t[i], t[i + 1], t[i + 2], t[i + 2])
  return weldMesh({ type: 'mesh', vertices: [...g.display.vertices], faces })
}

/** Indexed triangles: a triangle as it is, a quad split into two. */
export function meshTriangles(g: MeshGeometry): number[] {
  const out: number[] = []
  const f = g.faces
  for (let i = 0; i < f.length; i += 4) {
    out.push(f[i], f[i + 1], f[i + 2])
    if (!isTriangle(f, i)) out.push(f[i], f[i + 2], f[i + 3])
  }
  return out
}

const weldCache = new WeakMap<MeshGeometry, Int32Array>()

/**
 * For each vertex, the index of the first vertex at the same place, so meshes saved with every face
 * on its own vertices (as STL is) still have a shape: shared edges, borders, pieces.
 */
export function coincident(g: MeshGeometry, tolerance = 1e-9): Int32Array {
  const cached = tolerance === 1e-9 ? weldCache.get(g) : undefined
  if (cached) return cached
  const n = vertexCount(g)
  const map = new Int32Array(n)
  const v = g.vertices
  // Coordinates rounded to the tolerance, checking the neighbouring cells so points that round
  // differently still meet.
  const cells = new Map<string, number[]>()
  const cell = (x: number) => Math.round(x / Math.max(tolerance, 1e-12))
  for (let i = 0; i < n; i++) {
    const cx = cell(v[3 * i])
    const cy = cell(v[3 * i + 1])
    const cz = cell(v[3 * i + 2])
    let found = -1
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!list) continue
          for (const j of list) {
            if (Math.abs(v[3 * j] - v[3 * i]) <= tolerance && Math.abs(v[3 * j + 1] - v[3 * i + 1]) <= tolerance && Math.abs(v[3 * j + 2] - v[3 * i + 2]) <= tolerance) {
              found = j
              break search
            }
          }
        }
      }
    }
    if (found >= 0) map[i] = found
    else {
      map[i] = i
      const key = `${cx},${cy},${cz}`
      const list = cells.get(key)
      if (list) list.push(i)
      else cells.set(key, [i])
    }
  }
  if (tolerance === 1e-9) weldCache.set(g, map)
  return map
}

/** The corners of a face (3 or 4), as vertex indices. */
function corners(f: number[], i: number): number[] {
  return isTriangle(f, i) ? [f[i], f[i + 1], f[i + 2]] : [f[i], f[i + 1], f[i + 2], f[i + 3]]
}

/** Each edge once (by position), with how many faces use it. Key is "a,b" with a < b. */
function edgeUse(g: MeshGeometry): Map<string, { a: number; b: number; count: number; faces: number[] }> {
  const same = coincident(g)
  const edges = new Map<string, { a: number; b: number; count: number; faces: number[] }>()
  const f = g.faces
  for (let i = 0; i < f.length; i += 4) {
    const c = corners(f, i)
    for (let k = 0; k < c.length; k++) {
      const a = same[c[k]]
      const b = same[c[(k + 1) % c.length]]
      if (a === b) continue
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const e = edges.get(key)
      if (e) {
        e.count++
        e.faces.push(i / 4)
      } else edges.set(key, { a: c[k], b: c[(k + 1) % c.length], count: 1, faces: [i / 4] })
    }
  }
  return edges
}

/** Every edge of the mesh as a two-point line (shared edges once). */
export function meshEdgeLines(g: MeshGeometry): Vector3[][] {
  return [...edgeUse(g).values()].map((e) => [vertexAt(g, e.a), vertexAt(g, e.b)])
}

/** Edges used by only one face: the open borders. */
export function nakedEdges(g: MeshGeometry): Vector3[][] {
  return [...edgeUse(g).values()].filter((e) => e.count === 1).map((e) => [vertexAt(g, e.a), vertexAt(g, e.b)])
}

/** Closed: every edge is shared by exactly two faces. */
export function isClosedMesh(g: MeshGeometry): boolean {
  if (g.faces.length === 0) return false
  for (const e of edgeUse(g).values()) if (e.count !== 2) return false
  return true
}

/** The distinct vertex positions. */
export function meshVertexPoints(g: MeshGeometry): Vector3[] {
  const same = coincident(g)
  const out: Vector3[] = []
  for (let i = 0; i < same.length; i++) if (same[i] === i) out.push(vertexAt(g, i))
  return out
}

/** Every vertex, in order, for editing as control points. */
export function meshPoints(g: MeshGeometry): Vector3[] {
  const out: Vector3[] = []
  for (let i = 0; i < vertexCount(g); i++) out.push(vertexAt(g, i))
  return out
}

export function withMeshPoints(g: MeshGeometry, points: Vector3[]): MeshGeometry {
  return { ...g, vertices: points.flatMap((p) => [p.x, p.y, p.z]) }
}

/** Applies a transform; a mirror reverses the faces so they keep facing the same way. */
export function transformMesh(g: MeshGeometry, m: Matrix4): MeshGeometry {
  const p = new Vector3()
  const vertices = new Array<number>(g.vertices.length)
  for (let i = 0; i < g.vertices.length; i += 3) {
    p.fromArray(g.vertices, i).applyMatrix4(m)
    vertices[i] = p.x
    vertices[i + 1] = p.y
    vertices[i + 2] = p.z
  }
  const moved = { ...g, vertices }
  return m.determinant() < 0 ? flipMesh(moved) : moved
}

/** Reverses the direction every face faces. */
export function flipMesh(g: MeshGeometry): MeshGeometry {
  const f = g.faces
  const faces: number[] = []
  for (let i = 0; i < f.length; i += 4) {
    if (isTriangle(f, i)) faces.push(f[i], f[i + 2], f[i + 1], f[i + 1])
    else faces.push(f[i], f[i + 3], f[i + 2], f[i + 1])
  }
  return { ...g, faces }
}

/** Drops vertices no face uses and faces that collapsed to a line or a point. */
export function compactMesh(g: MeshGeometry): MeshGeometry {
  const used = new Int32Array(vertexCount(g)).fill(-1)
  const vertices: number[] = []
  const faces: number[] = []
  const f = g.faces
  for (let i = 0; i < f.length; i += 4) {
    const c = [...new Set(corners(f, i))]
    if (c.length < 3) continue
    const mapped = c.map((v) => {
      if (used[v] < 0) {
        used[v] = vertices.length / 3
        vertices.push(g.vertices[3 * v], g.vertices[3 * v + 1], g.vertices[3 * v + 2])
      }
      return used[v]
    })
    faces.push(mapped[0], mapped[1], mapped[2], mapped[3] ?? mapped[2])
  }
  return { type: 'mesh', vertices, faces }
}

/** Merges vertices closer than the tolerance, so faces share them. */
export function weldMesh(g: MeshGeometry, tolerance = 1e-6): MeshGeometry {
  const same = coincident(g, tolerance)
  return compactMesh({ ...g, faces: g.faces.map((v) => same[v]) })
}

/** Gives every face its own vertices (as STL stores them). */
export function unweldMesh(g: MeshGeometry): MeshGeometry {
  const vertices: number[] = []
  const faces: number[] = []
  const f = g.faces
  for (let i = 0; i < f.length; i += 4) {
    const c = corners(f, i)
    const base = vertices.length / 3
    for (const v of c) vertices.push(g.vertices[3 * v], g.vertices[3 * v + 1], g.vertices[3 * v + 2])
    faces.push(base, base + 1, base + 2, base + c.length - 1)
  }
  return { type: 'mesh', vertices, faces }
}

/** Puts several meshes into one. */
export function joinMeshes(meshes: MeshGeometry[]): MeshGeometry {
  const vertices: number[] = []
  const faces: number[] = []
  for (const m of meshes) {
    const offset = vertices.length / 3
    for (const v of m.vertices) vertices.push(v)
    for (const i of m.faces) faces.push(i + offset)
  }
  return { type: 'mesh', vertices, faces }
}

/** Faces grouped into pieces that touch through shared edges. */
function faceGroups(g: MeshGeometry): number[][] {
  const n = faceCount(g)
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (const e of edgeUse(g).values()) for (let k = 1; k < e.faces.length; k++) parent[find(e.faces[k])] = find(e.faces[0])
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const list = groups.get(root)
    if (list) list.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()]
}

/** Splits a mesh into its separate pieces. */
export function meshPieces(g: MeshGeometry): MeshGeometry[] {
  const groups = faceGroups(g)
  if (groups.length <= 1) return [g]
  return groups.map((faces) => compactMesh({ ...g, faces: faces.flatMap((i) => g.faces.slice(4 * i, 4 * i + 4)) }))
}

/**
 * Turns faces so neighbours agree on which side is out (each shared edge is walked in opposite
 * directions), and closed pieces face outwards.
 */
export function unifyNormals(g: MeshGeometry): { mesh: MeshGeometry; flipped: number } {
  const same = coincident(g)
  const f = [...g.faces]
  const n = faceCount(g)
  // For each face, its edges as (from, to) welded indices.
  const directed = (i: number) => {
    const c = corners(f, 4 * i).map((v) => same[v])
    return c.map((a, k) => [a, c[(k + 1) % c.length]] as const)
  }
  const byEdge = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    for (const [a, b] of directed(i)) {
      if (a === b) continue
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const list = byEdge.get(key)
      if (list) list.push(i)
      else byEdge.set(key, [i])
    }
  }
  const flipFace = (i: number) => {
    const at = 4 * i
    if (f[at + 2] === f[at + 3]) [f[at + 1], f[at + 2], f[at + 3]] = [f[at + 2], f[at + 1], f[at + 1]]
    else [f[at + 1], f[at + 3]] = [f[at + 3], f[at + 1]]
  }
  const seen = new Uint8Array(n)
  let flipped = 0
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue
    seen[start] = 1
    const piece = [start]
    const queue = [start]
    while (queue.length) {
      const i = queue.pop()!
      for (const [a, b] of directed(i)) {
        const key = a < b ? `${a},${b}` : `${b},${a}`
        for (const j of byEdge.get(key) ?? []) {
          if (seen[j]) continue
          // A neighbour that walks the shared edge the same way faces the other side.
          if (directed(j).some(([c, d]) => c === a && d === b)) {
            flipFace(j)
            flipped++
          }
          seen[j] = 1
          piece.push(j)
          queue.push(j)
        }
      }
    }
    // A closed piece with negative volume faces inwards.
    const sub: MeshGeometry = { type: 'mesh', vertices: g.vertices, faces: piece.flatMap((i) => f.slice(4 * i, 4 * i + 4)) }
    if (isClosedMesh(sub) && meshVolume(sub) < 0) {
      for (const i of piece) flipFace(i)
      flipped += piece.length
    }
  }
  return { mesh: { ...g, faces: f }, flipped }
}

/**
 * Closes each hole (a loop of open edges) with a fan of triangles around its middle, facing the
 * same way as the faces around it. Suits the small, roughly flat holes of scanned or printed parts.
 */
export function fillHoles(g: MeshGeometry): { mesh: MeshGeometry; holes: number } {
  const welded = weldMesh(g, 1e-9)
  // Open edges as the faces walk them; the patch walks them the other way.
  const next = new Map<number, number>()
  for (const e of edgeUse(welded).values()) if (e.count === 1) next.set(e.a, e.b)
  const vertices = [...welded.vertices]
  const faces = [...welded.faces]
  let holes = 0
  while (next.size > 0) {
    const [start] = next.keys()
    const loop: number[] = []
    let v: number | undefined = start
    while (v !== undefined && next.has(v)) {
      loop.push(v)
      const to: number = next.get(v)!
      next.delete(v)
      v = to
    }
    // Only loops that come back to their start are holes (a border that crosses itself is left alone).
    if (v !== start || loop.length < 3) continue
    holes++
    if (loop.length === 3) {
      faces.push(loop[2], loop[1], loop[0], loop[0])
      continue
    }
    const middle = new Vector3()
    for (const i of loop) middle.add(vertexAt(welded, i))
    middle.divideScalar(loop.length)
    const c = vertices.push(middle.x, middle.y, middle.z) / 3 - 1
    for (let k = 0; k < loop.length; k++) faces.push(loop[(k + 1) % loop.length], loop[k], c, c)
  }
  return { mesh: { type: 'mesh', vertices, faces }, holes }
}

/** Total area of the faces. */
export function meshArea(g: MeshGeometry): number {
  const t = meshTriangles(g)
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  let area = 0
  for (let i = 0; i < t.length; i += 3) {
    vertexAt(g, t[i], a)
    vertexAt(g, t[i + 1], b).sub(a)
    vertexAt(g, t[i + 2], c).sub(a)
    area += b.cross(c).length() / 2
  }
  return area
}

/** Enclosed volume (meaningful for closed meshes facing outwards). */
export function meshVolume(g: MeshGeometry): number {
  const t = meshTriangles(g)
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  let volume = 0
  for (let i = 0; i < t.length; i += 3) {
    vertexAt(g, t[i], a)
    vertexAt(g, t[i + 1], b)
    vertexAt(g, t[i + 2], c)
    volume += a.dot(b.cross(c)) / 6
  }
  return volume
}

// --- Primitives --------------------------------------------------------------------------

/** A grid of quads over the parallelogram `origin + s·u + t·v`, facing u × v. */
function grid(vertices: number[], faces: number[][], origin: Vector3, u: Vector3, v: Vector3, nu: number, nv: number): void {
  const base = vertices.length / 3
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const p = origin.clone().addScaledVector(u, i / nu).addScaledVector(v, j / nv)
      vertices.push(p.x, p.y, p.z)
    }
  }
  const at = (i: number, j: number) => base + j * (nu + 1) + i
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)])
}

/** A flat rectangle of quads. */
export function meshPlane(origin: Vector3, u: Vector3, v: Vector3, nu = 10, nv = 10): MeshGeometry {
  const vertices: number[] = []
  const faces: number[][] = []
  grid(vertices, faces, origin, u, v, nu, nv)
  return makeMesh(vertices, faces)
}

/** A box on the corner `origin` with edges u, v and w (right-handed), its sides divided into quads. */
export function meshBox(origin: Vector3, u: Vector3, v: Vector3, w: Vector3, nu = 10, nv = 10, nw = 10): MeshGeometry {
  // Flip so the sides face outwards whichever way the edges were drawn.
  if (u.clone().cross(v).dot(w) < 0) return meshBox(origin.clone().add(w), u, v, w.clone().negate(), nu, nv, nw)
  const vertices: number[] = []
  const faces: number[][] = []
  const o = origin
  const top = o.clone().add(w)
  grid(vertices, faces, o, v, u, nv, nu) // Bottom, facing down.
  grid(vertices, faces, top, u, v, nu, nv)
  grid(vertices, faces, o, u, w, nu, nw) // Front.
  grid(vertices, faces, o.clone().add(v), w, u, nw, nu) // Back.
  grid(vertices, faces, o, w, v, nw, nv) // Left.
  grid(vertices, faces, o.clone().add(u), v, w, nv, nw) // Right.
  return weldMesh(makeMesh(vertices, faces))
}

/** A sphere of quads, with triangles around the poles. */
export function meshSphere(center: Vector3, radius: number, xaxis = new Vector3(1, 0, 0), yaxis = new Vector3(0, 1, 0), around = 32, vertical = 16): MeshGeometry {
  const z = xaxis.clone().cross(yaxis).normalize()
  const vertices: number[] = []
  const faces: number[][] = []
  const push = (p: Vector3) => vertices.push(p.x, p.y, p.z) / 3 - 1
  const south = push(center.clone().addScaledVector(z, -radius))
  const rings: number[][] = []
  for (let j = 1; j < vertical; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / vertical
    const ring: number[] = []
    for (let i = 0; i < around; i++) {
      const theta = (2 * Math.PI * i) / around
      ring.push(
        push(
          center
            .clone()
            .addScaledVector(xaxis, radius * Math.cos(phi) * Math.cos(theta))
            .addScaledVector(yaxis, radius * Math.cos(phi) * Math.sin(theta))
            .addScaledVector(z, radius * Math.sin(phi)),
        ),
      )
    }
    rings.push(ring)
  }
  const north = push(center.clone().addScaledVector(z, radius))
  for (let i = 0; i < around; i++) {
    const k = (i + 1) % around
    faces.push([south, rings[0][k], rings[0][i]])
    for (let j = 0; j + 1 < rings.length; j++) faces.push([rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]])
    const last = rings[rings.length - 1]
    faces.push([last[i], last[k], north])
  }
  return makeMesh(vertices, faces)
}

/** A cylinder standing on `center` along xaxis × yaxis, capped with triangle fans. */
export function meshCylinder(center: Vector3, radius: number, height: number, xaxis = new Vector3(1, 0, 0), yaxis = new Vector3(0, 1, 0), around = 32, vertical = 1): MeshGeometry {
  if (height < 0) return meshCylinder(center.clone().addScaledVector(xaxis.clone().cross(yaxis).normalize(), height), radius, -height, xaxis, yaxis, around, vertical)
  const z = xaxis.clone().cross(yaxis).normalize()
  const vertices: number[] = []
  const faces: number[][] = []
  const push = (p: Vector3) => vertices.push(p.x, p.y, p.z) / 3 - 1
  const rings: number[][] = []
  for (let j = 0; j <= vertical; j++) {
    const ring: number[] = []
    for (let i = 0; i < around; i++) {
      const theta = (2 * Math.PI * i) / around
      ring.push(push(center.clone().addScaledVector(xaxis, radius * Math.cos(theta)).addScaledVector(yaxis, radius * Math.sin(theta)).addScaledVector(z, (height * j) / vertical)))
    }
    rings.push(ring)
  }
  const bottom = push(center)
  const top = push(center.clone().addScaledVector(z, height))
  for (let i = 0; i < around; i++) {
    const k = (i + 1) % around
    for (let j = 0; j < vertical; j++) faces.push([rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]])
    faces.push([bottom, rings[0][k], rings[0][i]])
    faces.push([top, rings[vertical][i], rings[vertical][k]])
  }
  return makeMesh(vertices, faces)
}
