import { Vector3 } from 'three'
import { chain, closestPoint, reverse } from './curves'
import { offset } from './offset'
import { AnyCurve, endPoint, isClosed, pointAt, samples, startPoint, tangentAt } from './geometry'

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
}

export interface WallParams {
  thickness: number
  height: number
  /** Which side of the path the wall lies on, looking along the path. */
  justification: Justification
  openings: Opening[]
}

export interface SlabParams {
  thickness: number
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
function offsetLeft(g: AnyCurve, distance: number): AnyCurve | null {
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
export function wallOutline(path: AnyCurve, params: Pick<WallParams, 'thickness' | 'justification'>): AnyCurve[] {
  if (!(params.thickness > 0)) throw new Error('The wall thickness must be positive')
  const { left, right } = wallSides(params)
  const a = offsetLeft(path, left)
  const b = offsetLeft(path, -right)
  if (!a || !b) throw new Error('The wall is too thick for the bends of its path')
  // Around a room, the outer curve is the one enclosing more (which side is left depends on the
  // way the path runs).
  if (isClosed(path)) return planArea(a) >= planArea(b) ? [a, b] : [b, a]
  const line = (p: Vector3, q: Vector3): AnyCurve => ({ type: 'polyline', points: [p.clone(), q.clone()], closed: false })
  const loop = chain([a, line(endPoint(a), endPoint(b)), reverse(b), line(startPoint(b), startPoint(a))])
  if (!loop) throw new Error('The wall outline could not be made')
  return [loop.type === 'polyline' ? { ...loop, closed: true } : loop]
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
  }
}

export const slabParams = (p: Record<string, unknown> | undefined): SlabParams => ({ thickness: Number(p?.thickness ?? DEFAULT_SLAB.thickness) })

/** The level a height belongs to: the highest one at or below it. */
export function levelAt(levels: readonly Level[], z: number): Level | null {
  let best: Level | null = null
  for (const level of levels) if (level.elevation <= z + 1e-6 && (!best || level.elevation > best.elevation)) best = level
  return best
}
