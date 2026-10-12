import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { wallParams } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { slabShape, wallShape } from './architecture'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const volume = (s: R.AnyShape) => R.measureShapeVolumeProperties(s as R.Shape3D).volume
const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4000, 0), v(4000, 3000), v(0, 3000)], closed: true }

describe('architectural solids', () => {
  it('makes a straight wall', () => {
    const wall = wallShape({ type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }, wallParams({ thickness: 200, height: 3000 }))
    expect(volume(wall)).toBeCloseTo(5000 * 200 * 3000, -3)
  })

  it('makes the walls of a room, with a door and a window cut out', () => {
    const plain = wallShape(room, wallParams({ thickness: 200, height: 3000 }))
    expect(volume(plain)).toBeCloseTo(2 * 7000 * 200 * 3000, -3)
    const openings = [
      { kind: 'door', at: 2000, width: 900, height: 2100, sill: 0 },
      { kind: 'window', at: 5500, width: 1200, height: 1200, sill: 900 },
    ]
    const cut = wallShape(room, wallParams({ thickness: 200, height: 3000, openings }))
    expect(volume(plain) - volume(cut)).toBeCloseTo(200 * (900 * 2100 + 1200 * 1200), -3)
    const box = cut.boundingBox.bounds
    expect(box[0][2]).toBeCloseTo(0, 6)
    expect(box[1][2]).toBeCloseTo(3000, 6)
  })

  it('makes a slab under its outline', () => {
    const lifted: AnyCurve = { ...room, points: room.type === 'polyline' ? room.points.map((p) => p.clone().setZ(3000)) : [] } as AnyCurve
    const slab = slabShape(lifted, { thickness: 250 })
    expect(volume(slab)).toBeCloseTo(4000 * 3000 * 250, -3)
    const box = slab.boundingBox.bounds
    expect(box[1][2]).toBeCloseTo(3000, 6)
    expect(box[0][2]).toBeCloseTo(2750, 6)
  })
})
