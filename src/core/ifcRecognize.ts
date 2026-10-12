import { Vector3 } from 'three'
import type { Opening, SlabHole } from './architecture'
import { meshVolume, planArea } from './quantities'

/**
 * Recognizing building elements in imported meshes (from IFC), so they come in as ArchiOpen's own
 * editable elements rather than dead shapes:
 * - a straight wall of even thickness, with flat top and bottom, becomes a Wall along its centre
 *   line, with the doors and windows found in it as its openings;
 * - a flat slab becomes a Slab on the outline of its top face, its holes as openings.
 * Each is checked against its own volume, so anything else (curved, sloping, irregular) stays a mesh.
 */

export interface MeshElement {
  /** IFC class, upper case (IFCWALL, IFCSLAB, IFCWINDOW, ...). */
  type: string
  name?: string
  /** [x, y, z, ...] in millimeters, Z up. */
  vertices: number[]
  /** Triangles as quads repeating their last corner (as mesh geometry). */
  faces: number[]
}

export interface RecognizedWall {
  index: number
  path: [Vector3, Vector3]
  thickness: number
  height: number
  openings: Opening[]
}

export interface RecognizedSlab {
  index: number
  /** The outline of its top, closed (first point not repeated). */
  outline: Vector3[]
  thickness: number
  holes: SlabHole[]
}

export interface Recognized {
  walls: RecognizedWall[]
  slabs: RecognizedSlab[]
  /** Elements taken in (walls, slabs, and the doors and windows placed in walls). */
  used: Set<number>
  /** Why each wall or slab left as a mesh was not taken in. */
  rejected: Map<number, string>
}

const WALLS = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE'])
const SLABS = new Set(['IFCSLAB'])
const OPENINGS: Record<string, Opening['kind']> = { IFCWINDOW: 'window', IFCDOOR: 'door' }

/** Tolerance on faces (mm) and on volumes (fraction). */
const ON_FACE = 2
const VOLUME = 0.03

const triangles = (faces: number[]) => {
  const out: number[] = []
  for (let i = 0; i + 3 < faces.length; i += 4) {
    const [a, b, c, d] = faces.slice(i, i + 4)
    out.push(a, b, c)
    if (d !== c) out.push(a, c, d)
  }
  return out
}

const pointsOf = (v: number[]) => Array.from({ length: v.length / 3 }, (_, i) => new Vector3(v[3 * i], v[3 * i + 1], v[3 * i + 2]))

interface Frame {
  dir: Vector3
  perp: Vector3
  u: [number, number]
  v: [number, number]
  z: [number, number]
}

/**
 * A mesh's extent along its main horizontal direction (and across it), and in height. The direction
 * is that of its largest upright faces (a wall's two sides), by area, to a tenth of a degree.
 */
function frameOf(points: Vector3[], tris: number[]): Frame {
  const bins = new Map<number, number>()
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const [a, b, c] = [points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]]
    const n = b.clone().sub(a).cross(c.clone().sub(a))
    const area = n.length() / 2
    if (area < 1e-9 || Math.abs(n.z) > 0.1 * n.length()) continue
    // The face's normal, as an angle from 0 to 180°, in tenths of a degree.
    let bin = Math.round((Math.atan2(n.y, n.x) * 1800) / Math.PI)
    bin = ((bin % 1800) + 1800) % 1800
    bins.set(bin, (bins.get(bin) ?? 0) + area)
  }
  let best = 0
  let most = -1
  for (const [bin, area] of bins) if (area > most) [best, most] = [bin, area]
  const across = (best * Math.PI) / 1800
  const perp = new Vector3(Math.cos(across), Math.sin(across), 0)
  const dir = new Vector3(perp.y, -perp.x, 0)
  const range = (f: (p: Vector3) => number): [number, number] => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of points) {
      const t = f(p)
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
    return [lo, hi]
  }
  return { dir, perp, u: range((p) => p.dot(dir)), v: range((p) => p.dot(perp)), z: range((p) => p.z) }
}

/** The area of the faces of a mesh lying flat at a height, seen from above. */
function levelArea(points: Vector3[], tris: number[], z: number): number {
  let area = 0
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const [a, b, c] = [points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]]
    if (![a, b, c].every((p) => Math.abs(p.z - z) < ON_FACE)) continue
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2
  }
  return area
}

