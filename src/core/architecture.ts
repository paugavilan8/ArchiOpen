import { Vector3 } from 'three'
import { chain, closestPoint, reverse } from './curves'
import { offset } from './offset'
import { AnyCurve, endPoint, isClosed, pointAt, PolylineGeometry, samples, startPoint, tangentAt } from './geometry'

/**
 * Architectural objects: walls along a path curve, slabs on an outline, and openings (windows and
 * doors) in walls, all kept as solids that remember how they were made (their construction
 * history), so editing the path or outline, or their parameters, makes them again. Levels give the
 * heights a building is drawn at.
 *
 * This module has the plain geometry (outlines and the boxes openings cut); the kernel makes the
 * solids (see kernel/architecture.ts). Paths and outlines are taken as lying flat (in a plane
 * square to Z), at the height of their level.
 */

export type Justification = 'center' | 'left' | 'right'

export interface Opening {
  /** Identifies the opening within its wall, so its frame and glass follow it. */
  id?: number
  kind: 'window' | 'door'
  /** Where the opening's middle is, as a distance along the wall's path from its start. */
  at: number
  width: number
  height: number
  /** Height of its bottom above the wall's base (0 for doors). */
  sill: number
  /** False for a bare opening, with no frame, glass or leaf. */
  frame?: boolean
  /** A door's hinges: at the end of the opening nearer the path's start, or its end. */
  hinge?: 'start' | 'end'
  /** The side of the wall a door opens to (left or right of the path). */
  swing?: 'left' | 'right'
}

/** One layer of a wall's build-up (brick, insulation, plaster, ...). */
export interface WallLayer {
  name: string
  thickness: number
  /** Render material, by name. */
  material?: string
}

export interface WallParams {
  thickness: number
  height: number
  /** Which side of the path the wall lies on, looking along the path. */
  justification: Justification
  openings: Opening[]
  /** Its layers from its left face to its right one (looking along the path); their thicknesses add up to `thickness`. */
  layers?: WallLayer[]
}

/** Wall build-ups to choose from, from the outside (left) face in. */
export const WALL_TYPES: Record<string, WallLayer[]> = {
  'Brick cavity': [
    { name: 'Facing brick', thickness: 115, material: 'Brick' },
    { name: 'Insulation', thickness: 50 },
    { name: 'Hollow brick', thickness: 70 },
    { name: 'Plaster', thickness: 15, material: 'White plaster' },
  ],
  'Insulated concrete': [
    { name: 'Render', thickness: 10, material: 'White plaster' },
    { name: 'Insulation', thickness: 80 },
    { name: 'Concrete', thickness: 200, material: 'Concrete' },
    { name: 'Plaster', thickness: 15, material: 'White plaster' },
  ],
  Partition: [
    { name: 'Plaster', thickness: 15, material: 'White plaster' },
    { name: 'Hollow brick', thickness: 70 },
    { name: 'Plaster', thickness: 15, material: 'White plaster' },
  ],
  'Timber frame': [
    { name: 'Cladding', thickness: 20, material: 'Wood' },
    { name: 'Insulation', thickness: 140 },
    { name: 'Board', thickness: 15 },
  ],
}

/**
 * Where a wall's layers meet, as distances to the left of its path (the inner faces between
 * layers only, not its two outer faces).
 */
export function layerBoundaries(params: Pick<WallParams, 'thickness' | 'justification' | 'layers'>): number[] {
  const layers = params.layers ?? []
  if (layers.length < 2) return []
  const { left } = wallSides(params)
  const out: number[] = []
  let at = left
  for (const layer of layers.slice(0, -1)) {
    at -= layer.thickness
    out.push(at)
  }
  return out
}

/** An opening through a slab: its outline in plan, and the stair it was made for, if any. */
export interface SlabHole {
  points: [number, number][]
  stair?: number
}

export interface SlabParams {
  thickness: number
  /** Openings through the slab (stairwells). */
  holes?: SlabHole[]
}

export interface Level {
  name: string
  /** Height of the level's floor. */
  elevation: number
  /** Floor-to-floor height, the default height of walls drawn on it. */
  height: number
}

export const DEFAULT_LEVELS: Level[] = [{ name: 'Level 0', elevation: 0, height: 3000 }]

export const DEFAULT_WALL: Omit<WallParams, 'openings' | 'height'> = { thickness: 200, justification: 'center' }
export const DEFAULT_SLAB: SlabParams = { thickness: 250 }
export const DEFAULT_OPENINGS: Record<Opening['kind'], Omit<Opening, 'kind' | 'at'>> = {
  window: { width: 1200, height: 1200, sill: 900 },
  door: { width: 900, height: 2100, sill: 0 },
}

