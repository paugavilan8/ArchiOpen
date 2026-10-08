import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { clampedKnots } from '../math/nurbs'
import { chain, closestPoint, controlPoints, explode, isSimilarity, join, length, removeControlPoints, reverse, split, subCurve, transform, withControlPoints } from './curves'
import { AnyCurve, ArcGeometry, CircleGeometry, CurveGeometry, domain, endPoint, Geometry, isClosed, pointAt, PolylineGeometry, startPoint } from './geometry'
import { intersect } from './intersect'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const X = v(1, 0)
const Y = v(0, 1)
const line = (a: Vector3, b: Vector3): PolylineGeometry => ({ type: 'polyline', points: [a, b], closed: false })
const circle: CircleGeometry = { type: 'circle', center: v(0, 0), xaxis: X, yaxis: Y, radius: 5 }
const square: PolylineGeometry = { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10), v(0, 10)], closed: true }
const spline: CurveGeometry = { type: 'curve', degree: 3, points: [v(0, 0), v(2, 5), v(6, -3), v(10, 2)], knots: clampedKnots(4, 3) }

function expectPoint(a: Vector3, b: Vector3, digits = 6) {
  expect(a.distanceTo(b)).toBeCloseTo(0, digits)
}

describe('intersections', () => {
  it('finds the crossing of two lines', () => {
    const hits = intersect(line(v(0, 0), v(10, 10)), line(v(0, 10), v(10, 0)))
    expect(hits).toHaveLength(1)
    expectPoint(hits[0].point, v(5, 5))
    expect(hits[0].ta).toBeCloseTo(0.5)
  })

  it('finds where a line crosses a circle', () => {
    const hits = intersect(line(v(-10, 3), v(10, 3)), circle)
    expect(hits).toHaveLength(2)
    expectPoint(hits[0].point, v(-4, 3))
    expectPoint(hits[1].point, v(4, 3))
  })

  it('finds the crossings of a spline and a line', () => {
    const hits = intersect(spline, line(v(-1, 0.5), v(11, 0.5)))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    for (const h of hits) expect(h.point.y).toBeCloseTo(0.5, 6)
  })

  it('ignores curves that do not meet', () => {
    expect(intersect(line(v(0, 0), v(1, 0)), line(v(0, 1), v(1, 1)))).toHaveLength(0)
  })
})

describe('splitting', () => {
  it('cuts a line into two', () => {
    const pieces = split(line(v(0, 0), v(10, 0)), [0.3])
    expect(pieces).toHaveLength(2)
    expectPoint(endPoint(pieces[0]), v(3, 0))
    expectPoint(startPoint(pieces[1]), v(3, 0))
  })

  it('cuts a circle at two points into two arcs', () => {
    const pieces = split(circle, [Math.PI / 2, Math.PI]) as ArcGeometry[]
    expect(pieces).toHaveLength(2)
    expect(pieces.every((p) => p.type === 'arc')).toBe(true)
    expect(length(pieces[0]) + length(pieces[1])).toBeCloseTo(length(circle))
    expectPoint(startPoint(pieces[0]), v(0, 5))
    expectPoint(endPoint(pieces[0]), v(-5, 0))
    expectPoint(endPoint(pieces[1]), v(0, 5))
  })

  it('opens a closed polyline through its seam', () => {
    const [a, b] = split(square, [0.5, 2.5])
    expect(length(a) + length(b)).toBeCloseTo(40)
    expectPoint(startPoint(b), v(5, 10))
    expectPoint(endPoint(b), v(5, 0))
  })

  it('splits a spline without changing its shape', () => {
    const [a, b] = split(spline, [0.4])
    expectPoint(pointAt(a, 0.2), pointAt(spline, 0.2))
    expectPoint(pointAt(b, 0.7), pointAt(spline, 0.7))
  })

  it('takes pieces of polycurves', () => {
    const arc: ArcGeometry = { type: 'arc', center: v(10, 5), xaxis: v(0, -1), yaxis: X, radius: 5, angle: Math.PI }
    const pc = chain([line(v(0, 0), v(10, 0)), arc, line(v(10, 10), v(0, 10))])!
    expect(pc.type).toBe('polycurve')
    const piece = subCurve(pc, 0.5, 2.5)!
    expectPoint(startPoint(piece), v(5, 0))
    expectPoint(endPoint(piece), v(5, 10))
    expect(length(piece)).toBeCloseTo(5 + Math.PI * 5 + 5)
  })
})

