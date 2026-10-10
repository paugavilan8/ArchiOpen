import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { alignOffsets, boxInPlane, distributeOffsets, frameOf, orientByPoints, orientByThreePoints, type PlaneBox } from './orient'
import type { Geometry, Plane } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const at = (m: ReturnType<typeof orientByPoints>, p: Vector3) => p.clone().applyMatrix4(m)
const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-9)
const world: Plane = { origin: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), normal: v(0, 0, 1) }
const box = (x0: number, x1: number, y0 = 0, y1 = 1): PlaneBox => ({ min: v(x0, y0), max: v(x1, y1) })

describe('Orient', () => {
  it('with one pair of points only moves', () => {
    const m = orientByPoints([v(1, 1)], [v(5, 3)])
    close(at(m, v(2, 2)), v(6, 4))
  })

  it('moves the first point onto the first target and turns the reference line onto the target line', () => {
    // A unit line along X placed on a line from (10, 10) going up Y.
    const m = orientByPoints([v(0, 0), v(1, 0)], [v(10, 10), v(10, 13)])
    close(at(m, v(0, 0)), v(10, 10))
    close(at(m, v(1, 0)), v(10, 11))
    // Without scaling, lengths stay.
    close(at(m, v(0, 1)), v(9, 10))
  })

  it('scales evenly, or only along the reference line', () => {
    const uniform = orientByPoints([v(0, 0), v(2, 0)], [v(0, 0), v(0, 6)], 'Uniform')
    close(at(uniform, v(2, 0)), v(0, 6))
    close(at(uniform, v(0, 1)), v(-3, 0))
    const oneWay = orientByPoints([v(0, 0), v(2, 0)], [v(0, 0), v(0, 6)], 'OneDirection')
    close(at(oneWay, v(2, 0)), v(0, 6))
    // Across the line, sizes stay.
    close(at(oneWay, v(0, 1)), v(-1, 0))
  })

  it('turns in space, not only in the plane', () => {
    const m = orientByPoints([v(0, 0), v(1, 0)], [v(0, 0), v(0, 0, 1)])
    close(at(m, v(1, 0)), v(0, 0, 1))
  })

  it('refuses reference or target points that are the same point', () => {
    expect(() => orientByPoints([v(0, 0), v(0, 0)], [v(1, 1), v(2, 2)])).toThrow()
  })
})

describe('Orient3Pt', () => {
  it('places the frame of three points on another, without scaling', () => {
    const from = [v(0, 0), v(1, 0), v(0, 1)]
    // A frame standing up: origin (5, 5, 5), X along Y, the third point up.
    const to = [v(5, 5, 5), v(5, 8, 5), v(5, 5, 9)]
    const m = orientByThreePoints(from, to)
    close(at(m, v(0, 0)), v(5, 5, 5))
    close(at(m, v(1, 0)), v(5, 6, 5))
    close(at(m, v(0, 1)), v(5, 5, 6))
    // It keeps sizes and handedness.
    expect(m.determinant()).toBeCloseTo(1)
  })

  it('needs points that are not in a line', () => {
    expect(frameOf([v(0, 0), v(1, 0), v(2, 0)])).toBeNull()
    expect(() => orientByThreePoints([v(0, 0), v(1, 0), v(2, 0)], [v(0, 0), v(1, 0), v(0, 1)])).toThrow()
  })
})

describe('Align', () => {
  const boxes = [box(0, 2, 0, 1), box(5, 6, 3, 7), box(-1, 0, 2, 4)]

  it('lines boxes up on the left, right or center of them all', () => {
    expect(alignOffsets(boxes, 'Left').map((o) => o.x)).toEqual([-1, -6, 0])
    expect(alignOffsets(boxes, 'Right').map((o) => o.x)).toEqual([4, 0, 6])
    // Center of all is x = 2.5, y = 3.5.
    expect(alignOffsets(boxes, 'Center')).toEqual([
      { x: 1.5, y: 3 },
      { x: -3, y: -1.5 },
      { x: 3, y: 0.5 },
    ])
  })

  it('moves only across the alignment', () => {
    for (const o of alignOffsets(boxes, 'Top')) expect(o.x).toBe(0)
    expect(alignOffsets(boxes, 'Bottom').map((o) => o.y)).toEqual([0, -3, -2])
    expect(alignOffsets(boxes, 'VerticalCenter').map((o) => o.y)).toEqual([3, -1.5, 0.5])
    expect(alignOffsets(boxes, 'HorizontalCenter').map((o) => o.x)).toEqual([1.5, -3, 3])
  })

  it('lines them up on a given point', () => {
    expect(alignOffsets(boxes, 'Left', { x: 10, y: 0 }).map((o) => o.x)).toEqual([10, 5, 11])
  })
})

describe('Distribute', () => {
  it('spreads centers evenly between the first and the last, in their order', () => {
    // Centers at 0.5, 9.5 and 2 (listed out of order).
    const offsets = distributeOffsets([box(0, 1), box(9, 10), box(1.5, 2.5)], 0, 'Centers')
    expect(offsets).toEqual([0, 0, 3])
  })

  it('leaves equal gaps between boxes of different sizes', () => {
    // From 0 to 20: sizes 2, 6 and 2, so two gaps of 5.
    const offsets = distributeOffsets([box(0, 2), box(3, 9), box(18, 20)], 0, 'Gaps')
    expect(offsets).toEqual([0, 4, 0])
  })

  it('follows a given spacing from the first box', () => {
    expect(distributeOffsets([box(0, 1), box(2, 3), box(4, 5)], 0, 'Centers', 10)).toEqual([0, 8, 16])
    expect(distributeOffsets([box(0, 1), box(2, 3), box(4, 5)], 0, 'Gaps', 1)).toEqual([0, 0, 0])
  })

  it('works along any axis of the plane', () => {
    const b = (z0: number, z1: number): PlaneBox => ({ min: v(0, 0, z0), max: v(1, 1, z1) })
    expect(distributeOffsets([b(0, 1), b(1, 2), b(9, 10)], 2, 'Centers')).toEqual([0, 3.5, 0])
  })
})

describe('bounding boxes in a construction plane', () => {
  it('measure along the plane axes from its origin', () => {
    const line: Geometry = { type: 'polyline', points: [v(1, 1, 0), v(3, 2, 5)], closed: false }
    const front: Plane = { origin: v(0, 0, 1), xaxis: v(1, 0, 0), yaxis: v(0, 0, 1), normal: v(0, -1, 0) }
    const b = boxInPlane([line], front)
    expect(b.min.toArray()).toEqual([1, -1, -2])
    expect(b.max.toArray()).toEqual([3, 4, -1])
    expect(boxInPlane([line], world).max.toArray()).toEqual([3, 2, 5])
  })
})
