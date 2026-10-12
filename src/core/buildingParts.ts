import { Vector3 } from 'three'
import { AnyCurve, CircleGeometry, PolylineGeometry } from './geometry'

/**
 * Roofs, stairs and columns: like walls and slabs, solids made from a curve that stays in the model
 * (an outline or a line), with their parameters in their history record. This module has the plain
 * geometry; the kernel makes the solids (kernel/architecture.ts).
 */

const UP = new Vector3(0, 0, 1)
const flat = (v: Vector3) => new Vector3(v.x, v.y, 0)

// --- Roofs ---------------------------------------------------------------------------------

/**
 * - hip: every side slopes up from the eaves;
 * - gable: the sides along the longest one slope, the ends stay upright (gables);
 * - shed: one slope, up from the longest side.
 */
export type RoofType = 'hip' | 'gable' | 'shed'

export interface RoofParams {
  type: RoofType
  /** Slope, in degrees. */
  pitch: number
  /** How far the roof reaches past the outline (horizontally). */
  overhang: number
  thickness: number
}

export const DEFAULT_ROOF: RoofParams = { type: 'hip', pitch: 30, overhang: 500, thickness: 250 }

export function roofParams(p: Record<string, unknown> | undefined): RoofParams {
  const type = p?.type === 'gable' || p?.type === 'shed' ? p.type : 'hip'
  return {
    type,
    pitch: Number(p?.pitch ?? DEFAULT_ROOF.pitch),
    overhang: Number(p?.overhang ?? DEFAULT_ROOF.overhang),
    thickness: Number(p?.thickness ?? DEFAULT_ROOF.thickness),
  }
}

export interface Plane {
  origin: Vector3
  /** Pointing to the side cut away (above the roof). */
  normal: Vector3
}

export interface RoofPlan {
  /** The roof's outline at the eaves (the outline grown by the overhang), as a closed polyline. */
  eaves: PolylineGeometry
  /** The planes of the slopes: the roof is under all of them. */
  slopes: Plane[]
  /** Heights the roof stays between, with room to spare. */
  bottom: number
  top: number
  /**
   * Vertical thickness of the roof (its thickness measured square to the slopes, made vertical). The
   * slopes are the roof's underside: it rests on the outline at the eaves height.
   */
  drop: number
}

/** The corners of a closed flat polyline, counterclockwise seen from above. */
function counterclockwise(points: Vector3[]): Vector3[] {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const q = points[(i + 1) % points.length]
    area += points[i].x * q.y - q.x * points[i].y
  }
  return area >= 0 ? points : [...points].reverse()
}

/** Where two flat lines (point and direction) cross. */
function crossing(p: Vector3, d: Vector3, q: Vector3, e: Vector3): Vector3 | null {
  const denom = d.x * e.y - d.y * e.x
  if (Math.abs(denom) < 1e-12) return null
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / denom
  return p.clone().addScaledVector(d, t)
}

/**
 * The planes and extents of a pitched roof over a closed convex outline: each sloping side rises
 * from its edge of the outline at the pitch; the roof reaches out past the outline by the overhang
 * (so its eaves sit a little lower).
 */
export function roofPlan(outline: AnyCurve, params: RoofParams): RoofPlan {
  if (outline.type !== 'polyline' || !outline.closed || outline.points.length < 3) throw new Error('A roof needs a closed outline of straight sides')
  if (!(params.pitch >= 0 && params.pitch < 80)) throw new Error('The roof pitch must be between 0 and 80 degrees')
  if (!(params.thickness > 0) || !(params.overhang >= 0)) throw new Error('The roof needs a thickness, and an overhang of 0 or more')
  const base = outline.points[0].z
  const pts = counterclockwise(outline.points.map(flat)).filter((p, i, all) => p.distanceTo(all[(i + 1) % all.length]) > 1e-9)
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const c = pts[(i + 2) % n]
    const turn = b.clone().sub(a).cross(c.clone().sub(b)).z
    if (turn < -1e-9 * a.distanceTo(b) * b.distanceTo(c)) throw new Error('Pitched roofs need a convex outline (no inside corners)')
  }
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % n]
    const dir = b.clone().sub(a).normalize()
    return { a, b, dir, inward: UP.clone().cross(dir).normalize(), length: a.distanceTo(b) }
  })
  const longest = edges.reduce((x, y) => (y.length > x.length ? y : x))
  const sloped = edges.filter((e) =>
    params.type === 'hip' ? true : params.type === 'gable' ? Math.abs(e.dir.dot(longest.dir)) > 0.99 : e === longest,
  )
  const tan = Math.tan((params.pitch * Math.PI) / 180)
  const cos = Math.cos((params.pitch * Math.PI) / 180)
  const slopes: Plane[] = sloped.map((e) => ({
    origin: new Vector3(e.a.x, e.a.y, base),
    normal: UP.clone().multiplyScalar(cos).addScaledVector(e.inward, -Math.sin((params.pitch * Math.PI) / 180)).normalize(),
  }))
  // The eaves: each side moved out by the overhang, corners where they meet.
  const moved = edges.map((e) => ({ p: e.a.clone().addScaledVector(e.inward, -params.overhang), d: e.dir }))
  const eavesPoints = moved.map((m, i) => {
    const prev = moved[(i - 1 + n) % n]
    const hit = crossing(prev.p, prev.d, m.p, m.d) ?? m.p
    return new Vector3(hit.x, hit.y, base)
  })
  let size = 0
  for (const p of eavesPoints) for (const q of eavesPoints) size = Math.max(size, p.distanceTo(q))
  const drop = params.thickness / cos
  return {
    eaves: { type: 'polyline', points: eavesPoints, closed: true },
    slopes,
    bottom: base - params.overhang * tan - params.thickness - 1,
    top: base + size * tan + drop + 1,
    drop,
  }
}

