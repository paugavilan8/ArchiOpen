import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { columnOutline, comfortable, roofPlan, roofParams, stairPlan, stairParams } from './buildingParts'
import type { AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const rect = (w: number, d: number, z = 0): AnyCurve => ({ type: 'polyline', points: [v(0, 0, z), v(w, 0, z), v(w, d, z), v(0, d, z)], closed: true })

describe('roof plans', () => {
  it('slopes every side of a hip roof, and reaches out by the overhang', () => {
    const plan = roofPlan(rect(10000, 8000, 3000), roofParams({ type: 'hip', pitch: 30, overhang: 500 }))
    expect(plan.slopes).toHaveLength(4)
    const xs = plan.eaves.points.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(-500, 9)
    expect(Math.max(...xs)).toBeCloseTo(10500, 9)
    // Each slope rises inward at the pitch from its side, at the outline's height.
    for (const s of plan.slopes) {
      expect(s.origin.z).toBe(3000)
      expect(Math.acos(s.normal.z) * (180 / Math.PI)).toBeCloseTo(30, 9)
    }
  })

  it('slopes only the long sides of a gable roof, and one side of a shed roof', () => {
    expect(roofPlan(rect(10000, 6000), roofParams({ type: 'gable' })).slopes).toHaveLength(2)
    const shed = roofPlan(rect(10000, 6000), roofParams({ type: 'shed' })).slopes
    expect(shed).toHaveLength(1)
    // Rising from the long side at y = 0 towards y = 6000 (either way round the outline is drawn).
    expect(shed[0].normal.y).toBeLessThan(0)
    const reversed: AnyCurve = { type: 'polyline', points: [v(0, 6000), v(10000, 6000), v(10000, 0), v(0, 0)], closed: true }
    expect(roofPlan(reversed, roofParams({ type: 'gable' })).slopes).toHaveLength(2)
  })

  it('refuses outlines it cannot roof', () => {
    const ell: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0), v(6000, 3000), v(3000, 3000), v(3000, 6000), v(0, 6000)], closed: true }
    expect(() => roofPlan(ell, roofParams({}))).toThrow(/convex/)
    expect(() => roofPlan({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }, roofParams({}))).toThrow()
  })
})

describe('stairs', () => {
  it('picks comfortable risers and equal treads along the run', () => {
    const plan = stairPlan({ type: 'polyline', points: [v(0, 0), v(4500, 0)], closed: false }, stairParams({ width: 1000 }, 3000))
    expect(plan.risers).toBe(17)
    expect(plan.riser * plan.risers).toBeCloseTo(3000, 9)
    expect(plan.tread * plan.risers).toBeCloseTo(4500, 9)
    expect(comfortable(plan.riser, plan.tread)).toBe(true)
    // Centred on the line, across its width.
    const ys = plan.profile.points.map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-500, 9)
    expect(plan.across.length()).toBeCloseTo(1000, 9)
    const zs = plan.profile.points.map((p) => p.z)
    expect(Math.max(...zs)).toBeCloseTo(3000, 9)
    expect(Math.min(...zs)).toBeCloseTo(0, 9)
  })

  it('takes a given number of risers', () => {
    const plan = stairPlan({ type: 'polyline', points: [v(0, 0, 3000), v(0, 3000, 3000)], closed: false }, stairParams({ risers: 12, height: 2400 }))
    expect(plan.risers).toBe(12)
    expect(plan.riser).toBeCloseTo(200, 9)
    expect(Math.min(...plan.profile.points.map((p) => p.z))).toBeCloseTo(3000, 9)
  })
})

describe('columns', () => {
  it('makes rectangles and circles centred on the point', () => {
    const r = columnOutline(v(1000, 2000, 0), 'rectangular', 300, 500)
    expect(r.type === 'polyline' && r.points.map((p) => [p.x, p.y])).toEqual([
      [850, 1750],
      [1150, 1750],
      [1150, 2250],
      [850, 2250],
    ])
    const c = columnOutline(v(0, 0, 0), 'round', 400, 0)
    expect(c.type === 'circle' && c.radius).toBe(200)
  })
})
