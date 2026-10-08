import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { box, cylinder, toBrep } from './brep'
import { readStep, writeStep } from './step'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const volume = (s: R.AnyShape) => R.measureShapeVolumeProperties(s as R.Shape3D).volume
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('STEP', () => {
  let wall: BrepGeometry
  let column: BrepGeometry
  beforeAll(() => {
    wall = toBrep(box(v(0, 0), v(8, 0), v(0, 0.3), v(0, 0, 3)))
    column = toBrep(cylinder(v(4, 3), 0.25, 3, v(0, 0, 1)))
  })
  const axis: AnyCurve = { type: 'polyline', points: [v(0, -1), v(8, -1)], closed: false }

  it('writes solids and curves with names, colors and units', async () => {
    const step = text(await writeStep([
      { geometry: wall, name: 'Walls', color: '#c0392b' },
      { geometry: column, name: 'Structure', color: '#1e5ac8' },
      { geometry: axis, name: 'Axes', color: '#000000' },
    ], 'Meters'))
    expect(step).toMatch(/^ISO-10303-21;/)
    expect(step).toContain('Managed model based 3d engineering') // AP242
    expect(step).toContain("'Walls'")
    expect(step).toContain("'Structure'")
    expect(step).toContain('COLOUR_RGB')
    expect(step).toContain('SI_UNIT($,.METRE.)')
    expect(step).toContain('CYLINDRICAL_SURFACE') // exact geometry, not a mesh
  })

  it('reads back each solid separately, in the model units', async () => {
    const bytes = await writeStep([
      { geometry: wall, name: 'Walls', color: '#c0392b' },
      { geometry: column, name: 'Structure', color: '#1e5ac8' },
    ], 'Meters')
    const shapes = await readStep(bytes, 'Meters')
    expect(shapes).toHaveLength(2)
    const volumes = shapes.map(volume).sort((a, b) => a - b)
    expect(volumes[0]).toBeCloseTo(Math.PI * 0.25 * 0.25 * 3, 6)
    expect(volumes[1]).toBeCloseTo(8 * 0.3 * 3, 6)
  })

  it('converts units when reading into a model in other units', async () => {
    const bytes = await writeStep([{ geometry: wall, name: 'Walls', color: '#c0392b' }], 'Meters')
    // A model in millimeters gets the wall 8000 mm long, whatever unit the last export used.
    await writeStep([{ geometry: column, name: 'x', color: '#000000' }], 'Inches')
    const [shape] = await readStep(bytes, 'Millimeters')
    expect(shape.boundingBox.width).toBeCloseTo(8000, 3)
  })

  it('goes through millimeters for units STEP has no code for', async () => {
    const bytes = await writeStep([{ geometry: wall, name: 'Walls', color: '#c0392b' }], 'Decimeters')
    expect(text(bytes)).toContain('SI_UNIT(.MILLI.,.METRE.)')
    // 8 dm = 800 mm in the file, and 8 dm again when read into a model in decimeters.
    const [shape] = await readStep(bytes, 'Decimeters')
    expect(shape.boundingBox.width).toBeCloseTo(8, 6)
    const [inMm] = await readStep(bytes, 'Millimeters')
    expect(inMm.boundingBox.width).toBeCloseTo(800, 4)
  })

  it('keeps faces that are not part of a solid', async () => {
    const square = R.makeFace(R.assembleWire([R.makeLine([0, 0, 5], [1, 0, 5]), R.makeLine([1, 0, 5], [1, 1, 5]), R.makeLine([1, 1, 5], [0, 1, 5]), R.makeLine([0, 1, 5], [0, 0, 5])]))
    const bytes = await writeStep([
      { geometry: wall, name: 'Walls', color: '#c0392b' },
      { geometry: toBrep(square), name: 'Sheet', color: '#00ff00' },
    ], 'Meters')
    const shapes = await readStep(bytes, 'Meters')
    expect(shapes).toHaveLength(2)
    expect(shapes.reduce((n, s) => n + s.faces.length, 0)).toBe(7)
  })
})
