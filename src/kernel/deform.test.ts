import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { deformBy, deformShape } from './deform'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const volumeOf = (s: R.AnyShape) => R.measureVolume(s as R.Shape3D)
const scaleX = (f: number) => (p: Vector3) => new Vector3(p.x * f, p.y, p.z)

describe('deformShape', () => {
  it('scales a box along one axis exactly, keeping it a solid', () => {
    const box = R.makeBaseBox(10, 20, 30)
    const out = deformShape(box, scaleX(2))
    expect((out as R.Shape3D).solids?.length ?? 0).toBe(1)
    expect(volumeOf(out)).toBeCloseTo(2 * 10 * 20 * 30, 3)
    expect(out.boundingBox.width).toBeCloseTo(20, 6)
  })

  it('scales a cylinder into an elliptic cylinder', () => {
    const cyl = R.makeCylinder(5, 10)
    const out = deformShape(cyl, scaleX(2))
    // An ellipse of semi-axes 10 and 5: twice the circle's area.
    expect(volumeOf(out) / (Math.PI * 25 * 10 * 2)).toBeCloseTo(1, 2)
    expect(out.boundingBox.width).toBeCloseTo(20, 2)
  })

  it('keeps holes', () => {
    const box = R.makeBaseBox(20, 20, 10).cut(R.makeCylinder(3, 30).translate([0, 0, -10]))
    const out = deformShape(box, (p) => new Vector3(p.x, p.y * 3, p.z))
    expect((out as R.Shape3D).solids?.length ?? 0).toBe(1)
    expect(volumeOf(out) / (3 * volumeOf(box))).toBeCloseTo(1, 2)
  })

  it('follows a non-affine mapping closely when refined', () => {
    const box = R.makeBaseBox(10, 10, 40)
    // A taper: full size at the bottom, half at the top.
    const taper = (p: Vector3) => {
      const f = 1 - (0.5 * p.z) / 40
      return new Vector3(p.x * f, p.y * f, p.z)
    }
    const out = deformShape(box, taper, { refine: 4 })
    // A frustum of square sections 10 and 5, height 40.
    const exact = (40 / 3) * (100 + 25 + 50)
    expect(volumeOf(out) / exact).toBeCloseTo(1, 2)
  })

  it('twists, tapers and bends solids (Twist, Taper, Bend)', () => {
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z)
    const bar = () => R.makeBaseBox(4, 4, 40)
    const twisted = deformBy(bar(), { kind: 'twist', start: v(0, 0, 0), end: v(0, 0, 40), angle: Math.PI / 2, infinite: false })
    expect((twisted as R.Shape3D).solids?.length ?? 0).toBe(1)
    expect(volumeOf(twisted) / 640).toBeCloseTo(1, 2)
    // The top square turned a quarter: still 4 wide, now along y as x.
    const tapered = deformBy(bar(), { kind: 'taper', start: v(0, 0, 0), end: v(0, 0, 40), startScale: 1, endScale: 0.5, infinite: false })
    expect(volumeOf(tapered) / ((40 / 3) * (16 + 4 + 8))).toBeCloseTo(1, 2)
    const bent = deformBy(bar(), { kind: 'bend', start: v(0, 0, 0), end: v(0, 0, 40), toward: v(1, 0, 0), angle: Math.PI / 2 })
    expect(volumeOf(bent) / 640).toBeCloseTo(1, 2)
    expect(bent.boundingBox.bounds[1][0]).toBeGreaterThan(20)
  })
})