describe('joining and exploding', () => {
  it('joins four lines into a closed polyline, in any order and direction', () => {
    const parts: AnyCurve[] = [line(v(0, 0), v(10, 0)), line(v(0, 10), v(10, 10)), line(v(0, 10), v(0, 0)), line(v(10, 0), v(10, 10))]
    const [result] = join(parts)
    expect(result.used.sort()).toEqual([0, 1, 2, 3])
    expect(result.geometry.type).toBe('polyline')
    expect(isClosed(result.geometry)).toBe(true)
    expect(length(result.geometry)).toBeCloseTo(40)
  })

  it('joins a line and an arc into a polycurve and explodes it back', () => {
    const arc: ArcGeometry = { type: 'arc', center: v(10, 5), xaxis: v(0, -1), yaxis: X, radius: 5, angle: Math.PI }
    const [result] = join([line(v(0, 0), v(10, 0)), arc])
    expect(result.geometry.type).toBe('polycurve')
    expect(explode(result.geometry)).toHaveLength(2)
  })

  it('explodes a closed polyline into lines', () => {
    expect(explode(square)).toHaveLength(4)
  })
})

describe('reverse and transform', () => {
  it('reverses an arc', () => {
    const arc: ArcGeometry = { type: 'arc', center: v(0, 0), xaxis: X, yaxis: Y, radius: 2, angle: 1 }
    const r = reverse(arc)
    expectPoint(startPoint(r), endPoint(arc))
    expectPoint(endPoint(r), startPoint(arc))
    expectPoint(pointAt(r, 0.25), pointAt(arc, 0.75))
  })

  it('rotates and scales a circle', () => {
    const m = new Matrix4().makeRotationZ(Math.PI / 2).premultiply(new Matrix4().makeScale(2, 2, 2))
    const c = transform({ ...circle, center: v(1, 0) }, m) as CircleGeometry
    expectPoint(c.center, v(0, 2))
    expect(c.radius).toBeCloseTo(10)
  })

  it('mirrors an arc', () => {
    const arc: ArcGeometry = { type: 'arc', center: v(0, 0), xaxis: X, yaxis: Y, radius: 2, angle: Math.PI / 2 }
    const m = new Matrix4().makeScale(-1, 1, 1)
    const mirrored = transform(arc, m)
    expectPoint(startPoint(mirrored), v(-2, 0))
    expectPoint(endPoint(mirrored), v(0, 2))
    expectPoint(pointAt(mirrored, Math.PI / 4), v(-Math.SQRT2, Math.SQRT2))
  })
})

describe('closest point', () => {
  it('projects onto a spline', () => {
    const target = pointAt(spline, 0.37)
    const hit = closestPoint(spline, target.clone().add(v(0, 0, 1)))
    expect(hit.t).toBeCloseTo(0.37, 4)
    expect(hit.distance).toBeCloseTo(1, 4)
  })
})

describe('affine transforms and control points', () => {
  it('turns a circle into a curve under a non-uniform scale', () => {
    const m = new Matrix4().makeScale(2, 1, 1)
    const g = transform(circle, m)
    expect(g.type).toBe('curve')
    // Points of the ellipse x²/100 + y²/25 = 1 lie on the result.
    for (const t of [0.1, 0.35, 0.6, 0.85]) {
      const [t0, t1] = domain(g)
      const p = pointAt(g, t0 + (t1 - t0) * t)
      expect((p.x * p.x) / 100 + (p.y * p.y) / 25).toBeCloseTo(1, 2)
    }
  })

  it('keeps arcs as arcs under a similarity', () => {
    expect(isSimilarity(new Matrix4().makeRotationZ(0.3).scale(v(2, 2, 2)))).toBe(true)
    expect(isSimilarity(new Matrix4().makeScale(2, 1, 1))).toBe(false)
  })

  it('edits and removes control points', () => {
    const pts = controlPoints(spline)!
    const moved = withControlPoints(spline, pts.map((p, i) => (i === 1 ? p.clone().add(v(0, 1)) : p)))
    expect(controlPoints(moved)![1].y).toBe(6)
    const fewer = removeControlPoints(spline, new Set([1])) as CurveGeometry
    expect(fewer.points).toHaveLength(3)
    expect(fewer.degree).toBe(2)
    expect(removeControlPoints(line(v(0, 0), v(1, 0)), new Set([0]))).toBeNull()
    expect(controlPoints(circle)).toBeNull()
  })
})