const UP = new Vector3(0, 0, 1)

/** How far the wall reaches to the left and to the right of its path. */
export function wallSides(params: Pick<WallParams, 'thickness' | 'justification'>): { left: number; right: number } {
  const t = params.thickness
  if (params.justification === 'left') return { left: t, right: 0 }
  if (params.justification === 'right') return { left: 0, right: t }
  return { left: t / 2, right: t / 2 }
}

/** The direction to the left of a curve at a parameter, flat. */
function leftAt(g: AnyCurve, t: number): Vector3 {
  const d = tangentAt(g, t)
  d.z = 0
  return UP.clone().cross(d.normalize()).normalize()
}

/** A flat curve offset by `distance` to its left (negative: to its right); the curve itself for 0. */
/** A curve moved sideways, to its left by `distance` (to its right when negative), in plan. */
export function offsetLeft(g: AnyCurve, distance: number): AnyCurve | null {
  if (Math.abs(distance) < 1e-9) return g
  const { points, params } = samples(g)
  const i = Math.floor(points.length / 2)
  const through = points[i].clone().addScaledVector(leftAt(g, params[i]), Math.sign(distance))
  return offset(g, Math.abs(distance), through, UP)
}

/**
 * The plan outline of a wall: for an open path, one closed curve around it; for a closed path
 * (a room), the outer and inner curves of the ring between them.
 */
export function wallOutline(path: AnyCurve, params: Pick<WallParams, 'thickness' | 'justification'>, joins: ResolvedJoin[] = []): AnyCurve[] {
  if (!(params.thickness > 0)) throw new Error('The wall thickness must be positive')
  const { left, right } = wallSides(params)
  let a = offsetLeft(path, left)
  let b = offsetLeft(path, -right)
  if (!a || !b) throw new Error('The wall is too thick for the bends of its path')
  // Around a room, the outer curve is the one enclosing more (which side is left depends on the
  // way the path runs).
  if (isClosed(path)) return planArea(a) >= planArea(b) ? [a, b] : [b, a]
  if (path.type === 'polyline' && a.type === 'polyline' && b.type === 'polyline') {
    for (const join of joins) [a, b] = joinedEnds(path, a, b, join)
  }
  const line = (p: Vector3, q: Vector3): AnyCurve => ({ type: 'polyline', points: [p.clone(), q.clone()], closed: false })
  const loop = chain([a, line(endPoint(a), endPoint(b)), reverse(b), line(startPoint(b), startPoint(a))])
  if (!loop) throw new Error('The wall outline could not be made')
  return [loop.type === 'polyline' ? { ...loop, closed: true } : loop]
}

// --- Joins between walls ---------------------------------------------------------------

/**
 * How one end of a wall meets another wall:
 * - 'L': at the other's end; both are cut on the mitre between them;
 * - 'T': on the other's side; this one stops at the other's face.
 * Only straight ends (of walls along polylines) join.
 */
export interface WallJoin {
  end: 'start' | 'end'
  kind: 'L' | 'T'
}

/** A wall as joins see it: its path and how thick it is to each side. */
export interface WallRef {
  path: AnyCurve
  params: Pick<WallParams, 'thickness' | 'justification'>
}

export interface ResolvedJoin extends WallJoin {
  other: WallRef
}

/** A join as saved in a wall's record: the other wall's path is the record's input `input`. */
export interface SavedJoin extends WallJoin {
  input: number
  thickness: number
  justification: Justification
}

const flat = (v: Vector3) => new Vector3(v.x, v.y, 0)
const leftOf = (d: Vector3) => UP.clone().cross(d).normalize()

/** Where two flat lines (point and direction) cross, at the height of the first; null if parallel. */
function crossing(p: Vector3, d: Vector3, q: Vector3, e: Vector3): Vector3 | null {
  const denom = d.x * e.y - d.y * e.x
  if (Math.abs(denom) < 1e-9) return null
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / denom
  return p.clone().addScaledVector(d, t)
}

/** An end of an open polyline: its point, and the direction arriving at it along its last segment. */
function endOf(path: PolylineGeometry, end: 'start' | 'end'): { point: Vector3; arriving: Vector3 } {
  const n = path.points.length
  const [p, q] = end === 'end' ? [path.points[n - 1], path.points[n - 2]] : [path.points[0], path.points[1]]
  return { point: p.clone(), arriving: flat(p.clone().sub(q)).normalize() }
}

