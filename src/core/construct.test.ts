import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { clampedKnots } from '../math/nurbs'
import { closestPoint, length } from './curves'
import { filletCorners, filletLines } from './fillet'
import { ArcGeometry, CircleGeometry, CurveGeometry, endPoint, isClosed, PolylineGeometry, startPoint } from './geometry'
import { offset } from './offset'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
const line = (a: Vector3, b: Vector3): PolylineGeometry => ({ type: 'polyline', points: [a, b], closed: false })
const square: PolylineGeometry = { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10), v(0, 10)], closed: true }

function expectPoint(a: Vector3, b: Vector3, digits = 6) {
  expect(a.distanceTo(b)).toBeCloseTo(0, digits)
}

describe('offset', () => {
  it('moves a line to the picked side', () => {
    const r = offset(line(v(0, 0), v(10, 0)), 2, v(5, -7), Z) as PolylineGeometry
    expectPoint(r.points[0], v(0, -2))
    expectPoint(r.points[1], v(10, -2))
  })

  it('grows or shrinks a circle', () => {
    const c: CircleGeometry = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 5 }
    expect((offset(c, 1, v(20, 0), Z) as CircleGeometry).radius).toBeCloseTo(6)
    expect((offset(c, 1, v(1, 0), Z) as CircleGeometry).radius).toBeCloseTo(4)
    expect(offset(c, 6, v(1, 0), Z)).toBeNull()
  })

  it('offsets a closed polyline outwards with sharp corners', () => {
    const r = offset(square, 1, v(-5, 5), Z) as PolylineGeometry
    expect(r.type).toBe('polyline')
    expect(isClosed(r)).toBe(true)
    expect(length(r)).toBeCloseTo(48)
    expect(r.points.some((p) => p.distanceTo(v(-1, -1)) < 1e-9)).toBe(true)
  })

  it('offsets a closed polyline inwards', () => {
    const r = offset(square, 2, v(5, 5), Z) as PolylineGeometry
    expect(length(r)).toBeCloseTo(24)
  })

  it('offsets a spline at a constant distance', () => {
    const c: CurveGeometry = { type: 'curve', degree: 3, points: [v(0, 0), v(3, 4), v(7, 4), v(10, 0)], knots: clampedKnots(4, 3) }
    const r = offset(c, 1, v(5, 10), Z)!
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const onOffset = closestPoint(r, closestPoint(c, v(10 * t, 2)).point)
      expect(onOffset.distance).toBeCloseTo(1, 2)
    }
  })
})

describe('fillet', () => {
  it('rounds the corner between two lines', () => {
    const result = filletLines(line(v(0, 0), v(10, 0)), v(8, 0), line(v(10, 0), v(10, 10)), v(10, 8), 2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expectPoint(endPoint(result.a), v(8, 0))
    expectPoint(startPoint(result.b), v(10, 2))
    const arc = result.arc as ArcGeometry
    expectPoint(arc.center, v(8, 2))
    expectPoint(startPoint(arc), v(8, 0))
    expectPoint(endPoint(arc), v(10, 2))
  })

  it('extends lines that do not reach each other', () => {
    const result = filletLines(line(v(0, 0), v(6, 0)), v(1, 0), line(v(10, 4), v(10, 10)), v(10, 9), 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expectPoint(endPoint(result.a), v(10, 0))
    expectPoint(startPoint(result.b), v(10, 0))
  })

  it('refuses a radius that does not fit', () => {
    const result = filletLines(line(v(0, 0), v(1, 0)), v(0.5, 0), line(v(1, 0), v(1, 1)), v(1, 0.5), 5)
    expect(result.ok).toBe(false)
  })

  it('rounds all corners of a closed polyline', () => {
    const result = filletCorners(square, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.geometry.type).toBe('polycurve')
    expect(isClosed(result.geometry)).toBe(true)
    // Four sides lose 2 each; four quarter circles add one full circle.
    expect(length(result.geometry)).toBeCloseTo(40 - 8 + 2 * Math.PI)
  })

  it('rounds only the inner corners of an open polyline', () => {
    const open: PolylineGeometry = { ...square, closed: false }
    const result = filletCorners(open, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expectPoint(startPoint(result.geometry), v(0, 0))
    expectPoint(endPoint(result.geometry), v(0, 10))
    expect(length(result.geometry)).toBeCloseTo(30 - 4 + Math.PI)
  })
})
