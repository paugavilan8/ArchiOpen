import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { curveArrayMatrices } from './curveTools'
import { scaleAcross, scaleAlong } from '../commands/helpers'
import type { AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
const close = (a: Vector3, b: Vector3, tolerance = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(tolerance)

describe('scaling along directions', () => {
  it('stretches along one direction only (Scale1D)', () => {
    const m = scaleAlong(v(1, 0), v(1, 0), 3)
    close(v(2, 5, 7).applyMatrix4(m), v(4, 5, 7))
  })

  it('scales in a plane, keeping heights (Scale2D)', () => {
    const m = scaleAcross(v(0, 0), Z, 2)
    close(v(1, 2, 3).applyMatrix4(m), v(2, 4, 3))
  })

  it('flattens onto a plane with a zero factor (ProjectToCPlane)', () => {
    close(v(1, 2, 3).applyMatrix4(scaleAlong(v(0, 0, 1), Z, 0)), v(1, 2, 1))
  })
})

describe('curveArrayMatrices', () => {
  const circle: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 10 }
  const line: AnyCurve = { type: 'polyline', points: [v(0, 0), v(30, 0)], closed: false }

  it('moves the base point onto the curve, evenly', () => {
    const ms = curveArrayMatrices(line, v(5, 5), [0, 10, 20, 30], 'none', Z)
    expect(ms.map((m) => v(5, 5).applyMatrix4(m).x)).toEqual([0, 10, 20, 30].map((x) => expect.closeTo(x, 6)))
    // Without rotation a point beside the base stays beside it.
    close(v(6, 5).applyMatrix4(ms[2]), v(21, 0))
  })

  it('turns copies with the curve (freeform) or upright about the plane normal (roadlike)', () => {
    const quarter = (2 * Math.PI * 10) / 4
    for (const mode of ['freeform', 'roadlike'] as const) {
      const [, m] = curveArrayMatrices(circle, v(10, 0), [0, quarter], mode, Z)
      // At the start the tangent is +y; a quarter on it is -x, so a point 1 outside goes to +y.
      // (Lengths along a circle are measured on fine samples.)
      close(v(11, 0).applyMatrix4(m), v(0, 11), 1e-2)
    }
  })
})