/** The ends of a wall's two sides moved to meet another wall (see WallJoin). */
function joinedEnds(path: PolylineGeometry, a: PolylineGeometry, b: PolylineGeometry, join: ResolvedJoin): [PolylineGeometry, PolylineGeometry] {
  const other = join.other
  if (other.path.type !== 'polyline') return [a, b]
  const { point: P, arriving: d } = endOf(path, join.end)
  // The side to the left of the way the wall arrives at its end: its left side at its end, its
  // right side at its start.
  const [toLeft, toRight] = join.end === 'end' ? [a, b] : [b, a]
  const sides = wallSides(other.params)
  let leftLine: [Vector3, Vector3]
  let rightLine: [Vector3, Vector3]
  if (join.kind === 'L') {
    // The other wall's sides, seen going away from the corner: they meet this wall's sides on
    // the same hand, as the sides of a bent wall would.
    const atStart = other.path.points[0].distanceTo(P) <= other.path.points[other.path.points.length - 1].distanceTo(P)
    const away = endOf(other.path, atStart ? 'start' : 'end').arriving.negate()
    const n = leftOf(away)
    const [l, r] = atStart ? [sides.left, sides.right] : [sides.right, sides.left]
    leftLine = [P.clone().addScaledVector(n, l), away]
    rightLine = [P.clone().addScaledVector(n, -r), away]
  } else {
    // The face of the other wall on this wall's side.
    const near = closestOnPolyline(other.path, P)
    const n = leftOf(near.direction)
    const back = P.clone().addScaledVector(d, -Math.max(other.params.thickness, 1))
    const side = n.dot(back.clone().sub(near.point)) >= 0 ? 1 : -1
    const face = near.point.clone().addScaledVector(n, side * (side > 0 ? sides.left : sides.right))
    leftLine = [face, near.direction]
    rightLine = [face, near.direction]
  }
  const moved = (side: PolylineGeometry, line: [Vector3, Vector3]): PolylineGeometry => {
    const points = side.points.map((p) => p.clone())
    const i = join.end === 'end' ? points.length - 1 : 0
    const hit = crossing(points[i], d, line[0], line[1])
    if (!hit) return side
    points[i] = new Vector3(hit.x, hit.y, points[i].z)
    return { ...side, points }
  }
  const newLeft = moved(toLeft, leftLine)
  const newRight = moved(toRight, rightLine)
  return join.end === 'end' ? [newLeft, newRight] : [newRight, newLeft]
}

/** The closest point of a polyline to a point (seen from above), and its segment's direction. */
function closestOnPolyline(path: PolylineGeometry, p: Vector3): { point: Vector3; direction: Vector3; distance: number; vertex: boolean } {
  const pts = path.closed ? [...path.points, path.points[0]] : path.points
  let best = { point: pts[0].clone(), direction: new Vector3(1, 0, 0), distance: Infinity, vertex: true }
  for (let i = 1; i < pts.length; i++) {
    const a = flat(pts[i - 1])
    const seg = flat(pts[i]).sub(a)
    const len2 = seg.lengthSq()
    if (len2 < 1e-18) continue
    const t = Math.min(Math.max(flat(p).sub(a).dot(seg) / len2, 0), 1)
    const q = a.clone().addScaledVector(seg, t)
    const distance = q.distanceTo(flat(p))
    if (distance < best.distance) {
      const length = Math.sqrt(len2)
      const fromEnd = Math.min(t, 1 - t) * length
      best = { point: new Vector3(q.x, q.y, pts[i - 1].z), direction: seg.clone().normalize(), distance, vertex: fromEnd < 1e-6 * Math.max(1, length) }
    }
  }
  return best
}

/**
 * The joins of a wall with others: each of its straight ends that is at another wall's end (L) or
 * on another wall's line, or within its thickness of it (T). Returns, for each, the other wall's
 * index in `others`.
 */
