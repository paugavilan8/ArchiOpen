import { Matrix4, Vector3 } from 'three'
import type { RhinoModule } from 'rhino3dm'
import rhino3dm from 'rhino3dm/rhino3dm.module.js'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnyCurve } from '../core/geometry'
import { ellipse } from '../core/curveTools'
import { clampedKnots } from '../math/nurbs'
import { writeBrep } from '../io/openNurbs'
import { readRhinoFile, writeRhinoFile } from '../io/rhino3dm'
import { boolean, box, cylinder, extrudeCurve, filletEdges, loftCurves, revolveCurve, sphere, sweep, toBrep } from './brep'
import { shapeFromRhino } from './fromRhino'
import { shapeArea, shapeVolume } from './measure'
import { brepFromShape, exactRhinoBrep } from './toRhino'

let rhino: RhinoModule
let opennurbs = 0
beforeAll(async () => {
  rhino = await rhino3dm()
  R.setOC(await opencascade())
  opennurbs = (new rhino.Point([0, 0, 0]).encode() as unknown as { opennurbs: number }).opennurbs
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const square: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)], closed: true }
const circle: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 }
const wave: AnyCurve = { type: 'curve', degree: 3, knots: clampedKnots(5, 3), points: [v(0, 0), v(1, 2), v(2, -1), v(3, 2), v(4, 0)] }

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

type Brep = InstanceType<RhinoModule['Brep']>

function decode(shape: R.AnyShape): Brep {
  const bytes = writeBrep(brepFromShape(shape.wrapped))
  return rhino.CommonObject.decode({ version: 10000, archive3dm: 60, opennurbs, data: toBase64(bytes) } as never) as unknown as Brep
}

/** Each face's surface gives the same points for the same parameters as the kernel's. */
function expectSameSurfaces(shape: R.AnyShape, brep: Brep) {
  const k = R.getOC()
  const faces = shape.faces
  expect(brep.faces().count).toBe(faces.length)
  faces.forEach((face, i) => {
    const f = brep.faces().get(i)
    const surface = k.BRep_Tool.Surface(face.wrapped)
    for (const [a, b] of [
      [0.3, 0.6],
      [0.5, 0.5],
      [0.8, 0.2],
    ]) {
      const [u0, u1] = f.domain(0)
      const [w0, w1] = f.domain(1)
      const [u, w] = [u0 + (u1 - u0) * a, w0 + (w1 - w0) * b]
      const p = surface.Value(u, w)
      const q = f.pointAt(u, w)
      expect(Math.hypot(p.X() - q[0], p.Y() - q[1], p.Z() - q[2])).toBeLessThan(1e-9)
    }
  })
}

/** Volume and area from a fine mesh: OCCT's integration is approximate on rational NURBS. */
function meshMeasures(s: R.AnyShape): { volume: number; area: number } {
  const { vertices: p, triangles: t } = s.mesh({ tolerance: 0.001, angularTolerance: 0.05 })
  let volume = 0
  let area = 0
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => new Vector3().fromArray(p, 3 * t[i + j]))
    volume += a.dot(b.clone().cross(c)) / 6
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
  }
  return { volume: Math.abs(volume), area }
}