// --- Stairs --------------------------------------------------------------------------------

export interface StairParams {
  width: number
  /** Height climbed, from the bottom of the line to the floor above. */
  height: number
  /** Number of risers; 0 picks them for a comfortable step (risers of about 175). */
  risers: number
  /** Thickness of the slab under the steps. */
  waist: number
}

export const DEFAULT_STAIR: Omit<StairParams, 'height'> = { width: 1000, risers: 0, waist: 150 }
const COMFORTABLE_RISER = 175

export function stairParams(p: Record<string, unknown> | undefined, fallbackHeight = 3000): StairParams {
  return {
    width: Number(p?.width ?? DEFAULT_STAIR.width),
    height: Number(p?.height ?? fallbackHeight),
    risers: Math.max(0, Math.round(Number(p?.risers ?? 0))),
    waist: Number(p?.waist ?? DEFAULT_STAIR.waist),
  }
}

/** One straight flight of a stair: its side profile, swept across its width. */
export interface Flight {
  profile: PolylineGeometry
  across: Vector3
  risers: number
  riser: number
  tread: number
}

/** A landing: a box (corner and edges). */
export interface Landing {
  origin: Vector3
  u: Vector3
  v: Vector3
  w: Vector3
}

export interface StairPlan {
  flights: Flight[]
  landings: Landing[]
  risers: number
  riser: number
}

/**
 * A flight from `start` to `end` (its run), rising `n` risers of `riser` from `base` above the
 * start: equal treads along the run and a sloping slab under the steps, centred on the line.
 */
function flight(start: Vector3, end: Vector3, base: number, n: number, riser: number, width: number, waist: number, fromLanding = false): Flight {
  const run = flat(end).sub(flat(start))
  const length = run.length()
  const dir = run.clone().normalize()
  const height = n * riser
  const tread = length / n
  const at = (s: number, z: number) => start.clone().addScaledVector(dir, s).addScaledVector(UP, base + z)
  // The steps, from the bottom: up a riser, along a tread, and so on to the top.
  const points: Vector3[] = [at(0, 0)]
  for (let i = 0; i < n; i++) {
    points.push(at(i * tread, (i + 1) * riser))
    points.push(at((i + 1) * tread, (i + 1) * riser))
  }
  // The slab under them, parallel to the line of the steps' inner corners, `waist` below it.
  const slope = height / length
  const below = waist * Math.sqrt(1 + slope * slope)
  points.push(at(length, height - below))
  if (fromLanding) {
    // Off a landing, the slab under the steps meets the landing's own slab (its thickness `waist`).
    points.push(at(Math.min((below - waist) / slope, length), -waist))
    points.push(at(0, -waist))
  } else points.push(at(Math.min(below / slope, length), 0))
  const clean = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-9)
  const left = UP.clone().cross(dir).normalize()
  const shift = left.clone().multiplyScalar(-width / 2)
  return { profile: { type: 'polyline', points: clean.map((p) => p.add(shift)), closed: true }, across: left.multiplyScalar(width), risers: n, riser, tread }
}

/** Shares `total` risers among flights by their runs (largest remainders), at least one each. */
function shareRisers(runs: number[], total: number): number[] {
  const sum = runs.reduce((a, b) => a + b, 0)
  const exact = runs.map((r) => (r / sum) * total)
  const counts = exact.map((e) => Math.max(1, Math.floor(e)))
  let left = total - counts.reduce((a, b) => a + b, 0)
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][1]]++
  for (let k = counts.length - 1; left < 0 && k >= 0; k--) {
    while (left < 0 && counts[k] > 1) {
      counts[k]--
      left++
    }
  }
  return counts
}