export function findJoins(self: WallRef, others: readonly WallRef[]): (WallJoin & { other: number })[] {
  const path = self.path
  if (path.type !== 'polyline' || path.closed || path.points.length < 2) return []
  const out: (WallJoin & { other: number })[] = []
  for (const end of ['start', 'end'] as const) {
    const P = endOf(path, end).point
    const tol = Math.max(self.params.thickness, 1) * 1e-3
    for (let i = 0; i < others.length; i++) {
      const o = others[i]
      if (o.path.type !== 'polyline' || o.path.points.length < 2) continue
      // Walls at different heights do not join.
      if (Math.abs(o.path.points[0].z - P.z) > tol) continue
      const ends = o.path.closed ? [] : [o.path.points[0], o.path.points[o.path.points.length - 1]]
      if (ends.some((e) => flat(e).distanceTo(flat(P)) <= tol)) {
        out.push({ end, kind: 'L', other: i })
        break
      }
      const near = closestOnPolyline(o.path, P)
      const reach = Math.max(...Object.values(wallSides(o.params))) + tol
      if (near.distance <= reach && !ends.some((e) => flat(e).distanceTo(near.point) <= tol)) {
        out.push({ end, kind: 'T', other: i })
        break
      }
    }
  }
  return out
}

/** The area a closed flat curve encloses, seen from above. */
function planArea(g: AnyCurve): number {
  const p = samples(g).points
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return Math.abs(a) / 2
}

/** Lengths along a curve at its display samples, to go between distances and parameters. */
function lengthTable(g: AnyCurve): { params: number[]; lengths: number[] } {
  const { points, params } = samples(g)
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]))
  return { params, lengths }
}

/** The parameter at a distance along a curve from its start. */
export function paramAtLength(g: AnyCurve, distance: number): number {
  const { params, lengths } = lengthTable(g)
  const total = lengths[lengths.length - 1]
  const d = Math.min(Math.max(distance, 0), total)
  for (let i = 1; i < lengths.length; i++) {
    if (d <= lengths[i] || i === lengths.length - 1) {
      const span = lengths[i] - lengths[i - 1]
      const f = span > 0 ? (d - lengths[i - 1]) / span : 0
      return params[i - 1] + (params[i] - params[i - 1]) * f
    }
  }
  return params[0]
}

/** How far along a curve (from its start) its point closest to `p` is, seen from above. */
export function lengthAtPoint(g: AnyCurve, p: Vector3): number {
  const z = startPoint(g).z
  const t = closestPoint(g, new Vector3(p.x, p.y, z)).t
  const { params, lengths } = lengthTable(g)
  for (let i = 1; i < params.length; i++) {
    if (t <= params[i] || i === params.length - 1) {
      const span = params[i] - params[i - 1]
      const f = span !== 0 ? (t - params[i - 1]) / span : 0
      return lengths[i - 1] + (lengths[i] - lengths[i - 1]) * f
    }
  }
  return 0
}

/** The total length of a curve, as measured for openings. */
export const pathLength = (g: AnyCurve) => {
  const { lengths } = lengthTable(g)
  return lengths[lengths.length - 1]
}

/** A box: a corner and its three edges. */
export interface Box {
  origin: Vector3
  u: Vector3
  v: Vector3
  w: Vector3
}

/**
 * The box an opening cuts out of a wall: its width along the path, through the wall's whole
 * thickness (and a bit more), from its sill up by its height.
 */
export function openingBox(path: AnyCurve, params: WallParams, opening: Opening): Box {
  const t = paramAtLength(path, opening.at)
  const middle = pointAt(path, t)
  const along = tangentAt(path, t)
  along.z = 0
  along.normalize()
  const left = UP.clone().cross(along).normalize()
  const { left: l, right: r } = wallSides(params)
  // Through the wall, with a margin on both faces so the cut leaves no skin.
  const margin = Math.max(params.thickness, 1)
  const origin = middle
    .clone()
    .addScaledVector(along, -opening.width / 2)
    .addScaledVector(left, -r - margin)
    .addScaledVector(UP, opening.sill)
  return {
    origin,
    u: along.multiplyScalar(opening.width),
    v: left.multiplyScalar(l + r + 2 * margin),
    w: UP.clone().multiplyScalar(opening.height),
  }
}

/** The pieces filling an opening: a window's frame and glass, a door's frame and leaf. */
export type OpeningPart = 'frame' | 'glass' | 'leaf'

export const OPENING_PARTS: Record<Opening['kind'], OpeningPart[]> = { window: ['frame', 'glass'], door: ['frame', 'leaf'] }

/** Sizes of the pieces, in model units (millimeters). */
export const FRAME = { depth: 70, profile: 60, glass: 20, leaf: 40, gap: 5 }

/** A piece of an opening: a box, less another one (a frame is its outline less its inside). */
export interface PartBoxes {
  add: Box
  cut?: Box
}

/**
 * The box spanning ranges in an opening's own directions: along the wall from its middle, across it
 * (to the left of the path) and up from the wall's base.
 */
