import { Vector3 } from 'three'
import { pathLength, wallSides, type WallParams } from './architecture'
import { tessellate, type AnyCurve } from './geometry'

/**
 * Plan dimensions for walls, as an architect draws them outside a plan: along the outer face of each
 * straight stretch of the building's outside walls, a chain from corner to corner through the edges
 * of its openings and, further out, its overall length.
 */

/** A wall as dimensioning sees it: its path, parameters and plan outline (with its joins). */
export interface DimensionedWall {
  path: AnyCurve
  params: WallParams
  outline: AnyCurve[]
}

/** One aligned dimension: between two points, its line through a third. */
export interface PlanDimension {
  from: Vector3
  to: Vector3
  at: Vector3
}

export interface DimensionOptions {
  /** Distance of the first row from the wall's face, and between rows. */
  offset: number
}

const UP = new Vector3(0, 0, 1)
const flat = (v: Vector3) => new Vector3(v.x, v.y, 0)

/** The straight stretches of a path (its segments), with where each starts along it. */
function segments(path: AnyCurve): { a: Vector3; b: Vector3; start: number }[] {
  if (path.type !== 'polyline') return []
  const pts = path.closed ? [...path.points, path.points[0]] : path.points
  const out: { a: Vector3; b: Vector3; start: number }[] = []
  let start = 0
  for (let i = 1; i < pts.length; i++) {
    const length = flat(pts[i]).distanceTo(flat(pts[i - 1]))
    if (length > 1e-9) out.push({ a: pts[i - 1], b: pts[i], start })
    start += length
  }
  return out
}

/** Does the flat ray from p along d meet the segment a–b (beyond p)? */
function hits(p: Vector3, d: Vector3, a: Vector3, b: Vector3): boolean {
  const e = flat(b).sub(flat(a))
  const denom = d.x * e.y - d.y * e.x
  if (Math.abs(denom) < 1e-12) return false
  const w = flat(a).sub(flat(p))
  const t = (w.x * e.y - w.y * e.x) / denom
  const s = (w.x * d.y - w.y * d.x) / denom
  return t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9
}

/** The dimensions of the outside faces of some walls. */
export function wallDimensions(walls: readonly DimensionedWall[], options: DimensionOptions): PlanDimension[] {
  const all = walls.flatMap((w) => segments(w.path).map((s) => ({ ...s, wall: w })))
  if (all.length === 0) return []
  const centre = all.reduce((sum, s) => sum.add(flat(s.a)).add(flat(s.b)), new Vector3()).multiplyScalar(1 / (2 * all.length))
  const out: PlanDimension[] = []
  for (const seg of all) {
    const dir = flat(seg.b).sub(flat(seg.a))
    const length = dir.length()
    dir.normalize()
    const left = UP.clone().cross(dir).normalize()
    const mid = flat(seg.a).lerp(flat(seg.b), 0.5)
    // Outward: away from the middle of the walls.
    const side = left.dot(mid.clone().sub(centre)) >= 0 ? 1 : -1
    const out_ = left.clone().multiplyScalar(side)
    // Inside faces (another wall in front of them) are not dimensioned outside.
    if (all.some((o) => o !== seg && hits(mid, out_, o.a, o.b))) continue
    const sides = wallSides(seg.wall.params)
    const face = side > 0 ? sides.left : sides.right
    const z = seg.a.z
    const origin = new Vector3(seg.a.x, seg.a.y, z).addScaledVector(out_, face)
    // The face's ends: the outline's corners on the face line (mitred corners reach past the path).
    const tol = Math.max(1e-6, seg.wall.params.thickness * 1e-6)
    const along = seg.wall.outline
      .flatMap((c) => tessellate(c))
      .filter((p) => Math.abs(flat(p).sub(flat(origin)).dot(out_)) < tol)
      .map((p) => flat(p).sub(flat(origin)).dot(dir))
      .filter((t) => t > -seg.wall.params.thickness * 2 - 1 && t < length + seg.wall.params.thickness * 2 + 1)
    if (along.length < 2) continue
    const t0 = Math.min(...along)
    const t1 = Math.max(...along)
    // Openings on this stretch: their edges.
    const total = pathLength(seg.wall.path)
    const cuts = seg.wall.params.openings
      .map((o) => ({ o, at: ((o.at % total) + total) % total }))
      .filter(({ at }) => at > seg.start - 1e-9 && at < seg.start + length + 1e-9)
      .flatMap(({ o, at }) => [at - seg.start - o.width / 2, at - seg.start + o.width / 2])
      .filter((t) => t > t0 + 1e-6 && t < t1 - 1e-6)
    const point = (t: number) => origin.clone().addScaledVector(dir, t)
    const row = (n: number) => out_.clone().multiplyScalar(options.offset * n)
    const chain = [t0, ...[...new Set(cuts.map((t) => +t.toFixed(9)))].sort((a, b) => a - b), t1]
    let rowNumber = 1
    if (chain.length > 2) {
      for (let i = 1; i < chain.length; i++) out.push({ from: point(chain[i - 1]), to: point(chain[i]), at: point(chain[i - 1]).add(row(1)) })
      rowNumber = 2
    }
    out.push({ from: point(t0), to: point(t1), at: point(t0).add(row(rowNumber)) })
  }
  return out
}
