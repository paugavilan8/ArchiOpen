import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { deformGeometry, pointMap } from './deformations'
import { length } from './curves'
import type { AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const near = (a: Vector3, b: Vector3, tol = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(tol)

describe('deformations', () => {
  it('twists about an axis by an angle growing along it', () => {
    const twist = pointMap({ kind: 'twist', start: v(0, 0, 0), end: v(0, 0, 10), angle: Math.PI / 2, infinite: false })
    near(twist(v(1, 0, 0)), v(1, 0, 0))
    near(twist(v(1, 0, 10)), v(0, 1, 10))
    near(twist(v(1, 0, 5)), v(Math.SQRT1_2, Math.SQRT1_2, 5))
    // Held to the axis's length unless infinite.
    near(twist(v(1, 0, 20)), v(0, 1, 20))
  })

  it('tapers from one scale to another', () => {
    const taper = pointMap({ kind: 'taper', start: v(0, 0, 0), end: v(0, 0, 10), startScale: 1, endScale: 0.5, infinite: false })
    near(taper(v(2, 0, 0)), v(2, 0, 0))
    near(taper(v(2, 2, 10)), v(1, 1, 10))
  })

  it('bends the axis into an arc of the same length', () => {
    const bend = pointMap({ kind: 'bend', start: v(0, 0, 0), end: v(0, 0, 10), toward: v(1, 0, 0), angle: Math.PI / 2 })
    // A quarter circle of length 10: radius 20/pi, from the origin round to (R, 0, R).
    const R = 20 / Math.PI
    near(bend(v(0, 0, 0)), v(0, 0, 0))
    near(bend(v(0, 0, 10)), v(R, 0, R))
    // Off the axis, outside the bend: a bigger radius.
    near(bend(v(-1, 0, 10)), v(R, 0, R + 1))
  })

  it('flows objects from a straight base onto a target curve', () => {
    const base: AnyCurve = { type: 'polyline', points: [v(0, 0), v(10, 0)], closed: false }
    const target: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 20 / Math.PI, angle: Math.PI / 2 }
    const flow = pointMap({ kind: 'flow', base, target, stretch: true, up: v(0, 0, 1) })
    const R = 20 / Math.PI
    near(flow(v(0, 0)), v(R, 0), 1e-2)
    near(flow(v(10, 0)), v(0, R), 1e-2)
    // Upright offsets stay upright.
    near(flow(v(5, 0, 3)), flow(v(5, 0)).add(v(0, 0, 3)), 1e-2)
  })

  it('deforms curves into smooth curves and keeps their length when only bending', () => {
    const line: AnyCurve = { type: 'polyline', points: [v(0, 0, 0), v(0, 0, 10)], closed: false }
    const bent = deformGeometry(line, pointMap({ kind: 'bend', start: v(0, 0, 0), end: v(0, 0, 10), toward: v(1, 0, 0), angle: Math.PI / 2 })) as AnyCurve
    expect(bent.type).toBe('curve')
    expect(length(bent)).toBeCloseTo(10, 2)
  })

  it('follows the points of a cage (CageEdit), leaving everything as it was until they move', () => {
    const grid = (n: number) => {
      const pts: Vector3[] = []
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(v((10 * i) / (n - 1), (10 * j) / (n - 1), (10 * k) / (n - 1)))
      return pts
    }
    for (const n of [2, 3, 4]) {
      const same = pointMap({ kind: 'cage', min: v(0, 0, 0), max: v(10, 10, 10), counts: [n, n, n], points: grid(n) })
      near(same(v(3, 7, 2)), v(3, 7, 2))
    }
    // The top face of a 2-point cage raised by 5: halfway up rises by 2.5, the bottom stays.
    const pts = grid(2).map((p) => (p.z > 5 ? p.clone().add(v(0, 0, 5)) : p))
    const raise = pointMap({ kind: 'cage', min: v(0, 0, 0), max: v(10, 10, 10), counts: [2, 2, 2], points: pts })
    near(raise(v(4, 4, 5)), v(4, 4, 7.5))
    near(raise(v(4, 4, 0)), v(4, 4, 0))
  })
})
