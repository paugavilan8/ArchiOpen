import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { box, extrudeCurve, joinShapes, loftCurves, planarFace, sphere } from './brep'
import { checkShape, shapeArea, shapeBounds, shapeVolume } from './measure'
import { ellipse } from '../core/curveTools'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('measuring shapes', () => {
  it('measures a box and a sphere exactly', () => {
    const b = box(v(1, 2, 3), v(2, 0, 0), v(0, 3, 0), v(0, 0, 4))
    expect(shapeArea(b).value).toBeCloseTo(52, 9)
    const vol = shapeVolume(b)
    expect(vol.value).toBeCloseTo(24, 9)
    expect(vol.centroid.toArray().map((x) => +x.toFixed(9))).toEqual([2, 3.5, 5])
    const s = sphere(v(5, 0, 0), 2)
    expect(shapeVolume(s).value).toBeCloseTo((4 / 3) * Math.PI * 8, 6)
    expect(shapeArea(s).value).toBeCloseTo(4 * Math.PI * 4, 6)
  })

  it('stays accurate on rational surfaces', () => {
    // An extruded ellipse: OCCT's default integration rule is visibly off here.
    const solid = extrudeCurve(ellipse(v(0, 0), v(1, 0), v(0, 1), 4, 1.5), v(0, 0, 2), true)
    expect(shapeVolume(solid).value).toBeCloseTo(Math.PI * 4 * 1.5 * 2, 5)
    // Sides: the ellipse's perimeter times the height.
    const [a, b] = [4, 1.5]
    // The complete elliptic integral 4a·E(1 − b²/a²), worked out to 12 digits.
    const perimeter = 18.1834313916
    expect(Math.abs(shapeArea(solid).value / (2 * Math.PI * a * b + 2 * perimeter) - 1)).toBeLessThan(1e-5)
    // A loft from a circle to an ellipse: nearly ruled, so Simpson's rule on its sections is close
    // (the middle one is about an ellipse with semi-axes 2.5 and 1.5).
    const loft = loftCurves([
      { type: 'circle', center: v(0, 0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 },
      ellipse(v(1, 0, 3), v(1, 0), v(0, 1), 3, 1),
    ])
    const capped = joinShapes([loft, planarFace({ type: 'circle', center: v(0, 0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 })!, planarFace(ellipse(v(1, 0, 3), v(1, 0), v(0, 1), 3, 1))!])
    expect(shapeVolume(capped).value).toBeCloseTo((3 / 6) * (Math.PI * 4 + 4 * Math.PI * 2.5 * 1.5 + Math.PI * 3), 2)
  })

  it('finds tight bounding boxes, also in a turned plane', () => {
    const s = sphere(v(5, 0, 1), 2)
    const world = shapeBounds(s)
    expect(world.min.toArray().map((x) => +x.toFixed(6))).toEqual([3, -2, -1])
    expect(world.max.toArray().map((x) => +x.toFixed(6))).toEqual([7, 2, 3])
    const b = box(v(0, 0, 0), v(2, 0, 0), v(0, 3, 0), v(0, 0, 4))
    const turned = shapeBounds(b, { origin: v(1, 1, 0), xaxis: v(0, 1, 0), yaxis: v(-1, 0, 0), normal: v(0, 0, 1) })
    expect(turned.min.toArray().map((x) => +x.toFixed(6))).toEqual([-1, -1, 0])
    expect(turned.max.toArray().map((x) => +x.toFixed(6))).toEqual([2, 1, 4])
  })

  it('checks solids and open surfaces', () => {
    const b = box(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(0, 0, 1))
    expect(checkShape(b)).toEqual({ valid: true, faces: 6, edges: 12, nakedEdges: 0, nonManifoldEdges: 0 })
    const open = R.makeCompound(b.faces.slice(0, 5))
    expect(checkShape(open).nakedEdges).toBe(4)
  })
})
