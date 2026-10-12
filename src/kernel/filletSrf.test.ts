import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { box, planarFace } from './brep'
import { filletSurfaces } from './filletSrf'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const rect = (points: Vector3[]) => planarFace({ type: 'polyline', points, closed: true })!
const area = (s: R.AnyShape) => R.measureShapeSurfaceProperties(s as R.Shape3D).area
// A floor 10 × 10 and a wall along its x = 0 edge, 10 high.
const floor = () => rect([v(0, 0), v(10, 0), v(10, 10), v(0, 10)])
const wall = () => rect([v(0, 0), v(0, 10), v(0, 10, 10), v(0, 0, 10)])

describe('FilletSrf', () => {
  it('fillets a floor and a wall with a quarter cylinder', () => {
    const { fillet, trimmed } = filletSurfaces(floor(), 0, v(5, 5), wall(), 0, v(0, 5, 5), 2, false)
    expect(trimmed).toBeNull()
    // A quarter of a cylinder of radius 2, 10 long.
    expect(area(fillet)).toBeCloseTo((2 * Math.PI * 2 * 10) / 4, 2)
    const b = fillet.boundingBox.bounds
    expect(b[0][0]).toBeCloseTo(0, 3)
    expect(b[1][0]).toBeCloseTo(2, 3)
    expect(b[0][1]).toBeCloseTo(0, 3)
    expect(b[1][1]).toBeCloseTo(10, 3)
    expect(b[1][2]).toBeCloseTo(2, 3)
  })

  it('trims both surfaces back to the fillet', () => {
    const { trimmed } = filletSurfaces(floor(), 0, v(5, 5), wall(), 0, v(0, 5, 5), 2, true)
    expect(area(trimmed![0])).toBeCloseTo(80, 3)
    expect(area(trimmed![1])).toBeCloseTo(80, 3)
  })

  it('fillets surfaces that do not meet, out to where both reach', () => {
    // The wall stands back from a shorter floor, and is only 6 long.
    const short = rect([v(1, 0), v(10, 0), v(10, 10), v(1, 10)])
    const narrow = rect([v(0, 2), v(0, 8), v(0, 8, 10), v(0, 2, 10)])
    const { fillet } = filletSurfaces(short, 0, v(5, 5), narrow, 0, v(0, 5, 5), 2, false)
    const b = fillet.boundingBox.bounds
    expect(b[0][1]).toBeCloseTo(2, 3)
    expect(b[1][1]).toBeCloseTo(8, 3)
  })

  it('fillets the faces of solids, keeping their other faces', () => {
    const a = box(v(0, 0), v(10, 0), v(0, 10), v(0, 0, 1))
    const top = a.faces.findIndex((f) => Math.abs(f.center.z - 1) < 1e-6)
    const w = wall()
    const { fillet, trimmed } = filletSurfaces(a, top, v(5, 5, 1), w, 0, v(0, 5, 5), 1, true)
    expect(area(fillet)).toBeGreaterThan(0)
    expect(trimmed![0].faces.length).toBe(6)
  })

  it('fillets a column into the floor all around it', () => {
    const column = R.makeCylinder(2, 10, [5, 5, -1], [0, 0, 1])
    const side = column.faces.findIndex((f) => f.geomType === 'CYLINDRE')
    const ground = rect([v(-5, -5), v(15, -5), v(15, 15), v(-5, 15)])
    const { fillet, trimmed } = filletSurfaces(ground, 0, v(12, 5), column, side, v(7, 5, 5), 1, true)
    const b = fillet.boundingBox.bounds
    // A ring from radius 2 out to 3 around the column, 1 high.
    expect(b[1][0]).toBeCloseTo(8, 2)
    expect(b[0][0]).toBeCloseTo(2, 2)
    expect(b[1][2]).toBeCloseTo(1, 2)
    expect(area(trimmed![0])).toBeCloseTo(400 - Math.PI * 9, 0)
  })

  it('fails when no fillet fits', () => {
    const far = rect([v(20, 0, 5), v(30, 0, 5), v(30, 10, 5), v(20, 10, 5)])
    expect(() => filletSurfaces(floor(), 0, v(5, 5), far, 0, v(25, 5, 5), 1, false)).toThrow()
  })
})
