import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { box, cylinder, revolveCurve, sphere } from './brep'
import { unrollShape } from './unroll'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
/** Area of a flattened face: outer loop less its holes (loops wind opposite ways). */
const signed = (loop: Vector3[]) => loop.reduce((s, p, i) => s + p.x * loop[(i + 1) % loop.length].y - loop[(i + 1) % loop.length].x * p.y, 0) / 2
const area = (loops: Vector3[][]) => Math.abs(loops.reduce((s, l) => s + signed(l), 0))
const total = (faces: Vector3[][][]) => faces.reduce((s, f) => s + area(f), 0)
const bounds = (faces: Vector3[][][]) => {
  const pts = faces.flat(2)
  return { w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)), z: Math.max(...pts.map((p) => Math.abs(p.z))) }
}

describe('UnrollSrf', () => {
  it('unfolds a box into one connected net of its six faces, keeping their areas', () => {
    const result = unrollShape(box(v(0, 0), v(2, 0), v(0, 3), v(0, 0, 4)))
    expect(result.skipped).toBe(0)
    expect(result.faces).toHaveLength(6)
    expect(total(result.faces)).toBeCloseTo(2 * (6 + 8 + 12), 9)
    expect(bounds(result.faces).z).toBe(0)
    // Joined along their edges, the faces do not overlap: the net covers exactly their area.
    // (Each face is a rectangle; its sides keep their lengths.)
    for (const [loop] of result.faces) {
      const sides = loop.map((p, i) => p.distanceTo(loop[(i + 1) % loop.length])).sort((a, b) => a - b)
      expect([2, 3, 4].some((s) => Math.abs(sides[0] - s) < 1e-9)).toBe(true)
    }
    // Apart, the faces are laid in a row instead.
    const apart = unrollShape(box(v(0, 0), v(2, 0), v(0, 3), v(0, 0, 4)), true)
    expect(bounds(apart.faces).h).toBeCloseTo(4, 9)
  })

  it('unrolls a cylinder: its side into a 2πr × h rectangle, its caps as discs', () => {
    const result = unrollShape(cylinder(v(0, 0), 1, 2, v(0, 0, 1)))
    expect(result.skipped).toBe(0)
    expect(result.faces).toHaveLength(3)
    const side = result.faces.find((f) => Math.abs(area(f) - 4 * Math.PI) < 1e-3)!
    expect(side).toBeDefined()
    const b = bounds([side])
    expect(Math.max(b.w, b.h)).toBeCloseTo(2 * Math.PI, 6)
    expect(Math.min(b.w, b.h)).toBeCloseTo(2, 6)
    // The caps' circles are drawn with 64 segments: their area is within 0.1 %.
    expect(Math.abs(total(result.faces) / (6 * Math.PI) - 1)).toBeLessThan(1e-3)
  })

  it('unrolls a cone frustum into an annular sector of the same area', () => {
    // The side of a frustum, turned from a slanted line (radius 2 at the base, 1 at the top).
    const side = revolveCurve({ type: 'polyline', points: [v(2, 0, 0), v(1, 0, 3)], closed: false }, v(0, 0), v(0, 0, 1), 2 * Math.PI)
    const result = unrollShape(side)
    expect(result.skipped).toBe(0)
    const slant = Math.hypot(3, 1)
    const lateral = Math.PI * (2 + 1) * slant
    expect(result.faces.some((f) => Math.abs(area(f) - lateral) < 1e-2)).toBe(true)
  })

  it('skips faces that cannot be flattened exactly', () => {
    const result = unrollShape(sphere(v(0, 0), 1))
    expect(result.skipped).toBe(1)
    expect(result.faces).toHaveLength(0)
  })
})