/** The loops round the face of a mesh at a height (its triangles there), by area, largest first. */
function levelLoops(points: Vector3[], tris: number[], top: number): [number, number][][] {
  // Points welded by position (meshes from IFC repeat them per face).
  const key = (p: Vector3) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`
  const ids = new Map<string, number>()
  const at: [number, number][] = []
  const id = (p: Vector3) => {
    const k = key(p)
    let i = ids.get(k)
    if (i === undefined) {
      ids.set(k, (i = at.length))
      at.push([p.x, p.y])
    }
    return i
  }
  const edges = new Map<string, [number, number]>()
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const tri = [points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]]
    if (!tri.every((p) => Math.abs(p.z - top) < ON_FACE)) continue
    const [a, b, c] = tri.map(id)
    if (a === b || b === c || c === a) continue
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`
      if (edges.has(k)) edges.delete(k)
      else edges.set(k, [u, v])
    }
  }
  // Chain the open edges into loops.
  const next = new Map<number, number[]>()
  for (const [u, v] of edges.values()) {
    next.set(u, [...(next.get(u) ?? []), v])
    next.set(v, [...(next.get(v) ?? []), u])
  }
  const seen = new Set<string>()
  const loops: [number, number][][] = []
  for (const [u, v] of edges.values()) {
    const k = u < v ? `${u},${v}` : `${v},${u}`
    if (seen.has(k)) continue
    const loop = [u]
    let [prev, cur] = [u, v]
    seen.add(k)
    for (let guard = 0; cur !== u && guard < edges.size + 1; guard++) {
      loop.push(cur)
      const options = (next.get(cur) ?? []).filter((w) => w !== prev && !seen.has(cur < w ? `${cur},${w}` : `${w},${cur}`))
      if (options.length === 0) break
      const w = options[0]
      seen.add(cur < w ? `${cur},${w}` : `${w},${cur}`)
      ;[prev, cur] = [cur, w]
    }
    if (cur === u && loop.length >= 3) loops.push(simplify(loop.map((i) => at[i])))
  }
  return loops.sort((a, b) => planArea(b) - planArea(a))
}

/** A loop without the points in the middle of straight runs. */
function simplify(loop: [number, number][]): [number, number][] {
  const out = loop.filter((p, i) => {
    const a = loop[(i + loop.length - 1) % loop.length]
    const b = loop[(i + 1) % loop.length]
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
    return Math.abs(cross) / Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-9) > 0.5
  })
  return out.length >= 3 ? out : loop
}

