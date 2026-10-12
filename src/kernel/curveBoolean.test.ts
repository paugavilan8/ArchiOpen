import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnyCurve } from '../core/geometry'
import { areaInside } from '../core/schedules'
import { curveRegions } from './curveBoolean'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const rect = (x0: number, y0: number, x1: number, y1: number): AnyCurve => ({ type: 'polyline', points: [v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)], closed: true })
const plane = [v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1)] as const
const regions = (curves: AnyCurve[], points: Vector3[]) => curveRegions(curves, points, ...plane)

describe('curveRegions', () => {
  const a = rect(0, 0, 10, 10)
  const b = rect(5, 5, 15, 15)

  it('keeps the overlap of two rectangles', () => {
    const out = regions([a, b], [v(7, 7)])
    expect(out).toHaveLength(1)
    expect(areaInside(out)).toBeCloseTo(25, 6)
  })

  it('merges neighbouring regions into their union', () => {
    const out = regions([a, b], [v(2, 2), v(7, 7), v(12, 12)])
    expect(out).toHaveLength(1)
    expect(areaInside(out)).toBeCloseTo(175, 6)
  })

  it('keeps a part less another (a difference)', () => {
    expect(areaInside(regions([a, b], [v(2, 2)]))).toBeCloseTo(75, 6)
  })

  it('splits a region by an open curve', () => {
    const cut: AnyCurve = { type: 'polyline', points: [v(-1, 4), v(11, 4)], closed: false }
    expect(areaInside(regions([a, cut], [v(5, 2)]))).toBeCloseTo(40, 6)
  })

  it('gives holes as their own loops', () => {
    const out = regions([a, rect(4, 4, 6, 6)], [v(1, 1)])
    expect(out).toHaveLength(2)
    expect(areaInside(out)).toBeCloseTo(96, 6)
  })

  it('refuses a point outside every closed region', () => {
    expect(() => regions([a], [v(20, 20)])).toThrow(/open/)
  })
})
