import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { length } from '../core/curves'
import type { AnyCurve } from '../core/geometry'
import { box, explodeShape, extrudeCurve, planarFace, toBrep } from './brep'
import {
  borderCurves,
  capHoles,
  curveCutter,
  edgeCurves,
  extractFaces,
  extrudeSurface,
  nearestPiece,
  offsetSurface,
  projectCurves,
  pullCurve,
  splitShape,
} from './surfaceEdit'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
const square = (x0: number, y0: number, s: number, z = 0): AnyCurve => ({
  type: 'polyline',
  points: [v(x0, y0, z), v(x0 + s, y0, z), v(x0 + s, y0 + s, z), v(x0, y0 + s, z)],
  closed: true,
})
const area = (s: R.AnyShape) => R.measureShapeSurfaceProperties(s as R.Shape3D).area
const volume = (s: R.AnyShape) => R.measureShapeVolumeProperties(s as R.Shape3D).volume
const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })

describe('splitting and trimming', () => {
  it('splits a flat surface with a curve seen from above', () => {
    const face = planarFace(square(0, 0, 10))!
    const cutter = curveCutter(line(v(4, -5), v(4, 15)), Z, [face])
    const pieces = splitShape(face, [cutter])
    expect(pieces).toHaveLength(2)
    expect(pieces.map(area).sort((a, b) => a - b)).toEqual([expect.closeTo(40, 6), expect.closeTo(60, 6)])
    // Trimming keeps what was not picked.
    expect(area(pieces[nearestPiece(pieces, v(1, 5))])).toBeCloseTo(40, 6)
  })

  it('splits a solid into solids with a surface', () => {
    const solid = box(v(0, 0), v(10, 0), v(0, 10), v(0, 0, 10))
    const cutter = curveCutter(line(v(-5, 3), v(15, 3)), Z, [solid])
    const pieces = splitShape(solid, [cutter])
    expect(pieces.map((p) => toBrep(p).kind)).toEqual(['solid', 'solid'])
    expect(pieces.map(volume).sort((a, b) => a - b)).toEqual([expect.closeTo(300, 6), expect.closeTo(700, 6)])
  })

  it('splits a polysurface into connected polysurfaces', () => {
    // An open box (no top) cut horizontally keeps two polysurfaces.
    const open = extrudeCurve(square(0, 0, 10), v(0, 0, 10), false)
    const cutter = planarFace(square(-5, -5, 20, 4))!
    const pieces = splitShape(open, [cutter])
    expect(pieces).toHaveLength(2)
    expect(pieces.map((p) => p.faces.length)).toEqual([4, 4])
  })
})

describe('capping, offsetting and extruding', () => {
  it('caps the open ends of a tube into a solid', () => {
    const tube = extrudeCurve(square(0, 0, 4), v(0, 0, 5), false)
    const { shape, capped } = capHoles(tube)
    expect(capped).toBe(2)
    expect(toBrep(shape).kind).toBe('solid')
    expect(volume(shape)).toBeCloseTo(80, 6)
  })

  it('offsets a surface, and thickens it into a solid', () => {
    const face = planarFace(square(0, 0, 10))!
    const moved = offsetSurface(face, 2, false)
    expect(moved.boundingBox.bounds[0][2]).toBeCloseTo(2, 6)
    expect(volume(offsetSurface(face, 2, true))).toBeCloseTo(200, 6)
  })

  it('extrudes a surface, and a polysurface, into one solid', () => {
    expect(volume(extrudeSurface(planarFace(square(0, 0, 10))!, v(0, 0, 3)))).toBeCloseTo(300, 6)
    // An L of two faces side by side.
    const two = extrudeCurve({ type: 'polyline', points: [v(0, 0), v(4, 0), v(4, 4)], closed: false }, v(0, 0, 2), false)
    const solid = extrudeSurface(two, v(-1, 1, 0))
    expect(toBrep(solid).kind).toBe('solid')
  })
})

describe('curves on surfaces', () => {
  it('projects a curve onto a solid along a direction, onto every face it lands on', () => {
    const solid = box(v(0, 0), v(10, 0), v(0, 10), v(0, 0, 10))
    const curves = projectCurves([line(v(2, -5, 20), v(2, 15, 20))], solid, Z)
    // Down onto the top face and the bottom face.
    expect(curves).toHaveLength(2)
    expect(curves.map(length)).toEqual([expect.closeTo(10, 6), expect.closeTo(10, 6)])
  })

  it('pulls a curve onto the closest points of a surface', () => {
    const face = planarFace(square(0, 0, 10))!
    const pulled = pullCurve(line(v(1, 1, 5), v(9, 1, 3)), face)!
    expect(length(pulled)).toBeCloseTo(8, 3)
  })

  it('extracts faces, finds borders and edges', () => {
    const solid = box(v(0, 0), v(2, 0), v(0, 3), v(0, 0, 4))
    const { extracted, rest } = extractFaces(solid, [0])
    expect(extracted).toHaveLength(1)
    expect(rest).toHaveLength(1)
    expect(rest[0].faces).toHaveLength(5)
    // The rest is an open box: its border is the missing face's outline.
    const border = borderCurves(rest[0])
    expect(border).toHaveLength(1)
    expect(length(border[0])).toBeCloseTo(length(borderCurves(extracted[0])[0]), 9)
    expect(edgeCurves(solid, [0, 1]).length).toBe(2)
    expect(explodeShape(solid)).toHaveLength(6)
  })
})