function boxAt(path: AnyCurve, opening: Opening, along: [number, number], across: [number, number], up: [number, number]): Box {
  const t = paramAtLength(path, opening.at)
  const a = tangentAt(path, t)
  a.z = 0
  a.normalize()
  const l = UP.clone().cross(a).normalize()
  return {
    origin: pointAt(path, t).addScaledVector(a, along[0]).addScaledVector(l, across[0]).addScaledVector(UP, up[0]),
    u: a.clone().multiplyScalar(along[1] - along[0]),
    v: l.clone().multiplyScalar(across[1] - across[0]),
    w: UP.clone().multiplyScalar(up[1] - up[0]),
  }
}

/** The boxes of one piece of an opening, set in the middle of the wall's thickness. */
export function openingPart(path: AnyCurve, params: WallParams, opening: Opening, part: OpeningPart): PartBoxes {
  const { left, right } = wallSides(params)
  // Across: the middle of the wall, from the path.
  const c = (left - right) / 2
  const depth = Math.min(FRAME.depth, params.thickness)
  const profile = Math.min(FRAME.profile, opening.width / 4, opening.height / 4)
  const w = opening.width / 2
  const bottom = opening.sill
  const top = opening.sill + opening.height
  const door = opening.kind === 'door'
  // The inside of the frame (doors have no bottom rail).
  const inside = { along: [-w + profile, w - profile] as [number, number], up: [door ? bottom : bottom + profile, top - profile] as [number, number] }
  const across = (d: number): [number, number] => [c - d / 2, c + d / 2]
  if (part === 'frame') {
    return {
      add: boxAt(path, opening, [-w, w], across(depth), [bottom, top]),
      cut: boxAt(path, opening, inside.along, across(depth * 3), [door ? bottom - depth : inside.up[0], inside.up[1]]),
    }
  }
  if (part === 'glass') return { add: boxAt(path, opening, inside.along, across(Math.min(FRAME.glass, depth / 2)), inside.up) }
  // A door leaf, closed, with a small gap all round.
  const g = FRAME.gap
  return { add: boxAt(path, opening, [inside.along[0] + g, inside.along[1] - g], across(Math.min(FRAME.leaf, depth)), [inside.up[0] + g, inside.up[1] - g]) }
}

/** Checks an opening fits in its wall: along the path and under the wall's top. */
export function checkOpening(path: AnyCurve, params: WallParams, opening: Opening): string | null {
  if (!(opening.width > 0) || !(opening.height > 0)) return 'The opening needs a width and a height'
  if (opening.sill < 0 || opening.sill + opening.height > params.height + 1e-9) return 'The opening does not fit under the top of the wall'
  if (!isClosed(path)) {
    const total = pathLength(path)
    if (opening.at - opening.width / 2 < -1e-9 || opening.at + opening.width / 2 > total + 1e-9) return 'The opening does not fit along the wall'
  }
  return null
}

/** Reads wall parameters as saved in a history record, with defaults for anything missing. */
export function wallParams(p: Record<string, unknown> | undefined, fallbackHeight = DEFAULT_LEVELS[0].height): WallParams {
  const j = p?.justification
  return {
    thickness: Number(p?.thickness ?? DEFAULT_WALL.thickness),
    height: Number(p?.height ?? fallbackHeight),
    justification: j === 'left' || j === 'right' ? j : 'center',
    openings: Array.isArray(p?.openings) ? (p.openings as Opening[]).map((o) => ({ ...o })) : [],
    ...wallLayers(p?.layers),
  }
}

/** Layers as saved, if there are any valid ones. */
function wallLayers(value: unknown): { layers?: WallLayer[] } {
  if (!Array.isArray(value)) return {}
  const layers = (value as WallLayer[]).filter((l) => typeof l?.name === 'string' && Number(l.thickness) > 0).map((l) => ({ ...l, thickness: Number(l.thickness) }))
  return layers.length > 0 ? { layers } : {}
}

export const slabParams = (p: Record<string, unknown> | undefined): SlabParams => {
  const holes = Array.isArray(p?.holes) ? (p.holes as SlabHole[]).filter((h) => Array.isArray(h?.points) && h.points.length >= 3) : []
  return { thickness: Number(p?.thickness ?? DEFAULT_SLAB.thickness), ...(holes.length > 0 ? { holes } : {}) }
}

/** The level a height belongs to: the highest one at or below it. */
export function levelAt(levels: readonly Level[], z: number): Level | null {
  let best: Level | null = null
  for (const level of levels) if (level.elevation <= z + 1e-6 && (!best || level.elevation > best.elevation)) best = level
  return best
}
