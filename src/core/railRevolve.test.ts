import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { railRevolveSections } from './railRevolve'
import { endPoint, startPoint, type AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
/** A vertical profile from the axis out to x = 2 at height 1 (a dome-like quarter, as a polyline). */
const profile: AnyCurve = { type: 'polyline', points: [v(0, 0, 3), v(1, 0, 2.5), v(2, 0, 1)], closed: false }
const across = (p: Vector3) => Math.hypot(p.x, p.y)

describe('RailRevolve', () => {
  it('on a circular rail of the profile radius, gives turned copies of the profile', () => {
    const rail: AnyCurve = { type: 'circle', center: v(0, 0, 1), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 }
    const sections = railRevolveSections(profile, rail, v(0, 0), Z, 8)
    expect(sections).toHaveLength(9)
    // Closed rail: the last section is the first.
    expect(sections[8]).toBe(sections[0])
    for (const s of sections) {
      expect(across(endPoint(s))).toBeCloseTo(2, 6)
      expect(endPoint(s).z).toBeCloseTo(1, 9)
      // The end on the axis stays on it, at its height.
      expect(across(startPoint(s))).toBeCloseTo(0, 9)
      expect(startPoint(s).z).toBeCloseTo(3, 9)
    }
  })

  it('stretches the profile across the axis to follow an elliptical rail', () => {
    // An ellipse 4 by 2 (as a polyline, densely) at the profile's end height.
    const points = Array.from({ length: 360 }, (_, i) => v(4 * Math.cos((i * Math.PI) / 180), 2 * Math.sin((i * Math.PI) / 180), 1))
    const rail: AnyCurve = { type: 'polyline', points, closed: true }
    const sections = railRevolveSections(profile, rail, v(0, 0), Z, 4)
    // At 0°, 90°, 180°, 270°: ends at 4, 2, 4, 2 from the axis.
    expect(sections.slice(0, 4).map((s) => across(endPoint(s)))).toEqual([4, 2, 4, 2].map((r) => expect.closeTo(r, 3)))
    // Heights are never stretched; the middle point is stretched in proportion.
    expect(endPoint(sections[0]).z).toBeCloseTo(1, 9)
    const middle = (s: AnyCurve) => (s.type === 'polyline' ? s.points[1] : v(0, 0))
    expect(across(middle(sections[0]))).toBeCloseTo(2, 3)
    expect(middle(sections[0]).z).toBeCloseTo(2.5, 9)
  })

  it('follows an open rail over its own sweep', () => {
    const rail: AnyCurve = { type: 'arc', center: v(0, 0, 1), xaxis: v(1, 0), yaxis: v(0, 1), radius: 3, angle: Math.PI / 2 }
    const sections = railRevolveSections(profile, rail, v(0, 0), Z, 6)
    expect(sections).toHaveLength(7)
    const last = endPoint(sections[6])
    expect(last.x).toBeCloseTo(0, 6)
    expect(last.y).toBeCloseTo(3, 6)
  })

  it('refuses a profile ending on the axis, or a rail that does not go around it', () => {
    const onAxis: AnyCurve = { type: 'polyline', points: [v(0, 0, 0), v(0, 0, 3)], closed: false }
    const rail: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 }
    expect(() => railRevolveSections(onAxis, rail, v(0, 0), Z)).toThrow()
    const straight: AnyCurve = { type: 'polyline', points: [v(2, 0, 0), v(5, 0, 0)], closed: false }
    expect(() => railRevolveSections(profile, straight, v(0, 0), Z)).toThrow()
  })
})
