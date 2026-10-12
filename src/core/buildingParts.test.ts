import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { columnOutline, comfortable, curtainWallParams, curtainWallParts, divisions, roofPlan, roofParams, stairPlan, stairParams } from './buildingParts'
import type { AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const rect = (w: number, d: number, z = 0): AnyCurve => ({ type: 'polyline', points: [v(0, 0, z), v(w, 0, z), v(w, d, z), v(0, d, z)], closed: true })

describe('roof plans', () => {
  it('slopes every side of a hip roof, and reaches out by the overhang', () => {
    const plan = roofPlan(rect(10000, 8000, 3000), roofParams({ type: 'hip', pitch: 30, overhang: 500 }))
    expect(plan.pieces).toHaveLength(1)
    expect(plan.pieces[0].slopes).toHaveLength(4)
    const xs = plan.pieces[0].eaves.points.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(-500, 9)
    expect(Math.max(...xs)).toBeCloseTo(10500, 9)
    // Each slope rises inward at the pitch from its side, at the outline's height.
    for (const s of plan.pieces[0].slopes) {
      expect(s.origin.z).toBe(3000)
      expect(Math.acos(s.normal.z) * (180 / Math.PI)).toBeCloseTo(30, 9)
    }
  })

  it('slopes only the long sides of a gable roof, and one side of a shed roof', () => {
    expect(roofPlan(rect(10000, 6000), roofParams({ type: 'gable' })).pieces[0].slopes).toHaveLength(2)
    const shed = roofPlan(rect(10000, 6000), roofParams({ type: 'shed' })).pieces[0].slopes
    expect(shed).toHaveLength(1)
    // Rising from the long side at y = 0 towards y = 6000 (either way round the outline is drawn).
    expect(shed[0].normal.y).toBeLessThan(0)
    const reversed: AnyCurve = { type: 'polyline', points: [v(0, 6000), v(10000, 6000), v(10000, 0), v(0, 0)], closed: true }
    expect(roofPlan(reversed, roofParams({ type: 'gable' })).pieces[0].slopes).toHaveLength(2)
  })

  it('covers L, T and U plans with their largest rectangles', () => {
    const ell: AnyCurve = { type: 'polyline', points: [v(0, 0), v(10000, 0), v(10000, 4000), v(4000, 4000), v(4000, 9000), v(0, 9000)], closed: true }
    const pieces = roofPlan(ell, roofParams({ type: 'hip', overhang: 0 })).pieces
    expect(pieces).toHaveLength(2)
    const spans = pieces.map((p) => {
      const xs = p.eaves.points.map((q) => q.x)
      const ys = p.eaves.points.map((q) => q.y)
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round)
    })
    expect(spans).toContainEqual([0, 10000, 0, 4000])
    expect(spans).toContainEqual([0, 4000, 0, 9000])
    const tee: AnyCurve = { type: 'polyline', points: [v(0, 0), v(9000, 0), v(9000, 3000), v(6000, 3000), v(6000, 8000), v(3000, 8000), v(3000, 3000), v(0, 3000)], closed: true }
    expect(roofPlan(tee, roofParams({ type: 'gable' })).pieces).toHaveLength(2)
    const you: AnyCurve = { type: 'polyline', points: [v(0, 0), v(9000, 0), v(9000, 8000), v(6000, 8000), v(6000, 3000), v(3000, 3000), v(3000, 8000), v(0, 8000)], closed: true }
    expect(roofPlan(you, roofParams({ type: 'hip' })).pieces).toHaveLength(3)
    // Rotated plans work the same.
    const turn = (p: Vector3) => new Vector3(p.x * Math.cos(0.5) - p.y * Math.sin(0.5), p.x * Math.sin(0.5) + p.y * Math.cos(0.5), 0)
    const rotated: AnyCurve = { ...ell, points: (ell as { points: Vector3[] }).points.map(turn) } as AnyCurve
    expect(roofPlan(rotated, roofParams({ type: 'hip' })).pieces).toHaveLength(2)
  })

  it('refuses outlines it cannot roof', () => {
    const ell: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0), v(6000, 3000), v(3000, 3000), v(3000, 6000), v(0, 6000)], closed: true }
    expect(() => roofPlan(ell, roofParams({ type: 'shed' }))).toThrow(/convex/)
    const arrow: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0), v(3000, 1000), v(3000, 6000)], closed: true }
    expect(() => roofPlan(arrow, roofParams({}))).toThrow(/square corners/)
    expect(() => roofPlan({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }, roofParams({}))).toThrow()
  })
})

