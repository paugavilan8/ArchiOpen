import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { FRAME, findJoins, layerBoundaries, WALL_TYPES, wallOutline, wallParams, type Opening } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { columnShape, floorShape, openingPartShape, railingShape, roofShape, roomRegion, skirtingShape, slabShape, stairShape, wallSegments, wallShape } from './architecture'
import { railingParams, railingPieces } from '../core/railings'
import { columnOutline, roofParams, stairFootprint, stairParams, stairPlan } from '../core/buildingParts'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const volume = (s: R.AnyShape) => R.measureShapeVolumeProperties(s as R.Shape3D).volume
/** The area of a closed profile standing in a vertical plane (measured from its own corners). */
const profileArea = (pts: Vector3[]) => {
  const o = pts[0]
  let sum = new Vector3()
  for (let i = 1; i + 1 < pts.length; i++) sum = sum.add(pts[i].clone().sub(o).cross(pts[i + 1].clone().sub(o)))
  return sum.length() / 2
}
const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4000, 0), v(4000, 3000), v(0, 3000)], closed: true }

describe('architectural solids', () => {
  it('cuts a ring of walls into one wall for each side, mitred at the corners', () => {
    const ring = wallShape(room, wallParams({ thickness: 200, height: 3000, openings: [{ id: 1, kind: 'door', at: 2000, width: 900, height: 2100, sill: 0 }] }))
    const pieces = wallSegments(ring, room, 200)
    expect(pieces).toHaveLength(4)
    expect(pieces.reduce((s, p) => s + volume(p), 0)).toBeCloseTo(volume(ring), -3)
    // Each side runs the length of its side of the room, plus the corners.
    const lengths = pieces.map((p) => Math.round(Math.max(p.boundingBox.width, p.boundingBox.height))).sort()
    expect(lengths).toEqual([3200, 3200, 4200, 4200])
    // An open path of one segment is left whole.
    const straight: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }
    expect(wallSegments(wallShape(straight, wallParams({ thickness: 200, height: 3000 })), straight, 200)).toHaveLength(1)
  })

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

  it('splits a wall into its layers, each a solid as thick as the layer', () => {
    const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5000, 0), v(5000, 4000)], closed: false }
    const params = wallParams({ thickness: 250, height: 3000, justification: 'center', layers: WALL_TYPES['Brick cavity'] })
    expect(layerBoundaries(params)).toEqual([125 - 115, 125 - 165, 125 - 235])
    const plain = wallShape(path, { ...params, layers: undefined })
    const layered = wallShape(path, params)
    const solids = (layered as R.Shape3D).solids ?? []
    expect(solids).toHaveLength(4)
    expect(volume(layered)).toBeCloseTo(volume(plain), -3)
    // Along the centre line of each layer, about 9 m of it.
    const volumes = solids.map((x) => volume(x)).sort((a, b) => a - b)
    const expected = [15, 50, 70, 115].map((t) => t * 3000 * 9000)
    volumes.forEach((vol, i) => expect(Math.abs(vol - expected[i]) / expected[i]).toBeLessThan(0.03))
    // A closed path (a room) splits too.
    const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5000, 0), v(5000, 4000), v(0, 4000)], closed: true }
    const ring = wallShape(room, wallParams({ thickness: 100, height: 2500, justification: 'center', layers: WALL_TYPES.Partition }))
    expect((ring as R.Shape3D).solids).toHaveLength(3)
  })

  it('makes a slab under its outline', () => {
    const lifted: AnyCurve = { ...room, points: room.type === 'polyline' ? room.points.map((p) => p.clone().setZ(3000)) : [] } as AnyCurve
    const slab = slabShape(lifted, { thickness: 250 })
    expect(volume(slab)).toBeCloseTo(4000 * 3000 * 250, -3)
    const box = slab.boundingBox.bounds
    expect(box[1][2]).toBeCloseTo(3000, 6)
    expect(box[0][2]).toBeCloseTo(2750, 6)
    // With a stairwell through it.
    const holed = slabShape(lifted, { thickness: 250, holes: [{ points: [[500, 500], [1500, 500], [1500, 2500], [500, 2500]], stair: 7 }] })
    expect(volume(holed)).toBeCloseTo((4000 * 3000 - 1000 * 2000) * 250, -3)
  })

  it('cuts the footprint of a stair, flights and landings, through the slab above', () => {
    const line: AnyCurve = { type: 'polyline', points: [v(0, 0), v(3000, 0), v(3000, 2000)], closed: false }
    const plan = stairPlan(line, stairParams({ width: 1000, height: 3000 }))
    const footprint = stairFootprint(plan)
    expect(footprint).toHaveLength(plan.flights.length + plan.landings.length)
    const area = (pts: [number, number][]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0)) / 2
    // Each flight is as wide as the stair and as long as its run.
    plan.flights.forEach((f, i) => expect(area(footprint[i])).toBeCloseTo(f.start.distanceTo(f.end) * 1000, 3))
    // A margin grows every side.
    const grown = stairFootprint(plan, 50)
    plan.flights.forEach((f, i) => expect(area(grown[i])).toBeCloseTo((f.start.distanceTo(f.end) + 100) * 1100, 3))
    // The stair lies within its footprint.
    const xs = footprint.flat().map((p) => p[0])
    const ys = footprint.flat().map((p) => p[1])
    const b = stairShape(line, stairParams({ width: 1000, height: 3000 })).boundingBox.bounds
    expect(b[0][0]).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6)
    expect(b[1][0]).toBeLessThanOrEqual(Math.max(...xs) + 1e-6)
    expect(b[0][1]).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6)
    expect(b[1][1]).toBeLessThanOrEqual(Math.max(...ys) + 1e-6)
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

  it('makes hip, gable and shed roofs as a layer under their slopes', () => {
    const square: AnyCurve = { type: 'polyline', points: [v(0, 0, 3000), v(10000, 0, 3000), v(10000, 10000, 3000), v(0, 10000, 3000)], closed: true }
    const cos45 = Math.SQRT1_2
    const hip = roofShape(square, roofParams({ type: 'hip', pitch: 45, overhang: 0, thickness: 200 }))
    // A layer of vertical thickness t / cos(pitch) over the whole footprint.
    expect(volume(hip) / (1e8 * (200 / cos45))).toBeCloseTo(1, 4)
    const b = hip.boundingBox.bounds
    // Its underside rests on the outline: the top is a thickness higher.
    expect(b[1][2]).toBeCloseTo(3000 + 5000 + 200 / cos45, 3)
    expect(b[0][2]).toBeCloseTo(3000, 3)
    const rect: AnyCurve = { type: 'polyline', points: [v(0, 0, 3000), v(8000, 0, 3000), v(8000, 6000, 3000), v(0, 6000, 3000)], closed: true }
    const gable = roofShape(rect, roofParams({ type: 'gable', pitch: 30, overhang: 500, thickness: 250 }))
    const tan30 = Math.tan(Math.PI / 6)
    const g = gable.boundingBox.bounds
    // The ridge over the middle of the short way; the eaves lower by the overhang's rise.
    expect(g[1][2]).toBeCloseTo(3000 + 3000 * tan30 + 250 / Math.cos(Math.PI / 6), 3)
    expect(g[0][2]).toBeCloseTo(3000 - 500 * tan30, 3)
    expect(volume(gable) / (9000 * 7000 * (250 / Math.cos(Math.PI / 6)))).toBeCloseTo(1, 4)
    const shed = roofShape(rect, roofParams({ type: 'shed', pitch: 10, overhang: 0, thickness: 200 }))
    expect(shed.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 6000 * Math.tan(Math.PI / 18) + 200 / Math.cos(Math.PI / 18), 3)
  })

  it('makes a stair whose volume is its profile across its width', () => {
    const line: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4500, 0)], closed: false }
    const params = stairParams({ width: 1000 }, 3000)
    expect(volume(stairShape(line, params))).toBeCloseTo(profileArea(stairPlan(line, params).flights[0].profile.points) * 1000, -3)
  })

  it('makes an L stair: its two flights and its landing, joined', () => {
    const line: AnyCurve = { type: 'polyline', points: [v(0, 0), v(0, 3500), v(2500, 3500)], closed: false }
    const params = stairParams({ width: 1000, risers: 16 }, 2800)
    const plan = stairPlan(line, params)
    const shape = stairShape(line, params)
    expect((shape as R.Shape3D).solids?.length ?? 1).toBe(1)
    const parts = plan.flights.reduce((sum, f) => sum + profileArea(f.profile.points) * 1000, 0) + 1000 * 1000 * params.waist
    // The flights touch the landing; at most a sliver overlaps.
    expect(volume(shape)).toBeLessThanOrEqual(parts + 1)
    expect(volume(shape)).toBeGreaterThan(parts * 0.97)
    expect(shape.boundingBox.bounds[1][2]).toBeCloseTo(2800, 6)
    expect(shape.boundingBox.bounds[1][0]).toBeCloseTo(2500, 6)
  })

  it('makes columns', () => {
    expect(volume(columnShape(columnOutline(v(0, 0), 'rectangular', 300, 400), { height: 3000 }))).toBeCloseTo(300 * 400 * 3000, -2)
    expect(volume(columnShape(columnOutline(v(0, 0), 'round', 400, 0), { height: 3000 }))).toBeCloseTo(Math.PI * 200 * 200 * 3000, -2)
  })

  it('raises walls to the underside of a roof over them', () => {
    const tan30 = Math.tan(Math.PI / 6)
    const roofOutline: AnyCurve = { type: 'polyline', points: [v(-100, -100, 3000), v(8100, -100, 3000), v(8100, 6100, 3000), v(-100, 6100, 3000)], closed: true }
    const roofs = [{ outline: roofOutline, params: roofParams({ type: 'gable', pitch: 30, overhang: 500, thickness: 250 }) }]
    const params = wallParams({ thickness: 200, height: 3000 })
    // A gable wall (along y, at x = 0): up to the ridge in the middle, 3000 at its ends.
    const gable = wallShape({ type: 'polyline', points: [v(0, 0), v(0, 6000)], closed: false }, params, [], roofs)
    expect(gable.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 3100 * tan30, 3)
    // Volume: the plain wall plus the triangle over it (between the outer and inner faces).
    const plain = 6000 * 200 * 3000
    expect(volume(gable)).toBeGreaterThan(plain + 0.9 * 200 * 6000 * 3000 * tan30 / 2)
    // An eaves wall (along x, at y = 0): its inner face rises a little under the slope, no more.
    const eaves = wallShape({ type: 'polyline', points: [v(0, 0), v(8000, 0)], closed: false }, params, [], roofs)
    expect(eaves.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 200 * tan30, 3)
    // A wall with no roof over it stays as high as it is.
    expect(wallShape({ type: 'polyline', points: [v(0, 0), v(0, 6000)], closed: false }, params).boundingBox.bounds[1][2]).toBeCloseTo(3000, 6)
  })

  it('makes hip and cross-gable roofs over an L plan, and raises walls under them', () => {
    // Arms 4000 wide: along x to 10000, along y to 9000.
    const ell: AnyCurve = { type: 'polyline', points: [v(0, 0, 3000), v(10000, 0, 3000), v(10000, 4000, 3000), v(4000, 4000, 3000), v(4000, 9000, 3000), v(0, 9000, 3000)], closed: true }
    const area = 10000 * 4000 + 4000 * 5000
    const tan30 = Math.tan(Math.PI / 6)
    const drop = 200 / Math.cos(Math.PI / 6)
    for (const type of ['hip', 'gable'] as const) {
      const roof = roofShape(ell, roofParams({ type, pitch: 30, overhang: 0, thickness: 200 }))
      // A layer of the same vertical thickness over the whole L: no gaps or overlaps at the valley.
      expect(volume(roof) / (area * drop)).toBeCloseTo(1, 4)
      expect(roof.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 2000 * tan30 + drop, 3)
    }
    // The gable wall closing the end of the y arm reaches its ridge; the inside corner wall does not.
    const roofs = [{ outline: ell, params: roofParams({ type: 'gable', pitch: 30, overhang: 0, thickness: 200 }) }]
    const params = wallParams({ thickness: 200, height: 3000 })
    const gable = wallShape({ type: 'polyline', points: [v(0, 9000), v(4000, 9000)], closed: false }, params, [], roofs)
    expect(gable.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 2000 * tan30, 3)
    const inner = wallShape({ type: 'polyline', points: [v(10000, 4000), v(4000, 4000)], closed: false }, params, [], roofs)
    expect(inner.boundingBox.bounds[1][2]).toBeCloseTo(3000 + 100 * tan30, 3)
  })

  it('makes a railing as its pieces kept together', () => {
    const points = [v(0, 0), v(3000, 0), v(3000, 2000)]
    const params = railingParams({ height: 1000, style: 'bars' })
    const shape = railingShape([points], params)
    const expected = railingPieces(points, params).reduce((sum, b) => sum + Math.abs(b.u.clone().cross(b.v).dot(b.w)), 0)
    expect(volume(shape)).toBeCloseTo(expected, -2)
    expect(shape.boundingBox.bounds[1][2]).toBeCloseTo(1000, 6)
  })

  it('finds the room a point is in, between the walls', () => {
    const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })
    const refs = [
      line(v(0, 0), v(8000, 0)),
      line(v(8000, 0), v(8000, 5000)),
      line(v(8000, 5000), v(0, 5000)),
      line(v(0, 5000), v(0, 0)),
      line(v(4000, 0), v(4000, 5000)),
    ].map((path) => ({ path, params: wallParams({ thickness: 200, height: 3000 }) }))
    const outlines = refs.map((w, i) => {
      const others = refs.filter((_, j) => j !== i)
      return wallOutline(w.path, w.params, findJoins(w, others).map((j) => ({ ...j, other: others[j.other] })))
    })
    // The left room: inside faces at x 100..3900, y 100..4900.
    const left = roomRegion(outlines, v(2000, 2500))
    expect(left.area).toBeCloseTo(3800 * 4800, 0)
    expect(left.loops).toHaveLength(1)
    const right = roomRegion(outlines, v(6000, 1000))
    expect(right.area).toBeCloseTo(3800 * 4800, 0)
    // Outside, or with a wall missing, there is no room.
    expect(() => roomRegion(outlines, v(9000, 2500))).toThrow(/enclose/)
    expect(() => roomRegion(outlines.slice(1), v(2000, 2500))).toThrow(/enclose/)
    // A closed wall (a room drawn as one), with a column in it: the column is a hole.
    const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0), v(6000, 4000), v(0, 4000)], closed: true }
    const column: AnyCurve = { type: 'polyline', points: [v(2900, 1900), v(3100, 1900), v(3100, 2100), v(2900, 2100)], closed: true }
    const withColumn = roomRegion([wallOutline(room, wallParams({ thickness: 200 })), [column]], v(1000, 1000))
    expect(withColumn.area).toBeCloseTo(5800 * 3800 - 200 * 200, 0)
    expect(withColumn.loops).toHaveLength(2)
  })

  it('makes floor finishes and skirting round a room, with a column and a door', () => {
    const room: AnyCurve = { type: 'polyline', points: [v(100, 100), v(3900, 100), v(3900, 4900), v(100, 4900)], closed: true }
    const column: AnyCurve = { type: 'polyline', points: [v(1900, 2400), v(2100, 2400), v(2100, 2600), v(1900, 2600)], closed: true }
    // Both ways round: the outline as Room makes it may run either way.
    for (const loops of [[room, column], [{ ...room, points: [...(room as { points: Vector3[] }).points].reverse() } as AnyCurve, column]]) {
      const floor = floorShape(loops, 20)
      expect(volume(floor)).toBeCloseTo((3800 * 4800 - 200 * 200) * 20, -2)
      const skirting = skirtingShape(loops, 80, 15)
      // A band 15 thick along the four walls and round the column.
      const walls = (3800 * 4800 - 3770 * 4770) * 80
      const round = (230 * 230 - 200 * 200) * 80
      expect(volume(skirting)).toBeCloseTo(walls + round, -2)
    }
    // A door in the wall at y = 100: no skirting across it.
    const door = { origin: v(1000, -200, -1), u: v(900, 0, 0), v: v(0, 600, 0), w: v(0, 0, 2100) }
    const cut = skirtingShape([room], 80, 15, [door])
    expect(volume(cut)).toBeCloseTo((3800 * 4800 - 3770 * 4770) * 80 - 900 * 15 * 80, -2)
  })
})
