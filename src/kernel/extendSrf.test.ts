import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { planarFace, revolveCurve } from './brep'
import { extendSurface } from './extendSrf'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('extendSurface', () => {
  it('extends a plane by a length past the edge picked', () => {
    const square = planarFace({ type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10), v(0, 10)], closed: true })!
    const out = extendSurface(square, v(10, 5), 5)
    expect(R.measureArea(out.faces[0])).toBeCloseTo(150, 6)
    const [[x0, y0], [x1, y1]] = out.boundingBox.bounds
    ;[x0, y0, x1, y1].forEach((x, i) => expect(x).toBeCloseTo([0, 0, 15, 10][i], 5))
  })

  it('carries a curved surface on as it goes: an arc stays on its circle', () => {
    // A quarter of a cylinder of radius 10, from a revolved line.
    const quarter = revolveCurve({ type: 'polyline', points: [v(10, 0, 0), v(10, 0, 5)], closed: false }, v(0, 0), v(0, 0, 1), Math.PI / 2)
    const out = extendSurface(quarter.faces.length === 1 ? quarter : R.cast(quarter.faces[0].wrapped), v(0, 10, 2.5), 3)
    const k = R.getOC()
    const s = new k.BRepAdaptor_Surface(k.TopoDS.Face(out.faces[0].wrapped), true)
    // Every point still 10 from the axis (as near as the cylinder's B-spline form is).
    for (let i = 0; i <= 10; i++) {
      const u = s.FirstUParameter() + ((s.LastUParameter() - s.FirstUParameter()) * i) / 10
      const p = s.Value(u, (s.FirstVParameter() + s.LastVParameter()) / 2)
      expect(Math.abs(Math.hypot(p.X(), p.Y()) - 10)).toBeLessThan(1e-4)
    }
    // Longer by about the length asked, along the arc (5pi before).
    expect(R.measureArea(out.faces[0]) / 5).toBeCloseTo(5 * Math.PI + 3, 0)
  })

  it('refuses a trimmed surface', () => {
    const disc = planarFace({ type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 3 })!
    expect(() => extendSurface(disc, v(3, 0), 1)).toThrow(/untrimmed/)
  })
})
