import { Vector3 } from 'three'
import { stairPlan, type StairParams } from './buildingParts'
import type { AnyCurve } from './geometry'

/**
 * Railings: posts, a handrail and infill (vertical bars or horizontal rails) along a line, which can
 * slope (up a stair) or run level (along a slab edge or a balcony). On a stair they follow the line
 * of the steps' noses up each flight, on both sides or one, and the free edges of its landings.
 */

export type RailingStyle = 'bars' | 'rails'
export type RailingSides = 'both' | 'left' | 'right'

export interface RailingParams {
  /** Height of the top of the handrail above the line (the steps' noses on a stair). */
  height: number
  style: RailingStyle
  /** On a stair, which sides get a railing (looking up it). */
  sides: RailingSides
}

export const DEFAULT_RAILING: RailingParams = { height: 1000, style: 'bars', sides: 'both' }

export function railingParams(p: Record<string, unknown> | undefined): RailingParams {
  return {
    height: Number(p?.height ?? DEFAULT_RAILING.height),
    style: p?.style === 'rails' ? 'rails' : 'bars',
    sides: p?.sides === 'left' || p?.sides === 'right' ? p.sides : 'both',
  }
}

/** Sizes of the pieces, in model units (millimeters). */
export const RAILING = { post: 50, rail: 50, bar: 20, barGap: 100, postSpacing: 1200, inset: 40, bottom: 100 }

const UP = new Vector3(0, 0, 1)
const flat = (v: Vector3) => new Vector3(v.x, v.y, 0)

/** A box: a corner and its three edges (which need not be square: a sloping rail leans). */
export interface RailBox {
  origin: Vector3
  u: Vector3
  v: Vector3
  w: Vector3
}

/**
 * The lines a stair's railings run along: up each flight on the chosen sides, along the steps'
 * noses (from the first nose to the last, then level to the top), and round the free edges of its
 * landings (those no flight or other landing touches), a little in from the stair's edges.
 */
export function stairRailingLines(line: AnyCurve, stair: StairParams, sides: RailingSides): Vector3[][] {
  const plan = stairPlan(line, stair)
  const offset = stair.width / 2 - RAILING.inset
  const wanted = sides === 'both' ? [1, -1] : sides === 'left' ? [1] : [-1]
  const out: Vector3[][] = []
  for (const f of plan.flights) {
    const dir = flat(f.end).sub(flat(f.start))
    const length = dir.length()
    dir.normalize()
    const left = UP.clone().cross(dir).normalize()
    const height = f.risers * f.riser
    for (const side of wanted) {
      const at = (s: number, z: number) => f.start.clone().addScaledVector(dir, s).addScaledVector(left, side * offset).addScaledVector(UP, f.base + z)
      const points = [at(0, f.riser), at(length - f.tread, height)]
      if (f.risers > 1) points.push(at(length, height))
      out.push(points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-9))
    }
  }
  // Landing edges: the four sides of each landing's top, less those a flight or landing meets.
  const touching = [...plan.flights.flatMap((f) => [f.start, f.end].map(flat))]
  const edges = plan.landings.flatMap((l) => {
    const c0 = l.origin.clone().add(l.w)
    const corners = [c0, c0.clone().add(l.u), c0.clone().add(l.u).add(l.v), c0.clone().add(l.v)]
    const centre = c0.clone().addScaledVector(l.u, 0.5).addScaledVector(l.v, 0.5)
    return corners.map((a, i) => ({ a, b: corners[(i + 1) % 4], centre }))
  })
  const tol = Math.max(1e-6, stair.width * 1e-6)
  const middle = (e: { a: Vector3; b: Vector3 }) => flat(e.a.clone().lerp(e.b, 0.5))
  for (const e of edges) {
    const m = middle(e)
    if (touching.some((t) => t.distanceTo(m) < tol)) continue
    if (edges.some((o) => o !== e && middle(o).distanceTo(m) < tol)) continue
    // Moved in from the edge, towards the landing's middle.
    const inward = flat(e.centre).sub(m).normalize().multiplyScalar(RAILING.inset)
    out.push([e.a.clone().add(inward), e.b.clone().add(inward)])
  }
  return out
}

/**
 * The pieces of a railing along a line: posts at its corners and at most a post spacing apart, a
 * handrail on top, and bars (upright, a bar gap apart) or rails (three level ones) between the posts.
 */
export function railingPieces(points: Vector3[], params: RailingParams): RailBox[] {
  if (!(params.height > RAILING.rail + RAILING.bottom)) throw new Error('The railing is too low')
  const boxes: RailBox[] = []
  const h = params.height
  const square = (size: number, d: Vector3) => {
    const across = UP.clone().cross(flat(d).normalize()).normalize()
    return { across, half: size / 2 }
  }
  // An upright piece of a given section, from a point up by a height.
  const upright = (p: Vector3, d: Vector3, size: number, from: number, to: number) => {
    const { across, half } = square(size, d)
    const along = flat(d).normalize()
    boxes.push({
      origin: p.clone().addScaledVector(along, -half).addScaledVector(across, -half).addScaledVector(UP, from),
      u: along.multiplyScalar(size),
      v: across.multiplyScalar(size),
      w: UP.clone().multiplyScalar(to - from),
    })
  }
  // A piece along a segment (level or sloping), of a given section, at a height above it.
  const along = (a: Vector3, b: Vector3, size: number, z: number) => {
    const { across, half } = square(size, b.clone().sub(a))
    boxes.push({
      origin: a.clone().addScaledVector(across, -half).addScaledVector(UP, z),
      u: b.clone().sub(a),
      v: across.multiplyScalar(size),
      w: UP.clone().multiplyScalar(size),
    })
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const d = b.clone().sub(a)
    const run = flat(d).length()
    if (run < 1e-9) continue
    along(a, b, RAILING.rail, h - RAILING.rail)
    // Posts: at the start (and the end of the last segment), and evenly between, a spacing at most.
    const posts = Math.max(1, Math.ceil(run / RAILING.postSpacing))
    for (let k = 0; k <= posts; k++) {
      if (k === posts && i < points.length - 1) continue
      upright(a.clone().addScaledVector(d, k / posts), d, RAILING.post, 0, h - RAILING.rail)
    }
    if (params.style === 'bars') {
      const bars = Math.floor(run / (RAILING.bar + RAILING.barGap))
      for (let k = 1; k < bars; k++) {
        const t = k / bars
        upright(a.clone().addScaledVector(d, t), d, RAILING.bar, RAILING.bottom, h - RAILING.rail)
      }
    } else {
      for (const z of [0.25, 0.5, 0.75]) along(a, b, RAILING.bar, RAILING.bottom + (h - RAILING.rail - RAILING.bottom) * z)
    }
  }
  return boxes
}
