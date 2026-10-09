import { Vector3 } from 'three'
import type { MeshGeometry } from './geometry'
import { drawingEdges, meshTriangles } from './mesh'

/**
 * Hidden line drawings of meshes (Make2D for meshes). The edges worth drawing (silhouettes, creases
 * and open borders) are sampled along their length, and each sample is tested against every triangle
 * that could be in front of it, found through a grid over the drawing.
 */

export interface MeshView {
  /** From the model towards the viewer. */
  direction: Vector3
  /** Right on the drawing. */
  xaxis: Vector3
}

export interface MeshDrawing {
  visible: Vector3[][]
  hidden: Vector3[][]
}

/** Triangles seen in the drawing plane: x, y and depth (towards the viewer) of each corner. */
class ProjectedTriangles {
  private readonly cells: number[][]
  private readonly minX: number
  private readonly minY: number
  private readonly cell: number
  private readonly n: number

  constructor(
    private readonly t: Float64Array,
    size: number,
  ) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < t.length; i += 3) {
      minX = Math.min(minX, t[i])
      maxX = Math.max(maxX, t[i])
      minY = Math.min(minY, t[i + 1])
      maxY = Math.max(maxY, t[i + 1])
    }
    const count = t.length / 9
    this.n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(count) * 1.5)))
    this.minX = minX
    this.minY = minY
    this.cell = Math.max(maxX - minX, maxY - minY, size * 1e-9) / this.n
    this.cells = Array.from({ length: this.n * this.n }, () => [])
    for (let k = 0; k < count; k++) {
      const o = 9 * k
      const [x0, x1] = [Math.min(t[o], t[o + 3], t[o + 6]), Math.max(t[o], t[o + 3], t[o + 6])]
      const [y0, y1] = [Math.min(t[o + 1], t[o + 4], t[o + 7]), Math.max(t[o + 1], t[o + 4], t[o + 7])]
      for (let cy = this.index(y0, minY); cy <= this.index(y1, minY); cy++) for (let cx = this.index(x0, minX); cx <= this.index(x1, minX); cx++) this.cells[cy * this.n + cx].push(k)
    }
  }

  private index(v: number, min: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v - min) / this.cell)))
  }

  /** True if a triangle lies over (x, y) nearer the viewer than `depth` by more than `eps`. */
  covers(x: number, y: number, depth: number, eps: number): boolean {
    const t = this.t
    const list = this.cells[this.index(y, this.minY) * this.n + this.index(x, this.minX)]
    for (const k of list) {
      const o = 9 * k
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[o], t[o + 1], t[o + 2], t[o + 3], t[o + 4], t[o + 5], t[o + 6], t[o + 7], t[o + 8]]
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(det) < 1e-300) continue
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
      const w = 1 - u - v
      // Just inside, so edges shared with the triangle do not hide themselves.
      if (u < -1e-12 || v < -1e-12 || w < -1e-12) continue
      if (u * az + v * bz + w * cz > depth + eps) return true
    }
    return false
  }
}

/**
 * Drawing of `meshes` from a view, in the XY plane (x right, y up, the view's origin at the world
 * origin), as Make2D draws. `occluders` are more triangles that hide lines (flat x, y, z lists; the
 * display triangles of surfaces, for instance).
 */
