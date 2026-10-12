import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { ellipse } from '../core/curveTools'
import { railRevolveSections } from '../core/railRevolve'
import { loftSurface } from './brep'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('rail revolve surface', () => {
  it('lofts the sections into one smooth face that follows the rail', () => {
    const profile = { type: 'polyline' as const, points: [v(200, 0), v(100, 0, 300)], closed: false }
    const rail = ellipse(v(0, 0), v(1, 0), v(0, 1), 200, 350)
    const shape = loftSurface(railRevolveSections(profile, rail, v(0, 0), v(0, 0, 1)))
    expect(shape.faces.length).toBe(1)
    const box = shape.boundingBox
    expect(box.bounds[1][1]).toBeCloseTo(350, 0)
    expect(box.bounds[1][0]).toBeCloseTo(200, 0)
    expect(box.bounds[1][2]).toBeCloseTo(300, 3)
  })
})