describe('stairs', () => {
  const line = (...points: Vector3[]): AnyCurve => ({ type: 'polyline', points, closed: false })

  it('picks comfortable risers and equal treads along a straight run', () => {
    const plan = stairPlan(line(v(0, 0), v(4500, 0)), stairParams({ width: 1000 }, 3000))
    expect(plan.flights).toHaveLength(1)
    expect(plan.landings).toHaveLength(0)
    const [f] = plan.flights
    expect(plan.risers).toBe(17)
    expect(f.riser * f.risers).toBeCloseTo(3000, 9)
    expect(f.tread * f.risers).toBeCloseTo(4500, 9)
    expect(comfortable(f.riser, f.tread)).toBe(true)
    // Centred on the line, across its width.
    const ys = f.profile.points.map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-500, 9)
    expect(f.across.length()).toBeCloseTo(1000, 9)
    const zs = f.profile.points.map((p) => p.z)
    expect(Math.max(...zs)).toBeCloseTo(3000, 9)
    expect(Math.min(...zs)).toBeCloseTo(0, 9)
  })

  it('takes a given number of risers', () => {
    const plan = stairPlan(line(v(0, 0, 3000), v(0, 3000, 3000)), stairParams({ risers: 12, height: 2400 }))
    expect(plan.risers).toBe(12)
    expect(plan.riser).toBeCloseTo(200, 9)
    expect(Math.min(...plan.flights[0].profile.points.map((p) => p.z))).toBeCloseTo(3000, 9)
  })

  it('turns an L stair round a square landing, sharing the risers by length', () => {
    // 3000 up y, turning to run 2000 along x; 1000 wide.
    const plan = stairPlan(line(v(0, 0), v(0, 3500), v(2500, 3500)), stairParams({ width: 1000, risers: 16 }, 2800))
    expect(plan.flights).toHaveLength(2)
    expect(plan.landings).toHaveLength(1)
    const [a, b] = plan.flights
    expect(a.risers + b.risers).toBe(16)
    // Runs of 3000 and 2000 (half the width taken off at the landing).
    expect(a.tread * a.risers).toBeCloseTo(3000, 9)
    expect(b.tread * b.risers).toBeCloseTo(2000, 9)
    expect(a.risers).toBe(10)
    // The landing: centred on the bend, at the top of the first flight.
    const l = plan.landings[0]
    const centre = l.origin.clone().addScaledVector(l.u, 0.5).addScaledVector(l.v, 0.5)
    expect(centre.x).toBeCloseTo(0, 9)
    expect(centre.y).toBeCloseTo(3500, 9)
    expect(l.origin.z + l.w.z).toBeCloseTo(10 * plan.riser, 9)
    // The second flight starts there (its slab meeting the landing's, 150 thick) and ends at the
    // full height.
    expect(Math.min(...b.profile.points.map((p) => p.z))).toBeCloseTo(10 * plan.riser - 150, 9)
    expect(b.profile.points[0].z).toBeCloseTo(10 * plan.riser, 9)
    expect(Math.max(...b.profile.points.map((p) => p.z))).toBeCloseTo(2800, 9)
  })

  it('makes a U stair with two landings side by side and no flight between them', () => {
    const plan = stairPlan(line(v(0, 0), v(0, 3000), v(1000, 3000), v(1000, 0)), stairParams({ width: 1000 }, 3000))
    expect(plan.flights).toHaveLength(2)
    expect(plan.landings).toHaveLength(2)
    expect(plan.landings[0].origin.z).toBeCloseTo(plan.landings[1].origin.z, 9)
    expect(plan.flights[0].risers + plan.flights[1].risers).toBe(plan.risers)
  })

  it('refuses stairs too short for their landings', () => {
    expect(() => stairPlan(line(v(0, 0), v(0, 400), v(400, 400)), stairParams({ width: 1000 }, 3000))).toThrow()
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

describe('curtain walls', () => {
  it('divides each stretch into mullions, transoms and panes', () => {
    const params = curtainWallParams({ height: 3000, spacing: 1500, rows: 1500, mullion: 60, depth: 150, glass: 24 })
    expect(divisions(4000, 1500)).toEqual([0, 4000 / 3, 8000 / 3, 4000])
    // A 4 m stretch and a 3 m one: 4 + 3 mullions, 3 + 2 cells across, 2 rows.
    const { frame, glass } = curtainWallParts([new Vector3(0, 0, 0), new Vector3(4000, 0, 0), new Vector3(4000, 3000, 0)], params)
    const upright = frame.filter((b) => b.w.z === 3000)
    expect(upright).toHaveLength(7)
    expect(glass).toHaveLength((3 + 2) * 2)
    // Transoms at the bottom, middle and top of each cell.
    expect(frame.length - upright.length).toBe((3 + 2) * 3)
    // The panes fill the cells between the frame's inner edges, and lie on the line.
    const first = glass[0]
    expect(first.origin.x).toBeCloseTo(60, 6)
    expect(first.u.length()).toBeCloseTo(4000 / 3 - 60 - 30, 6)
    expect(first.origin.z).toBeCloseTo(60, 6)
    expect(first.w.z).toBeCloseTo(1500 - 60 - 30, 6)
    expect(first.origin.y + first.v.y / 2).toBeCloseTo(0, 6)
    // No transoms but top and bottom: one pane a cell.
    expect(curtainWallParts([new Vector3(0, 0, 0), new Vector3(3000, 0, 0)], { ...params, rows: 0 }).glass).toHaveLength(2)
    expect(() => curtainWallParts([new Vector3(0, 0, 0), new Vector3(50, 0, 0)], params)).toThrow()
  })
})
