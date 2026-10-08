import type { RhinoModule } from 'rhino3dm'
import rhino3dm from 'rhino3dm/rhino3dm.module.js'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { readRhinoFile } from '../io/rhino3dm'
import { toBrep } from './brep'
import { shapeFromRhino } from './fromRhino'

let rhino: RhinoModule
beforeAll(async () => {
  rhino = await rhino3dm()
  R.setOC(await opencascade())
}, 60_000)

// Rebuilding and finely meshing curved solids takes a few seconds.
const SLOW = 30_000

/** Writes objects to a .3dm in memory, reads it back and rebuilds the first polysurface. */
function roundTrip(add: (file: InstanceType<RhinoModule['File3dm']>) => void): R.AnyShape {
  const file = new rhino.File3dm()
  add(file)
  const model = readRhinoFile(rhino, file.toByteArray())
  file.destroy()
  expect(model.breps).toHaveLength(1)
  return shapeFromRhino(model.breps[0].data, model.tolerance)
}

// Rhino surfaces are rational NURBS, on which OCCT's default area and volume integration is only
// approximate; a fine mesh measures the rebuilt geometry more reliably.
function meshOf(s: R.AnyShape) {
  return s.mesh({ tolerance: 0.001, angularTolerance: 0.05 })
}

function volume(s: R.AnyShape): number {
  const { vertices: v, triangles: t } = meshOf(s)
  let sum = 0
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3]
    sum += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])
  }
  return Math.abs(sum / 6)
}

function area(s: R.AnyShape): number {
  const { vertices: v, triangles: t } = meshOf(s)
  let sum = 0
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3]
    const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]]
    const w = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]]
    sum += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2
  }
  return sum
}

/** Every mesh vertex satisfies the given surface equation, within `tolerance`. */
function expectOnSurface(s: R.AnyShape, residual: (x: number, y: number, z: number) => number, tolerance = 1e-6) {
  const { vertices: v } = meshOf(s)
  for (let i = 0; i < v.length; i += 3) expect(Math.abs(residual(v[i], v[i + 1], v[i + 2]))).toBeLessThan(tolerance)
}

/** Relative closeness, for measured values. */
function expectNear(actual: number, expected: number, relative = 1e-3) {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(relative)
}
const attributes = () => new rhino.ObjectAttributes()

describe('rebuilding Rhino polysurfaces', () => {
  it('rebuilds a sphere (one rational face with a seam and two poles) as a solid', { timeout: SLOW }, () => {
    const shape = roundTrip((f) => f.objects().add(rhino.Brep.createFromSphere(new rhino.Sphere([1, 2, 3], 2)), attributes()))
    expect(toBrep(shape).kind).toBe('solid')
    expectOnSurface(shape, (x, y, z) => Math.hypot(x - 1, y - 2, z - 3) - 2)
    expectNear(volume(shape), (4 / 3) * Math.PI * 8)
  })

  it('rebuilds a capped extrusion (Rhino boxes are extrusions) as a solid', { timeout: SLOW }, () => {
    const profile = new rhino.PolylineCurve([[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0], [0, 0, 0]])
    const shape = roundTrip((f) => f.objects().add(rhino.Extrusion.create(profile, 2, true), attributes()))
    const brep = toBrep(shape)
    expect(brep.kind).toBe('solid')
    expect(brep.faces).toBe(6)
    expectNear(volume(shape), 24, 1e-9)
  })

  it('rebuilds a capped cylinder extrusion with exact circular edges', { timeout: SLOW }, () => {
    const circle = rhino.ArcCurve.createFromCircle(new rhino.Circle([0, 0, 0], 1.5))
    const shape = roundTrip((f) => f.objects().add(rhino.Extrusion.create(circle, 4, true), attributes()))
    expect(toBrep(shape).kind).toBe('solid')
    // Points are on the round side or on one of the two caps.
    expectOnSurface(shape, (x, y, z) => Math.min(Math.abs(Math.hypot(x, y) - 1.5), Math.abs(z), Math.abs(z - 4)))
    expectNear(volume(shape), Math.PI * 1.5 * 1.5 * 4)
  })

  it('trims a planar surface by its boundary curve', () => {
    const circle = rhino.ArcCurve.createFromCircle(new rhino.Circle([0, 0, 0], 3))
    const shape = roundTrip((f) => f.objects().add(rhino.Brep.createTrimmedPlane(rhino.Plane.worldXY(), circle), attributes()))
    const brep = toBrep(shape)
    expect(brep.kind).toBe('surface')
    // A disk, not the square the plane was cut from.
    expectNear(area(shape), Math.PI * 9)
    expectOnSurface(shape, (x, y) => Math.max(0, Math.hypot(x, y) - 3))
    // The face is oriented so that its boundary encloses it (a positive area).
    expect(R.measureArea(shape as R.Face)).toBeGreaterThan(0)
  })

  it('keeps an open extrusion as a surface', () => {
    const line = new rhino.LineCurve([0, 0, 0], [5, 0, 0])
    const shape = roundTrip((f) => f.objects().add(rhino.Extrusion.create(line, 2, false), attributes()))
    expect(toBrep(shape).kind).toBe('surface')
    expectNear(area(shape), 10, 1e-9)
  })
})
