import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { divisionLengths } from '../commands/points'
import { transform } from './curves'
import { atLengths, ellipse } from './curveTools'
import { geometryFromJSON, geometryToJSON, snapPoints, wireframe, type PointGeometry } from './geometry'
import { writeDxf } from '../io/dxf'
import { readDxf } from '../io/dxfRead'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('point objects', () => {
  it('move, snap, draw and save like other objects', () => {
    const p: PointGeometry = { type: 'point', point: v(1, 2, 3) }
    expect(transform(p, new Matrix4().makeTranslation(1, 1, 1)).point.toArray()).toEqual([2, 3, 4])
    expect(snapPoints(p).end[0].toArray()).toEqual([1, 2, 3])
    expect(wireframe(p)).toEqual([[v(1, 2, 3)]])
    expect(geometryFromJSON(JSON.parse(JSON.stringify(geometryToJSON(p))))).toEqual(p)
  })

  it('go through DXF as POINT entities', () => {
    const layers = [{ id: 1, name: 'Survey', color: '#ff0000', visible: true, locked: false }]
    const text = writeDxf({ units: 'Meters', layers, objects: [{ layerId: 1, geometry: { type: 'point', point: v(5, 6, 7) } }], linetypeScale: 1, millimetersPerUnit: 1000 })
    const back = readDxf(new TextEncoder().encode(text), 'Meters')
    expect(back.objects[0].geometry).toEqual({ type: 'point', point: v(5, 6, 7) })
  })
})

describe('dividing curves', () => {
  it('into equal segments, closed curves without a repeated end', () => {
    expect(divisionLengths(10, false, { segments: 4 })).toEqual([0, 2.5, 5, 7.5, 10])
    expect(divisionLengths(10, true, { segments: 4 })).toEqual([0, 2.5, 5, 7.5])
  })

  it('into pieces of a length, the remainder at the end', () => {
    expect(divisionLengths(10, false, { step: 3 })).toEqual([0, 3, 6, 9])
    expect(divisionLengths(9, true, { step: 3 })).toEqual([0, 3, 6])
  })

  it('places points at even lengths along a curve', () => {
    const e = ellipse(v(0, 0), v(1, 0), v(0, 1), 4, 1.5)
    const quarter = 18.1834313916 / 4
    const { points } = atLengths(e, [0, quarter, 2 * quarter])
    // A quarter of the way round an ellipse from the end of its long axis is the end of the short one.
    expect(points[1].x).toBeCloseTo(0, 4)
    expect(points[1].y).toBeCloseTo(1.5, 4)
    expect(points[2].x).toBeCloseTo(-4, 4)
  })
})