/**
 * A stair along a line from its bottom step to its top one, centred on it. A straight line makes
 * one flight; each bend of the line is a square landing as wide as the stair, between flights
 * (an L stair has one, a U stair two side by side, drawn as a line going up, across and back).
 * The risers (as many as asked, or as make steps about 175 high) are shared among the flights by
 * their length; each landing is at the height of the flight below it.
 */
export function stairPlan(line: AnyCurve, params: StairParams): StairPlan {
  if (line.type !== 'polyline' || line.closed || line.points.length < 2) throw new Error('A stair runs along a line of straight segments')
  if (!(params.height > 0) || !(params.width > 0) || !(params.waist > 0)) throw new Error('The stair needs a height, a width and a waist')
  const pts = line.points.filter((p, i, all) => i === 0 || flat(p).distanceTo(flat(all[i - 1])) > 1e-9)
  if (pts.length < 2) throw new Error('The stair line has no length')
  const half = params.width / 2
  // Each segment's flight runs between the landings at its ends (half a width in from a bend).
  const runs = pts.slice(1).map((b, i) => {
    const a = pts[i]
    const dir = flat(b).sub(flat(a)).normalize()
    const from = i > 0 ? half : 0
    const to = i < pts.length - 2 ? half : 0
    const length = flat(b).distanceTo(flat(a)) - from - to
    return { start: a.clone().addScaledVector(dir, from), end: b.clone().addScaledVector(dir, -to), length: Math.max(0, length), dir }
  })
  const climbing = runs.filter((r) => r.length > 1e-6)
  if (climbing.length === 0) throw new Error('The stair is too short for its width')
  const total = params.risers > 0 ? params.risers : Math.max(2 * climbing.length, Math.round(params.height / COMFORTABLE_RISER))
  if (total < climbing.length) throw new Error('A stair needs at least one riser per flight')
  const riser = params.height / total
  const shares = shareRisers(climbing.map((r) => r.length), total)
  const flights: Flight[] = []
  const landings: Landing[] = []
  let climbed = 0
  let k = 0
  runs.forEach((r, i) => {
    if (r.length > 1e-6) {
      flights.push(flight(r.start, r.end, climbed * riser, shares[k], riser, params.width, params.waist, k > 0 && climbed * riser >= params.waist))
      climbed += shares[k++]
    }
    // The landing at the bend after this segment, square to it, at the height reached.
    if (i < runs.length - 1) {
      const c = pts[i + 1]
      const left = UP.clone().cross(r.dir).normalize()
      const top = climbed * riser
      const thick = Math.min(params.waist, top)
      landings.push({
        origin: c.clone().addScaledVector(r.dir, -half).addScaledVector(left, -half).addScaledVector(UP, top - thick),
        u: r.dir.clone().multiplyScalar(params.width),
        v: left.multiplyScalar(params.width),
        w: UP.clone().multiplyScalar(thick),
      })
    }
  })
  return { flights, landings, risers: total, riser }
}

/** The plan outlines of a stair (its flights' profiles and its landings' tops), for previews. */
export function stairOutlines(plan: StairPlan): Vector3[][] {
  const landing = (l: Landing) => {
    const top = l.origin.clone().add(l.w)
    return [top, top.clone().add(l.u), top.clone().add(l.u).add(l.v), top.clone().add(l.v), top.clone()]
  }
  return [...plan.flights.map((f) => [...f.profile.points, f.profile.points[0]]), ...plan.landings.map(landing)]
}

/** Is a step comfortable? (Two risers and a tread between 600 and 650, the usual rule.) */
export const comfortable = (riser: number, tread: number) => 2 * riser + tread >= 600 && 2 * riser + tread <= 650

// --- Columns -------------------------------------------------------------------------------

export type ColumnShape = 'rectangular' | 'round'

export interface ColumnParams {
  height: number
}

export const DEFAULT_COLUMN = { shape: 'rectangular' as ColumnShape, width: 300, depth: 300 }

export const columnParams = (p: Record<string, unknown> | undefined, fallbackHeight = 3000): ColumnParams => ({ height: Number(p?.height ?? fallbackHeight) })

/** A column's outline, centred on a point: a rectangle (width along x, depth along y) or a circle. */
export function columnOutline(center: Vector3, shape: ColumnShape, width: number, depth: number): AnyCurve {
  if (shape === 'round') {
    const circle: CircleGeometry = { type: 'circle', center: center.clone(), xaxis: new Vector3(1, 0, 0), yaxis: new Vector3(0, 1, 0), radius: width / 2 }
    return circle
  }
  const [w, d] = [width / 2, depth / 2]
  const corner = (x: number, y: number) => new Vector3(center.x + x, center.y + y, center.z)
  return { type: 'polyline', points: [corner(-w, -d), corner(w, -d), corner(w, d), corner(-w, d)], closed: true }
}
