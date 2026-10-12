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
  /** Vertical thickness of the roof (its thickness measured square to the slopes, made vertical). */
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
    bottom: base - params.overhang * tan - drop - params.thickness - 1,
    top: base + size * tan + params.thickness + 1,
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

export interface StairPlan {
  /** The stair's side profile (steps and the slab under them), a closed polyline standing on the line. */
  profile: PolylineGeometry
  /** The profile is swept along this to make the stair (its width). */
  across: Vector3
  risers: number
  riser: number
  tread: number
}

/**
 * A straight stair along a line (its run, from the bottom step to the top), centred on the line:
 * as many risers as asked (or as make steps about 175 high), equal treads along the run, and a
 * sloping slab under the steps.
 */
export function stairPlan(line: AnyCurve, params: StairParams): StairPlan {
  if (line.type !== 'polyline' || line.points.length !== 2) throw new Error('A stair runs along a straight line')
  const [start, end] = line.points
  const run = flat(end).sub(flat(start))
  const length = run.length()
  if (length < 1e-9) throw new Error('The stair line has no length')
  if (!(params.height > 0) || !(params.width > 0) || !(params.waist > 0)) throw new Error('The stair needs a height, a width and a waist')
  const dir = run.clone().normalize()
  const n = params.risers > 0 ? params.risers : Math.max(2, Math.round(params.height / COMFORTABLE_RISER))
  const riser = params.height / n
  const tread = length / n
  const at = (s: number, z: number) => start.clone().addScaledVector(dir, s).addScaledVector(UP, z)
  // The steps, from the bottom: up a riser, along a tread, and so on to the top.
  const points: Vector3[] = [at(0, 0)]
  for (let i = 0; i < n; i++) {
    points.push(at(i * tread, (i + 1) * riser))
    points.push(at((i + 1) * tread, (i + 1) * riser))
  }
  // The slab under them, parallel to the line of the steps' inner corners, `waist` below it.
  const slope = params.height / length
  const below = params.waist * Math.sqrt(1 + slope * slope)
  points.push(at(length, params.height - below))
  points.push(at(Math.min(below / slope, length), 0))
  const clean = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-9)
  const left = UP.clone().cross(dir).normalize()
  const shift = left.clone().multiplyScalar(-params.width / 2)
  return {
    profile: { type: 'polyline', points: clean.map((p) => p.add(shift)), closed: true },
    across: left.multiplyScalar(params.width),
    risers: n,
    riser,
    tread,
  }
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
