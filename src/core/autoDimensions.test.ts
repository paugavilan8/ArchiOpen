import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { findJoins, wallOutline, wallParams } from './architecture'
import { wallDimensions, type DimensionedWall } from './autoDimensions'
import type { AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const length = (d: { from: Vector3; to: Vector3 }) => Math.round(d.from.distanceTo(d.to))

/** Walls with their outlines joined, as the kernel makes them. */
function walls(...defs: { path: AnyCurve; params: Record<string, unknown> }[]): DimensionedWall[] {
  const refs = defs.map((d) => ({ path: d.path, params: wallParams(d.params) }))
  return refs.map((w, i) => {
    const others = refs.filter((_, j) => j !== i)
    const joins = findJoins(w, others).map((j) => ({ ...j, other: others[j.other] }))
    return { ...w, outline: wallOutline(w.path, w.params, joins) }
  })
}

describe('wall dimensions', () => {
  it('chains the outside of a room through its openings, then its overall length', () => {
    const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0), v(6000, 4000), v(0, 4000)], closed: true }
    const window = { id: 1, kind: 'window', at: 3000, width: 1200, height: 1200, sill: 900 }
    const dims = wallDimensions(walls({ path: room, params: { thickness: 200, height: 3000, openings: [window] } }), { offset: 600 })
    // The bottom face (y = -100): corner, window, window, corner; then 6200 overall.
    const bottom = dims.filter((d) => Math.abs(d.from.y + 100) < 1e-6 && Math.abs(d.to.y + 100) < 1e-6)
    expect(bottom.map(length)).toEqual([2500, 1200, 2500, 6200])
    // The chain on the first row, the total on the second, outside the wall.
    expect(bottom[0].at.y).toBeCloseTo(-700, 6)
    expect(bottom[3].at.y).toBeCloseTo(-1300, 6)
    // The other three sides have no openings: just their totals, on the first row.
    expect(dims).toHaveLength(4 + 3)
    expect(dims.filter((d) => length(d) === 4200)).toHaveLength(2)
  })

  it('measures mitred corners of separate walls, and leaves inside walls alone', () => {
    const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })
    const p = { thickness: 200, height: 3000 }
    const dims = wallDimensions(
      walls(
        { path: line(v(0, 0), v(8000, 0)), params: p },
        { path: line(v(8000, 0), v(8000, 5000)), params: p },
        { path: line(v(8000, 5000), v(0, 5000)), params: p },
        { path: line(v(0, 5000), v(0, 0)), params: p },
        // An inside wall across the middle.
        { path: line(v(4000, 0), v(4000, 5000)), params: p },
      ),
      { offset: 600 },
    )
    expect(dims.map(length).sort((a, b) => a - b)).toEqual([5200, 5200, 8200, 8200])
  })
})