export function drawMeshes(meshes: MeshGeometry[], view: MeshView, occluders: number[][] = [], withHidden = false): MeshDrawing {
  const d = view.direction.clone().normalize()
  const x = view.xaxis.clone().addScaledVector(d, -view.xaxis.dot(d)).normalize()
  const y = d.clone().cross(x)
  const project = (px: number, py: number, pz: number, out: Float64Array, o: number) => {
    out[o] = px * x.x + py * x.y + pz * x.z
    out[o + 1] = px * y.x + py * y.y + pz * y.z
    out[o + 2] = px * d.x + py * d.y + pz * d.z
  }

  // Every triangle that can hide something, projected.
  const lists: number[][] = [...meshes.map((m) => meshTriangles(m).flatMap((i) => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]])), ...occluders]
  const total = lists.reduce((n, l) => n + l.length, 0)
  const flat = new Float64Array(total)
  let at = 0
  for (const list of lists) for (let i = 0; i < list.length; i += 3, at += 3) project(list[i], list[i + 1], list[i + 2], flat, at)
  let size = 0
  for (const v of flat) size = Math.max(size, Math.abs(v))
  size = Math.max(size, 1e-9)
  const triangles = new ProjectedTriangles(flat, size)
  const eps = size * 1e-5

  const visible: Vector3[][] = []
  /** Hidden stretches, kept as edge and sample range until the visible lines are all known. */
  const hiddenRuns: { p: Float64Array; q: Float64Array; samples: number; from: number; to: number }[] = []
  const step = size / 400
  for (const m of meshes) {
    for (const [a, b] of drawingEdges(m, d)) {
      const p = new Float64Array(3)
      const q = new Float64Array(3)
      project(a.x, a.y, a.z, p, 0)
      project(b.x, b.y, b.z, q, 0)
      const length2D = Math.hypot(q[0] - p[0], q[1] - p[1])
      // Edges seen end on draw nothing.
      if (length2D < size * 1e-9) continue
      const samples = Math.min(64, Math.max(2, Math.ceil(length2D / step)))
      // Visibility at the middle of each piece of the edge decides the piece.
      let runStart = 0
      let runVisible: boolean | null = null
      const flush = (end: number) => {
        if (runVisible === null) return
        if (runVisible) visible.push([at2D(p, q, runStart / samples), at2D(p, q, end / samples)])
        else if (withHidden) hiddenRuns.push({ p, q, samples, from: runStart, to: end })
      }
      for (let i = 0; i < samples; i++) {
        const t = (i + 0.5) / samples
        const seen = !triangles.covers(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, eps)
        if (seen !== runVisible) {
          flush(i)
          runStart = i
          runVisible = seen
        }
      }
      flush(samples)
    }
  }

  // Hidden lines right under visible ones (the back edges of a box seen square on) are left out.
  const shown = new SegmentGrid(visible, size)
  const hidden: Vector3[][] = []
  for (const run of hiddenRuns) {
    let start = -1
    for (let i = run.from; i <= run.to; i++) {
      const t = (i + 0.5) / run.samples
      const keep = i < run.to && !shown.near(run.p[0] + (run.q[0] - run.p[0]) * t, run.p[1] + (run.q[1] - run.p[1]) * t, size * 1e-6)
      if (keep && start < 0) start = i
      if (!keep && start >= 0) {
        hidden.push([at2D(run.p, run.q, start / run.samples), at2D(run.p, run.q, i / run.samples)])
        start = -1
      }
    }
  }
  return { visible: joinLines(visible, size * 1e-9), hidden: joinLines(hidden, size * 1e-9) }
}

const at2D = (p: Float64Array, q: Float64Array, t: number) => new Vector3(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, 0)

/** Two-point lines in the drawing plane, found by position through a grid. */
class SegmentGrid {
  private readonly cells = new Map<string, Vector3[][]>()
  private readonly cell: number

  constructor(lines: Vector3[][], size: number) {
    this.cell = size / 200
    for (const line of lines) {
      const [a, b] = line
      for (let cy = Math.floor(Math.min(a.y, b.y) / this.cell); cy <= Math.floor(Math.max(a.y, b.y) / this.cell); cy++) {
        for (let cx = Math.floor(Math.min(a.x, b.x) / this.cell); cx <= Math.floor(Math.max(a.x, b.x) / this.cell); cx++) {
          const key = `${cx},${cy}`
          const list = this.cells.get(key)
          if (list) list.push(line)
          else this.cells.set(key, [line])
        }
      }
    }
  }

  /** True if a line passes within `tolerance` of (x, y). */
  near(x: number, y: number, tolerance: number): boolean {
    for (const [a, b] of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`) ?? []) {
      const ex = b.x - a.x
      const ey = b.y - a.y
      const len2 = ex * ex + ey * ey
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * ex + (y - a.y) * ey) / len2))
      if (Math.hypot(a.x + ex * t - x, a.y + ey * t - y) <= tolerance) return true
    }
    return false
  }
}

/** Joins two-point lines that continue one another (meeting end to end, in line) into longer ones. */
function joinLines(lines: Vector3[][], tolerance: number): Vector3[][] {
  const key = (p: Vector3) => `${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)}`
  const ends = new Map<string, number[]>()
  lines.forEach((l, i) => {
    for (const p of [l[0], l[1]]) {
      const k = key(p)
      const list = ends.get(k)
      if (list) list.push(i)
      else ends.set(k, [i])
    }
  })
  const used = new Uint8Array(lines.length)
  const out: Vector3[][] = []
  /** Grows the line at its last point with pieces that carry on in the same direction. */
  const grow = (line: Vector3[]) => {
    for (;;) {
      const end = line[line.length - 1]
      const dir = end.clone().sub(line[line.length - 2]).normalize()
      let next: Vector3 | null = null
      for (const j of ends.get(key(end)) ?? []) {
        if (used[j]) continue
        const [a, b] = lines[j]
        const far = key(a) === key(end) ? b : a
        if (far.clone().sub(end).normalize().dot(dir) > 1 - 1e-9) {
          used[j] = 1
          next = far
          break
        }
      }
      if (!next) return
      line[line.length - 1] = next
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const line = [...lines[i]]
    grow(line)
    line.reverse()
    grow(line)
    out.push(line)
  }
  return out
}
