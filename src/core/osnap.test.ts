import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { crossing, meetingPoint, perpendicularPoints, tangentPoints } from './osnap'
import { snapPoints, type AnyCurve, type CircleGeometry, type CurveGeometry, type PolylineGeometry } from './geometry'
import { circleThrough, closestPoint } from './curves'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const line = (...pts: Vector3[]): PolylineGeometry => ({ type: 'polyline', points: pts, closed: false })
const circle = (cx: number, cy: number, r: number): CircleGeometry => ({ type: 'circle', center: v(cx, cy), xaxis: v(1, 0), yaxis: v(0, 1), radius: r })
const Z = v(0, 0, 1)

/** A cubic through the four control points. */
const cubic = (...pts: Vector3[]): CurveGeometry => ({ type: 'curve', degree: 3, points: pts, knots: [0, 0, 0, 0, 1, 1, 1, 1] })

const sorted = (pts: Vector3[]) => [...pts].sort((a, b) => a.x - b.x || a.y - b.y)

describe('screen crossings', () => {
  it('finds where two segments cross and the fraction along each', () => {
    expect(crossing(0, 0, 10, 0, 5, -5, 5, 5)).toEqual({ s: 0.5, u: 0.5 })
    expect(crossing(0, 0, 10, 0, 2, -1, 2, 9)).toEqual({ s: 0.2, u: 0.1 })
  })

  it('ignores segments that do not reach each other, and parallel ones', () => {
    expect(crossing(0, 0, 10, 0, 12, -5, 12, 5)).toBeNull()
    expect(crossing(0, 0, 10, 0, 0, 1, 10, 1)).toBeNull()
  })
})

describe('meeting point of two curves', () => {
  it('is exact for a line and a circle, from points on their drawn chords', () => {
    const c = circle(0, 0, 10)
    const l = line(v(-20, 3), v(20, 3))
    const x = Math.sqrt(100 - 9)
    // Points off the true intersection, as a chord of the circle gives.
    const p = meetingPoint(l, c, v(x - 0.05, 3), v(x - 0.04, 2.98))!
    expect(p.x).toBeCloseTo(x, 6)
    expect(p.y).toBeCloseTo(3, 6)
  })

  it('is exact for two cubics', () => {
    const a = cubic(v(0, 0), v(3, 8), v(7, -8), v(10, 0))
    const b = line(v(0, -1), v(10, 1))
    const p = meetingPoint(a, b, v(5, 0.2), v(5, 0))!
    expect(p).not.toBeNull()
    // On the line, and on the cubic.
    expect(p.y).toBeCloseTo(-1 + p.x / 5, 6)
    expect(closestPoint(a, p).distance).toBeLessThan(1e-6)
  })

  it('is null for curves that only seem to cross (one passes above the other)', () => {
    const a = line(v(-10, 0, 0), v(10, 0, 0))
    const b = line(v(0, -10, 5), v(0, 10, 5))
    expect(meetingPoint(a, b, v(0, 0, 0), v(0, 0, 5))).toBeNull()
  })
})

describe('perpendicular points', () => {
  it('drops a perpendicular onto a line', () => {
    const pts = perpendicularPoints(line(v(0, 0), v(10, 0)), v(4, 7))
    expect(pts).toHaveLength(1)
    expect(pts[0].distanceTo(v(4, 0))).toBeLessThan(1e-9)
  })

  it('finds both points of a circle, along the line through its center', () => {
    const pts = sorted(perpendicularPoints(circle(0, 0, 5), v(10, 0)))
    expect(pts).toHaveLength(2)
    expect(pts[0].distanceTo(v(-5, 0))).toBeLessThan(1e-6)
    expect(pts[1].distanceTo(v(5, 0))).toBeLessThan(1e-6)
  })

  it('finds them on each segment of a polyline, but not at its corners', () => {
    const l: PolylineGeometry = { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10)], closed: false }
    const pts = sorted(perpendicularPoints(l, v(4, 3)))
    expect(pts).toHaveLength(2)
    expect(pts[0].distanceTo(v(4, 0))).toBeLessThan(1e-9)
    expect(pts[1].distanceTo(v(10, 3))).toBeLessThan(1e-9)
  })

  it('is at right angles on a B-spline', () => {
    const c = cubic(v(0, 0), v(3, 8), v(7, 8), v(10, 0))
    const from = v(5, 20)
    const pts = perpendicularPoints(c, from)
    expect(pts.length).toBeGreaterThan(0)
    // By symmetry, the top of the curve.
    expect(pts.some((p) => Math.abs(p.x - 5) < 1e-6)).toBe(true)
  })
})

describe('tangent points', () => {
  it('touches a circle at the two points a tangent from outside reaches', () => {
    const pts = sorted(tangentPoints(circle(0, 0, 5), v(10, 0), Z))
    expect(pts).toHaveLength(2)
    // Tangent from distance d: the point is at x = r²/d, y = ±r·√(d² − r²)/d.
    for (const p of pts) {
      expect(p.x).toBeCloseTo(2.5, 6)
      expect(Math.abs(p.y)).toBeCloseTo((5 * Math.sqrt(75)) / 10, 6)
      // The radius there is at right angles to the line from the point.
      expect(p.clone().dot(p.clone().sub(v(10, 0)))).toBeCloseTo(0, 6)
    }
  })

  it('has none from inside a circle', () => {
    expect(tangentPoints(circle(0, 0, 5), v(1, 1), Z)).toHaveLength(0)
  })

  it('touches a circle through three points (in its own plane, whatever the view)', () => {
    const c = circleThrough(v(0, 0, 0), v(0, 10, 0), v(0, 5, 5))! as AnyCurve
    const pts = tangentPoints(c, v(0, 5, 20), v(0, 0, 1))
    expect(pts).toHaveLength(2)
  })

  it('touches a B-spline', () => {
    const c = cubic(v(0, 0), v(3, 8), v(7, 8), v(10, 0))
    const pts = tangentPoints(c, v(-5, 0), Z)
    expect(pts.length).toBeGreaterThan(0)
  })
})

describe('knot snap points', () => {
  it('are where the spans of a B-spline meet, ends included', () => {
    const c: CurveGeometry = { type: 'curve', degree: 2, points: [v(0, 0), v(2, 4), v(4, 0), v(6, 4)], knots: [0, 0, 0, 0.5, 1, 1, 1] }
    const knots = snapPoints(c).knot
    expect(knots).toHaveLength(3)
    expect(knots[0].distanceTo(v(0, 0))).toBeLessThan(1e-12)
    expect(knots[2].distanceTo(v(6, 4))).toBeLessThan(1e-12)
  })

  it('come with the segments of a polycurve', () => {
    const c: CurveGeometry = { type: 'curve', degree: 2, points: [v(0, 0), v(2, 4), v(4, 0)], knots: [0, 0, 0, 1, 1, 1] }
    const knots = snapPoints({ type: 'polycurve', segments: [line(v(-5, 0), v(0, 0)), c] }).knot
    expect(knots).toHaveLength(2)
  })
})