export function recognize(elements: MeshElement[]): Recognized {
  const used = new Set<number>()
  const rejected = new Map<number, string>()
  const walls: (RecognizedWall & { frame: Frame; volume: number; base: number; inside: Vector3[] })[] = []
  elements.forEach((e, index) => {
    if (!WALLS.has(e.type) || e.vertices.length < 24) return
    const points = pointsOf(e.vertices)
    const tris = triangles(e.faces)
    const frame = frameOf(points, tris)
    const thickness = frame.v[1] - frame.v[0]
    const length = frame.u[1] - frame.u[0]
    if (!(thickness >= 20 && thickness <= 1500 && length > thickness)) return void rejected.set(index, `not wall-like (${Math.round(thickness)} thick, ${Math.round(length)} long)`)
    // Every point on one face or the other: an even, straight wall. Points inside it are only
    // allowed round its doors and windows (rebates, where an opening is wider part of the way).
    const inside = points.filter((p) => Math.min(Math.abs(p.dot(frame.perp) - frame.v[0]), Math.abs(p.dot(frame.perp) - frame.v[1])) >= ON_FACE)
    // The centre line ends halfway between the ends of the two faces: at the middle of a square
    // end, and at the corner of the centre lines where walls meet at a mitre.
    const face = (side: number) => {
      const us = points.filter((p) => Math.abs(p.dot(frame.perp) - side) < ON_FACE).map((p) => p.dot(frame.dir))
      return [Math.min(...us), Math.max(...us)]
    }
    const [a, b] = [face(frame.v[0]), face(frame.v[1])]
    const [u0, u1] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const mid = (frame.v[0] + frame.v[1]) / 2
    const start = frame.dir.clone().multiplyScalar(u0).addScaledVector(frame.perp, mid).setZ(frame.z[0])
    const end = frame.dir.clone().multiplyScalar(u1).addScaledVector(frame.perp, mid).setZ(frame.z[0])
    // Its footprint: the bigger of its bottom and top faces (a door cuts the bottom one).
    const base = Math.max(levelArea(points, tris, frame.z[0]), levelArea(points, tris, frame.z[1]))
    walls.push({ index, path: [start, end], thickness, height: frame.z[1] - frame.z[0], openings: [], frame, volume: meshVolume(e.vertices, tris), base, inside })
  })

  // Doors and windows into the walls holding them.
  const placed = new Map<number, number>()
  elements.forEach((e, index) => {
    const kind = OPENINGS[e.type]
    if (!kind || e.vertices.length < 3) return
    const points = pointsOf(e.vertices)
    const centre = points.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / points.length)
    const wall = walls.find((w) => {
      const { frame: f } = w
      const [u, v] = [centre.dot(f.dir), centre.dot(f.perp)]
      return u > f.u[0] && u < f.u[1] && v > f.v[0] - 100 && v < f.v[1] + 100 && centre.z > f.z[0] && centre.z < f.z[1]
    })
    if (!wall) return
    const f = wall.frame
    const us = points.map((p) => p.dot(f.dir))
    const zs = points.map((p) => p.z)
    const [u0, u1] = [Math.min(...us), Math.max(...us)]
    const [z0, z1] = [Math.min(...zs), Math.max(...zs)]
    const sill = Math.max(0, z0 - f.z[0])
    wall.openings.push({ id: wall.openings.length + 1, kind, at: (u0 + u1) / 2 - f.u[0], width: u1 - u0, height: Math.min(z1 - z0, wall.height - sill), sill: kind === 'door' ? 0 : sill })
    placed.set(index, wall.index)
  })

  // Kept where the wall's volume is that of a straight wall less its openings.
  // Kept where its volume is its footprint raised by its height, less its openings: flat on top.
  const keptWalls = walls.filter((w) => {
    const f = w.frame
    const nearOpening = (p: Vector3) => {
      const [u, z] = [p.dot(f.dir) - f.u[0], p.z - f.z[0]]
      return w.openings.some((o) => Math.abs(u - o.at) <= o.width / 2 + w.thickness && z >= o.sill - w.thickness && z <= o.sill + o.height + w.thickness)
    }
    if (!w.inside.every(nearOpening)) {
      rejected.set(w.index, 'not straight and even')
      return false
    }
    const solid = w.base * w.height
    const holes = w.openings.reduce((s, o) => s + o.width * o.height * w.thickness, 0)
    const ok = solid > 0 && Math.abs(w.volume - (solid - holes)) <= VOLUME * solid
    if (!ok) rejected.set(w.index, `not flat on top or bottom (volume ${Math.round(w.volume / 1e6)} dm³, as a straight wall ${Math.round((solid - holes) / 1e6)} dm³)`)
    return ok
  })
  const keptIds = new Set(keptWalls.map((w) => w.index))
  for (const w of keptWalls) used.add(w.index)
  for (const [opening, wall] of placed) if (keptIds.has(wall)) used.add(opening)

  const slabs: RecognizedSlab[] = []
  elements.forEach((e, index) => {
    if (!SLABS.has(e.type) || e.vertices.length < 9) return
    const points = pointsOf(e.vertices)
    const zs = points.map((p) => p.z)
    const [bottom, top] = [Math.min(...zs), Math.max(...zs)]
    const thickness = top - bottom
    if (!(thickness >= 20 && thickness <= 2000)) return void rejected.set(index, `not slab-like (${Math.round(thickness)} thick)`)
    if (!zs.every((z) => Math.abs(z - top) < ON_FACE || Math.abs(z - bottom) < ON_FACE)) return void rejected.set(index, 'not flat')
    const tris = triangles(e.faces)
    const loops = levelLoops(points, tris, top)
    if (loops.length === 0) return void rejected.set(index, 'no outline on top')
    const [outer, ...holes] = loops
    const area = planArea(outer) - holes.reduce((s, h) => s + planArea(h), 0)
    if (Math.abs(meshVolume(e.vertices, tris) - area * thickness) > VOLUME * planArea(outer) * thickness) return void rejected.set(index, 'not of even thickness')
    slabs.push({ index, outline: outer.map(([x, y]) => new Vector3(x, y, top)), thickness, holes: holes.map((points) => ({ points })) })
    used.add(index)
  })

  return { walls: keptWalls.map(({ index, path, thickness, height, openings }) => ({ index, path, thickness, height, openings })), slabs, used, rejected }
}