const cases: [string, () => R.AnyShape][] = [
  ['box', () => box(v(0, 0, 0), v(2, 0, 0), v(0, 3, 0), v(0, 0, 4))],
  ['cylinder', () => cylinder(v(1, 2, 3), 2, 5, v(0, 0, 1))],
  ['sphere', () => sphere(v(1, 0, 0), 3)],
  ['extruded curve', () => extrudeCurve(wave, v(0, 0, 3), false)],
  ['extruded ellipse', () => extrudeCurve(ellipse(v(0, 0), v(1, 0), v(0, 1), 3, 2), v(0, 0, 2), true)],
  ['revolved curve', () => revolveCurve(wave, v(0, -1), v(1, 0), 2 * Math.PI)],
  ['torus', () => revolveCurve({ ...circle, center: v(5, 0), xaxis: v(1, 0), yaxis: v(0, 0, 1), radius: 1 }, v(0, 0), v(0, 0, 1), 2 * Math.PI)],
  ['cone', () => revolveCurve({ type: 'polyline', points: [v(0, 0), v(3, 0, 0), v(1, 0, 4), v(0, 0, 4)], closed: true }, v(0, 0), v(0, 0, 1), 2 * Math.PI)],
  [
    'loft',
    () =>
      loftCurves([
        circle,
        { ...circle, center: v(0, 0, 3), radius: 1 },
        { ...square, points: (square as { points: Vector3[] }).points.map((p) => p.clone().add(v(-2, -2, 6))) },
      ]),
  ],
  ['box with a hole', () => boolean('difference', box(v(-4, -4, 0), v(8, 0, 0), v(0, 8, 0), v(0, 0, 2)), [cylinder(v(0, 0, -1), 1.5, 4, v(0, 0, 1))])],
  ['sphere cut by a box', () => boolean('difference', sphere(v(0, 0, 0), 3), [box(v(0, 0, 0), v(5, 0, 0), v(0, 5, 0), v(0, 0, 5))])],
  ['filleted box', () => filletEdges(box(v(0, 0, 0), v(4, 0, 0), v(0, 4, 0), v(0, 0, 4)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.5)],
  ['mirrored revolve', () => (revolveCurve(wave, v(0, -1), v(1, 0), Math.PI) as R.Shape3D).mirror('YZ', [1, 0, 0])],
  ['moved cylinder', () => (cylinder(v(0, 0, 0), 1, 2, v(1, 1, 0)) as R.Shape3D).translate([3, -2, 7]).rotate(30, [0, 0, 0], [0, 1, 1])],
  ['open surface', () => extrudeCurve({ type: 'arc', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 3, angle: 2 } as AnyCurve, v(0, 1, 2), false)],
  ['sweep', () => sweep({ ...circle, center: v(0, 0), radius: 0.5, xaxis: v(0, 1), yaxis: v(0, 0, 1) }, wave)],
]

describe('exact polysurfaces for Rhino', () => {
  for (const [name, make] of cases) {
    it(`writes a valid ${name} with the same surfaces`, () => {
      const shape = make()
      const brep = decode(shape)
      const [ok, log] = (brep as unknown as { isValidWithLog: [boolean, string] }).isValidWithLog
      if (!ok) console.log(name, log)
      expect(ok).toBe(true)
      expectSameSurfaces(shape, brep)
    })
  }

  it('reads back with the same volume and area', () => {
    for (const [name, make] of cases.filter(([n]) => ['box with a hole', 'torus', 'filleted box', 'cone'].includes(n))) {
      const shape = make()
      const file = new rhino.File3dm()
      file.objects().add(decode(shape), null as never)
      const model = readRhinoFile(rhino, file.toByteArray())
      file.destroy()
      const back = shapeFromRhino(model.breps[0].data, model.tolerance)
      const measured = meshMeasures(back)
      expect(Math.abs(measured.volume / shapeVolume(shape).value - 1), name).toBeLessThan(1e-3)
      expect(Math.abs(measured.area / shapeArea(shape).value - 1), name).toBeLessThan(1e-3)
    }
  }, 60_000)

  it('exports surfaces and solids exactly in .3dm files, and the rest as meshes', () => {
    const layers = [{ id: 1, name: 'Default', color: '#000000', visible: true, locked: false }]
    const solid = toBrep(boolean('difference', box(v(-4, -4, 0), v(8, 0, 0), v(0, 8, 0), v(0, 0, 2)), [cylinder(v(0, 0, -1), 1.5, 4, v(0, 0, 1))]))
    // Stretched unevenly, a sphere is no longer one the kernel can describe exactly.
    const egg = { ...toBrep(sphere(v(10, 0, 0), 1)), matrix: new Matrix4().makeScale(1, 1, 2).toArray() }
    expect(exactRhinoBrep(egg)).toBeNull()
    const report = { exact: 0, meshed: 0 }
    const bytes = writeRhinoFile(
      rhino,
      { units: 'Millimeters', layers, objects: [solid, egg].map((geometry) => ({ layerId: 1, geometry })), exactBrep: exactRhinoBrep },
      report,
    )
    expect(report).toEqual({ exact: 1, meshed: 1 })
    const model = readRhinoFile(rhino, bytes)
    expect(model.breps).toHaveLength(1)
    expect(model.breps[0].data.faces).toHaveLength(7)
    expect(model.objects.filter((o) => o.geometry.type === 'mesh')).toHaveLength(1)
  })
})
