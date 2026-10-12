import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { stairParams } from './buildingParts'
import type { AnyCurve } from './geometry'
import { RAILING, railingParams, railingPieces, stairRailingLines } from './railings'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const line = (...points: Vector3[]): AnyCurve => ({ type: 'polyline', points, closed: false })
const top = (b: { origin: Vector3; w: Vector3 }) => b.origin.z + b.w.z

describe('railing pieces', () => {
  it('puts posts at most a spacing apart, a handrail on top and bars between', () => {
    const pieces = railingPieces([v(0, 0), v(3000, 0)], railingParams({ height: 1000 }))
    const posts = pieces.filter((b) => b.u.length() === RAILING.post && b.w.z > 500)
    // 3000 at most 1200 apart: posts at 0, 1000, 2000, 3000.
    expect(posts.map((b) => Math.round(b.origin.x + RAILING.post / 2))).toEqual([0, 1000, 2000, 3000])
    const rail = pieces.find((b) => b.u.length() === 3000)!
    expect(top(rail)).toBeCloseTo(1000, 9)
    const bars = pieces.filter((b) => b.u.length() === RAILING.bar)
    // Gaps no wider than the bar gap.
    const xs = bars.map((b) => b.origin.x).sort((a, b) => a - b)
    expect(Math.max(...xs.slice(1).map((x, i) => x - xs[i]))).toBeLessThanOrEqual(RAILING.bar + RAILING.barGap + 1e-9)
    expect(Math.min(...bars.map((b) => b.origin.z))).toBe(RAILING.bottom)
  })

  it('makes three level rails instead of bars, and slopes with its line', () => {
    const pieces = railingPieces([v(0, 0, 0), v(3000, 0, 2000)], railingParams({ style: 'rails', height: 900 }))
    const sloping = pieces.filter((b) => b.u.length() > 3000)
    expect(sloping).toHaveLength(4)
    // The handrail stays 900 over the line all the way up.
    const rail = sloping.reduce((a, b) => (top(a) > top(b) ? a : b))
    expect(top(rail)).toBeCloseTo(900, 9)
    expect(rail.origin.z + rail.u.z + rail.w.z).toBeCloseTo(2900, 9)
  })
})

describe('stair railings', () => {
  const stair = stairParams({ width: 1000, risers: 16 }, 2800)

  it('runs along the noses of a straight stair, on both sides or one', () => {
    const lines = stairRailingLines(line(v(0, 0), v(0, 4000)), stair, 'both')
    expect(lines).toHaveLength(2)
    const [a] = lines
    // From the first nose (one riser up) to the last (all but one tread along), then level.
    expect(a[0].z).toBeCloseTo(175, 9)
    expect(a[1].y).toBeCloseTo(4000 - 250, 9)
    expect(a[1].z).toBeCloseTo(2800, 9)
    expect(a[2].y).toBeCloseTo(4000, 9)
    expect(Math.abs(a[0].x)).toBeCloseTo(500 - RAILING.inset, 9)
    expect(stairRailingLines(line(v(0, 0), v(0, 4000)), stair, 'left')).toHaveLength(1)
  })

  it('goes round the free edges of landings', () => {
    // L: two flights on both sides, and the landing's two outer edges.
    expect(stairRailingLines(line(v(0, 0), v(0, 3500), v(2500, 3500)), stair, 'both')).toHaveLength(6)
    // U: two flights on both sides, and two free edges on each of the two landings.
    const u = stairRailingLines(line(v(0, 0), v(0, 3000), v(1000, 3000), v(1000, 0)), stair, 'both')
    expect(u).toHaveLength(8)
  })
})
