import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { BSpline, clampedKnots, derivBSpline, domainOf, evalBSpline, insertKnot, interpolate, reverseBSpline, splitBSpline } from './nurbs'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const at = (c: BSpline, t: number) => evalBSpline(c.points, c.degree, c.knots, t)
const curve: BSpline = {
  degree: 3,
  points: [v(0, 0), v(1, 3), v(4, 4), v(6, 0), v(9, 2), v(10, 5)],
  knots: clampedKnots(6, 3),
}

function expectClose(a: Vector3, b: Vector3, digits = 9) {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
  expect(a.z).toBeCloseTo(b.z, digits)
}

describe('B-splines', () => {
  it('interpolates the end control points of a clamped curve', () => {
    expectClose(at(curve, 0), curve.points[0])
    expectClose(at(curve, 3), curve.points[5])
  })

  it('keeps the shape when a knot is inserted', () => {
    const refined = insertKnot(insertKnot(curve, 1.3), 1.3)
    for (const t of [0, 0.5, 1.3, 2, 2.9, 3]) expectClose(at(refined, t), at(curve, t))
  })

  it('splits into two curves that cover the original', () => {
    const [a, b] = splitBSpline(curve, 1.7)!
    expect(domainOf(a)).toEqual([0, 1.7])
    expect(domainOf(b)).toEqual([1.7, 3])
    for (const t of [0, 0.4, 1.7]) expectClose(at(a, t), at(curve, t))
    for (const t of [1.7, 2.2, 3]) expectClose(at(b, t), at(curve, t))
  })

  it('splits at an existing interior knot', () => {
    const [a, b] = splitBSpline(curve, 1)!
    expectClose(at(a, 0.5), at(curve, 0.5))
    expectClose(at(b, 2.5), at(curve, 2.5))
  })

  it('does not split outside the domain', () => {
    expect(splitBSpline(curve, 0)).toBeNull()
    expect(splitBSpline(curve, 3)).toBeNull()
  })

  it('reverses direction without changing shape', () => {
    const r = reverseBSpline(curve)
    for (const t of [0, 0.8, 2.1, 3]) expectClose(at(r, 3 - t), at(curve, t))
  })

  it('computes derivatives that match finite differences', () => {
    const h = 1e-6
    for (const t of [0.3, 1.5, 2.7]) {
      const numeric = at(curve, t + h).sub(at(curve, t - h)).divideScalar(2 * h)
      expectClose(derivBSpline(curve, t), numeric, 4)
    }
  })

  it('interpolates through the given points', () => {
    const pts = [v(0, 0), v(2, 1), v(4, 0), v(6, -1), v(8, 0), v(10, 3)]
    const c = interpolate(pts)
    expectClose(at(c, domainOf(c)[0]), pts[0])
    expectClose(at(c, domainOf(c)[1]), pts[5])
    // Every data point lies on the curve.
    for (const p of pts) {
      let best = Infinity
      const [t0, t1] = domainOf(c)
      for (let i = 0; i <= 4000; i++) best = Math.min(best, at(c, t0 + ((t1 - t0) * i) / 4000).distanceTo(p))
      expect(best).toBeLessThan(1e-2)
    }
  })
})
