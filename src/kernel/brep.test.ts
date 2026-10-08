import { Matrix4, Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { transform } from '../core/curves'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { clampedKnots } from '../math/nurbs'
import { boolean, box, cylinder, extrudeCurve, filletEdges, loftCurves, planarFace, revolveCurve, shapeOf, sphere, toBrep } from './brep'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
const square: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)], closed: true }
const circle: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 }

const volume = (s: R.AnyShape) => R.measureShapeVolumeProperties(s as R.Shape3D).volume

describe('building solids from curves', () => {
  it('extrudes a closed polyline into a capped solid', () => {
    const solid = extrudeCurve(square, v(0, 0, 3), true)
    expect(volume(solid)).toBeCloseTo(48, 6)
    const g = toBrep(solid)
    expect(g.kind).toBe('solid')
    expect(g.faces).toBe(6)
    expect(g.display.edges).toHaveLength(12)
  })

  it('extrudes an open curve into a surface', () => {
    const line: AnyCurve = { type: 'polyline', points: [v(0, 0), v(5, 0)], closed: false }
    const g = toBrep(extrudeCurve(line, v(0, 0, 2), true))
    expect(g.kind).toBe('surface')
  })

  it('extrudes a B-spline exactly', () => {
    const spline: AnyCurve = { type: 'curve', degree: 3, points: [v(0, 0), v(1, 3), v(4, 3), v(5, 0)], knots: clampedKnots(4, 3) }
    const g = toBrep(extrudeCurve(spline, v(0, 0, 1), false))
    expect(g.faces).toBe(1)
  })

  it('revolves a closed profile into a solid', () => {
    // A 1×1 square at distance 2 to 3 from the Z axis makes a ring of volume π(3² − 2²)·1.
    const profile: AnyCurve = { type: 'polyline', points: [v(2, 0, 0), v(3, 0, 0), v(3, 0, 1), v(2, 0, 1)], closed: true }
    expect(volume(revolveCurve(profile, v(0, 0), Z, Math.PI * 2))).toBeCloseTo(Math.PI * 5, 4)
  })

  it('lofts between two circles into a frustum', () => {
    const top: AnyCurve = { ...circle, center: v(0, 0, 3), radius: 1 }
    const expected = (Math.PI * 3 * (4 + 2 + 1)) / 3
    expect(volume(loftCurves([circle, top]))).toBeCloseTo(expected, 2)
  })

  it('makes a planar face only from closed planar curves', () => {
    expect(planarFace(square)).not.toBeNull()
    expect(planarFace({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false })).toBeNull()
  })
})

describe('booleans and fillets', () => {
  it('subtracts a cylinder from a box', () => {
    const block = box(v(0, 0), v(10, 0), v(0, 10), v(0, 0, 2))
    const hole = cylinder(v(5, 5, -1), 1, 4, Z)
    expect(volume(boolean('difference', block, [hole]))).toBeCloseTo(200 - Math.PI * 2, 4)
  })

  it('unions and intersects', () => {
    const a = box(v(0, 0), v(2, 0), v(0, 2), v(0, 0, 2))
    const b = box(v(1, 1), v(2, 0), v(0, 2), v(0, 0, 2))
    expect(volume(boolean('union', a, [b]))).toBeCloseTo(14, 6)
    const c = box(v(0, 0), v(2, 0), v(0, 2), v(0, 0, 2))
    const d = box(v(1, 1), v(2, 0), v(0, 2), v(0, 0, 2))
    expect(volume(boolean('intersection', c, [d]))).toBeCloseTo(2, 6)
  })

  it('fillets chosen edges', () => {
    const block = box(v(0, 0), v(4, 0), v(0, 4), v(0, 0, 4))
    const rounded = filletEdges(block, [0], 1)
    expect(rounded.faces.length).toBe(7)
    expect(volume(rounded)).toBeCloseTo(64 - 4 * (1 - Math.PI / 4), 4)
  })

  it('makes spheres', () => {
    expect(volume(sphere(v(1, 2, 3), 2))).toBeCloseTo((4 / 3) * Math.PI * 8, 4)
  })
})

describe('stored breps', () => {
  const vertexBox = (g: BrepGeometry) => {
    const v = g.display.vertices
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < v.length; i++) {
      min[i % 3] = Math.min(min[i % 3], v[i])
      max[i % 3] = Math.max(max[i % 3], v[i])
    }
    return [...min, ...max]
  }

  it('applies a pending move, rotation, scale and mirror exactly when read back', () => {
    const g = toBrep(box(v(0, 0), v(4, 0), v(0, 2), v(0, 0, 1)))
    const m = new Matrix4()
      .makeTranslation(10, -3, 2)
      .multiply(new Matrix4().makeRotationZ(0.7))
      .multiply(new Matrix4().makeScale(2, 2, 2))
      .multiply(new Matrix4().makeScale(-1, 1, 1))
    const moved = transform(g, m) as BrepGeometry
    expect(moved.matrix).not.toBeNull()
    // The display data moved without the kernel; the exact shape must land in the same place.
    const exact = toBrep(shapeOf(moved))
    vertexBox(exact).forEach((value, i) => expect(value).toBeCloseTo(vertexBox(moved)[i], 4))
    expect(volume(shapeOf(moved))).toBeCloseTo(8 * 8, 4)
  })

  it('refuses a non-uniform scale on a solid', () => {
    const g = transform(toBrep(box(v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1))), new Matrix4().makeScale(2, 1, 1)) as BrepGeometry
    expect(() => shapeOf(g)).toThrow()
  })
})
