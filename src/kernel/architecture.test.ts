import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { FRAME, wallParams, type Opening } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { openingPartShape, slabShape, wallShape } from './architecture'

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

  it('makes a window frame and its glass, in the middle of the wall', () => {
    const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }
    const params = wallParams({ thickness: 300, height: 3000, justification: 'left' })
    const window: Opening = { id: 1, kind: 'window', at: 2500, width: 1200, height: 1000, sill: 900 }
    const frame = openingPartShape(path, params, window, 'frame')
    const p = FRAME.profile
    const d = FRAME.depth
    expect(volume(frame)).toBeCloseTo((1200 * 1000 - (1200 - 2 * p) * (1000 - 2 * p)) * d, -2)
    const b = frame.boundingBox.bounds
    // Centred in a wall to the left of its path (y from 0 to 300).
    expect((b[0][1] + b[1][1]) / 2).toBeCloseTo(150, 6)
    expect(b[0][2]).toBeCloseTo(900, 6)
    expect(b[1][2]).toBeCloseTo(1900, 6)
    const glass = openingPartShape(path, params, window, 'glass')
    expect(volume(glass)).toBeCloseTo((1200 - 2 * p) * (1000 - 2 * p) * FRAME.glass, -2)
  })

  it('makes a door frame with no bottom rail, and its leaf', () => {
    const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }
    const params = wallParams({ thickness: 200, height: 3000 })
    const door: Opening = { id: 2, kind: 'door', at: 1000, width: 900, height: 2100, sill: 0 }
    const p = FRAME.profile
    const frame = openingPartShape(path, params, door, 'frame')
    expect(volume(frame)).toBeCloseTo((900 * 2100 - (900 - 2 * p) * (2100 - p)) * FRAME.depth, -2)
    const leaf = openingPartShape(path, params, door, 'leaf')
    const g = FRAME.gap
    expect(volume(leaf)).toBeCloseTo((900 - 2 * p - 2 * g) * (2100 - p - 2 * g) * FRAME.leaf, -2)
  })
})
