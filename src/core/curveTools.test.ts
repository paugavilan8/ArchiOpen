import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { blend, curvatureAt, ellipse, extend, helix, polygon, rebuild } from './curveTools'
import { closestPoint, length, reverse, split, transform } from './curves'
import { chamferLines } from './fillet'
import { AnyCurve, domain, geometryFromJSON, geometryToJSON, pointAt, PolylineGeometry, tangentAt, tessellate } from './geometry'
import { approximate } from '../math/nurbs'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const X = v(1, 0)
const Y = v(0, 1)
const line = (a: Vector3, b: Vector3): PolylineGeometry => ({ type: 'polyline', points: [a, b], closed: false })
/** Largest |(x/a)² + (y/b)² − 1| over a curve's display points. */
const offEllipse = (g: AnyCurve, a: number, b: number) => Math.max(...tessellate(g).map((p) => Math.abs((p.x / a) ** 2 + (p.y / b) ** 2 - 1)))

describe('rational curves', () => {
  const e = ellipse(v(0, 0), X, Y, 4, 2)

  it('draw exact ellipses', () => {
    expect(offEllipse(e, 4, 2)).toBeLessThan(1e-12)
    expect(pointAt(e, 1).distanceTo(v(0, 2))).toBeLessThan(1e-12)
    // Ramanujan's approximation of the perimeter is exact to about 1e-5 here.
    const h = ((4 - 2) / (4 + 2)) ** 2
    expect(length(e)).toBeCloseTo(Math.PI * (4 + 2) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 2)
  })

  it('stay exact when split, reversed, transformed and saved', () => {
    const [a, b] = split(e, [0.5, 2.5])
    expect(offEllipse(a, 4, 2)).toBeLessThan(1e-12)
    expect(offEllipse(b, 4, 2)).toBeLessThan(1e-12)
    // (Lengths are measured on the display polyline, to about 1e-4.)
    expect(length(a) + length(b)).toBeCloseTo(length(e), 3)
    expect(offEllipse(reverse(e), 4, 2)).toBeLessThan(1e-12)
    const moved = transform(e, new Matrix4().makeTranslation(1, 1, 0))
    expect(pointAt(moved, 0).distanceTo(v(5, 1))).toBeLessThan(1e-12)
    const back = geometryFromJSON(JSON.parse(JSON.stringify(geometryToJSON(e))))
    expect(back).toEqual(e)
  })

  it('have exact tangents', () => {
    // At the end of the minor axis the tangent is along −X.
    expect(tangentAt(e, 1).distanceTo(v(-1, 0))).toBeLessThan(1e-6)
  })
})

describe('curve tools', () => {
  it('draw polygons inscribed and circumscribed', () => {
    const inscribed = polygon(v(0, 0), X, Y, 5, 6, 0, false)
    expect(inscribed.points).toHaveLength(6)
    for (const p of inscribed.points) expect(p.length()).toBeCloseTo(5, 12)
    const outer = polygon(v(0, 0), X, Y, 5, 4, 0, true)
    // A square around a circle of radius 5: its sides' middles are 5 from the center, the first at angle 0.
    const mid = outer.points[0].clone().lerp(outer.points[1], 0.5)
    expect(mid.distanceTo(v(5, 0))).toBeLessThan(1e-12)
  })

  it('draw helices', () => {
    const h = helix(v(0, 0), v(0, 0, 10), v(3, 0), 4)!
    const [t0, t1] = domain(h)
    expect(pointAt(h, t0).distanceTo(v(3, 0))).toBeLessThan(1e-9)
    expect(pointAt(h, t1).distanceTo(v(3, 0, 10))).toBeLessThan(1e-9)
    for (const p of tessellate(h)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(3, 2)
  })

  it('rebuild curves with fewer, smoother control points', () => {
    const circle: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: X, yaxis: Y, radius: 10 }
    const arc: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: X, yaxis: Y, radius: 10, angle: Math.PI }
    const r = rebuild(arc, 8, 3)
    expect(r.points).toHaveLength(8)
    expect(r.degree).toBe(3)
    for (const p of tessellate(r)) expect(Math.abs(p.length() - 10)).toBeLessThan(0.01)
    expect(rebuild(circle, 12, 3).points).toHaveLength(12)
  })

  it('fit points closely', () => {
    // Points on a parabola, fitted by a quadratic with five control points.
    const pts = Array.from({ length: 30 }, (_, i) => v(i / 29, (i / 29) ** 2))
    const fit = approximate(pts, 5, 2)
    const g: AnyCurve = { type: 'curve', ...fit }
    for (const p of pts) expect(closestPoint(g, p).distance).toBeLessThan(5e-3)
  })

  it('chamfer two lines by distances from their corner', () => {
    const r = chamferLines(line(v(-10, 0), v(0, 0)), v(-5, 0), line(v(0, 0), v(0, 10)), v(0, 5), 2, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chamfer!.points.map((p) => p.toArray())).toEqual([
      [-2, 0, 0],
      [0, 3, 0],
    ])
  })

  it('extend lines, arcs and curves to boundaries', () => {
    const wall = line(v(10, -5), v(10, 5))
    const extended = extend(line(v(0, 0), v(4, 0)), false, [wall]) as PolylineGeometry
    expect(extended.points[1].toArray()).toEqual([10, 0, 0])
    // A quarter arc of radius 5 around the origin, extended from its end to the line y = −3 (beyond 180°).
    const arc: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: X, yaxis: Y, radius: 5, angle: Math.PI / 2 }
    const longer = extend(arc, false, [line(v(-10, -3), v(10, -3))])!
    const end = pointAt(longer, domain(longer)[1])
    expect(end.y).toBeCloseTo(-3, 6)
    expect(end.x).toBeCloseTo(-4, 6)
    const spline: AnyCurve = { type: 'curve', ...approximate([v(0, 0), v(1, 1), v(2, 1), v(3, 0)], 4, 3) }
    const withLine = extend(spline, false, [line(v(5, -10), v(5, 10))])!
    expect(withLine.type).toBe('polycurve')
    expect(pointAt(withLine, domain(withLine)[1]).x).toBeCloseTo(5, 6)
  })

  it('blend curve ends with tangency or curvature', () => {
    const a = line(v(0, 0), v(5, 0))
    const b = line(v(10, 5), v(10, 10))
    const t = blend(a, false, b, true, 'tangency')
    const [t0, t1] = domain(t)
    expect(tangentAt(t, t0).distanceTo(X)).toBeLessThan(1e-5)
    expect(tangentAt(t, t1).distanceTo(Y)).toBeLessThan(1e-5)
    // Blending two arcs with matching curvature: the blend starts with the arc's curvature (1/radius).
    const arcA: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: X, yaxis: Y, radius: 4, angle: Math.PI / 2 }
    const arcB: AnyCurve = { type: 'arc', center: v(20, 0), xaxis: Y, yaxis: X.clone().negate(), radius: 4, angle: Math.PI / 2 }
    const c = blend(arcA, false, arcB, false, 'curvature')
    expect(curvatureAt(c, domain(c)[0]).length()).toBeCloseTo(0.25, 2)
  })
})
