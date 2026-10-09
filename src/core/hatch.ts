import { ShapeUtils, Vector2, Vector3 } from 'three'
import type { HatchGeometry } from './geometry'
import { tessellate } from './geometry'

/**
 * Hatch fills: a solid fill, or families of parallel (possibly dashed) lines clipped to the region
 * inside the boundary loops. Loops inside loops are holes, by the even-odd rule. Patterns are
 * defined at scale 1 in model units and turn with the hatch's rotation.
 */

interface LineFamily {
  /** Direction of the lines, in degrees. */
  angle: number
  /** A point every line of the family is offset from. */
  base?: [number, number]
  /** Shift from one line to the next: along the lines (for staggered dashes) and across them. */
  offset: [along: number, across: number]
  /** Dash pattern along the lines: positive lengths are drawn, negative ones are gaps. */
  dashes?: number[]
}

export const HATCH_PATTERNS: Record<string, LineFamily[]> = {
  Solid: [],
  Lines: [{ angle: 45, offset: [0, 1] }],
  Cross: [
    { angle: 45, offset: [0, 1] },
    { angle: 135, offset: [0, 1] },
  ],
  Grid: [
    { angle: 0, offset: [0, 1] },
    { angle: 90, offset: [0, 1] },
  ],
  Brick: [
    { angle: 0, offset: [0, 1] },
    { angle: 90, offset: [1, 1], dashes: [1, -1] },
  ],
  Dashes: [{ angle: 0, offset: [0.5, 0.5], dashes: [1, -0.5] }],
}

export const PATTERN_NAMES = Object.keys(HATCH_PATTERNS)

/** Most lines a hatch may draw before the pattern is considered too dense for its scale. */
const MAX_LINES = 20000

const toPlane = (g: HatchGeometry) => (p: Vector3) => {
  const d = p.clone().sub(g.origin)
  return new Vector2(d.dot(g.xaxis), d.dot(g.yaxis))
}
const toModel = (g: HatchGeometry) => (q: Vector2) => g.origin.clone().addScaledVector(g.xaxis, q.x).addScaledVector(g.yaxis, q.y)

/** The boundary loops as closed polygons in the hatch plane (the last point is not repeated). */
export function hatchPolygons(g: HatchGeometry): Vector2[][] {
  const flat = toPlane(g)
  return g.loops.map((loop) => {
    const pts = tessellate(loop).map(flat)
    if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop()
    return pts
  })
}

/** Parameters along a line where it crosses the polygons, sorted: inside between pairs. */
function crossings(polygons: Vector2[][], origin: Vector2, u: Vector2, n: Vector2): number[] {
  const ts: number[] = []
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const c = poly[(i + 1) % poly.length]
      const da = (a.x - origin.x) * n.x + (a.y - origin.y) * n.y
      const dc = (c.x - origin.x) * n.x + (c.y - origin.y) * n.y
      // Half-open test, so a line through a vertex counts it once.
      if (da > 0 === dc > 0) continue
      const f = da / (da - dc)
      const x = a.x + (c.x - a.x) * f - origin.x
      const y = a.y + (c.y - a.y) * f - origin.y
      ts.push(x * u.x + y * u.y)
    }
  }
  return ts.sort((p, q) => p - q)
}

/** Pieces of [t0, t1] where the dash pattern (starting at t = 0) is drawn. */
function dashed(t0: number, t1: number, dashes: number[]): [number, number][] {
  const period = dashes.reduce((sum, d) => sum + Math.abs(d), 0)
  if (period <= 0) return [[t0, t1]]
  const out: [number, number][] = []
  let start = Math.floor(t0 / period) * period
  while (start < t1) {
    let at = start
    for (const d of dashes) {
      const end = at + Math.abs(d)
      if (d > 0) {
        const a = Math.max(at, t0)
        const b = Math.min(end, t1)
        if (b > a) out.push([a, b])
      }
      at = end
    }
    start += period
  }
  return out
}

/** The pattern lines of a hatch, as segments in model coordinates. Solid hatches have none. */
export function hatchLines(g: HatchGeometry): Vector3[][] {
  const families = HATCH_PATTERNS[g.pattern] ?? []
  if (families.length === 0) return []
  const polygons = hatchPolygons(g)
  const all = polygons.flat()
  if (all.length < 3) return []
  const model = toModel(g)
  const lines: Vector3[][] = []
  for (const family of families) {
    const angle = (family.angle * Math.PI) / 180 + g.rotation
    const u = new Vector2(Math.cos(angle), Math.sin(angle))
    const n = new Vector2(-u.y, u.x)
    const base = new Vector2(...(family.base ?? [0, 0])).multiplyScalar(g.scale).rotateAround(new Vector2(), g.rotation)
    const [along, across] = family.offset.map((v) => v * g.scale)
    const step = u.clone().multiplyScalar(along).addScaledVector(n, across)
    // Range of lines that can meet the region.
    let lo = Infinity
    let hi = -Infinity
    for (const p of all) {
      const d = p.clone().sub(base).dot(n) / across
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    if (hi - lo > MAX_LINES) throw new Error('The hatch pattern is too dense for this region: use a larger scale')
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
      const origin = base.clone().addScaledVector(step, k)
      const ts = crossings(polygons, origin, u, n)
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const pieces = family.dashes ? dashed(ts[i], ts[i + 1], family.dashes.map((d) => d * g.scale)) : [[ts[i], ts[i + 1]]]
        for (const [a, b] of pieces) lines.push([model(origin.clone().addScaledVector(u, a)), model(origin.clone().addScaledVector(u, b))])
        if (lines.length > MAX_LINES) throw new Error('The hatch pattern is too dense for this region: use a larger scale')
      }
    }
  }
  return lines
}

function inside(p: Vector2, poly: Vector2[]): boolean {
  let odd = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd
  }
  return odd
}

/**
 * The filled region as triangles in model coordinates (flat x, y, z per vertex, three vertices per
 * triangle). Loops nested an even number of times are outlines, the others holes in them.
 */
export function hatchTriangles(g: HatchGeometry): number[] {
  const polygons = hatchPolygons(g).filter((p) => p.length >= 3)
  const depth = polygons.map((p, i) => polygons.filter((q, j) => j !== i && inside(p[0], q)).length)
  const model = toModel(g)
  const out: number[] = []
  polygons.forEach((outer, i) => {
    if (depth[i] % 2 !== 0) return
    const holes = polygons.filter((p, j) => depth[j] === depth[i] + 1 && inside(p[0], outer))
    // The triangulation may reverse the loops in place, so the vertex list is taken afterwards.
    const triangles = ShapeUtils.triangulateShape(outer, holes)
    const points = [outer, ...holes].flat()
    for (const tri of triangles) {
      for (const index of tri) {
        const p = model(points[index])
        out.push(p.x, p.y, p.z)
      }
    }
  })
  return out
}
