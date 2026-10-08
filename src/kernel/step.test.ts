import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { length } from '../core/curves'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { clampedKnots } from '../math/nurbs'
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
    const { shapes } = await readStep(bytes, 'Meters')
    expect(shapes).toHaveLength(2)
    const volumes = shapes.map(volume).sort((a, b) => a - b)
    expect(volumes[0]).toBeCloseTo(Math.PI * 0.25 * 0.25 * 3, 6)
    expect(volumes[1]).toBeCloseTo(8 * 0.3 * 3, 6)
  })

  it('converts units when reading into a model in other units', async () => {
    const bytes = await writeStep([{ geometry: wall, name: 'Walls', color: '#c0392b' }], 'Meters')
    // A model in millimeters gets the wall 8000 mm long, whatever unit the last export used.
    await writeStep([{ geometry: column, name: 'x', color: '#000000' }], 'Inches')
    const [shape] = (await readStep(bytes, 'Millimeters')).shapes
    expect(shape.boundingBox.width).toBeCloseTo(8000, 3)
  })

  it('goes through millimeters for units STEP has no code for', async () => {
    const bytes = await writeStep([{ geometry: wall, name: 'Walls', color: '#c0392b' }], 'Decimeters')
    expect(text(bytes)).toContain('SI_UNIT(.MILLI.,.METRE.)')
    // 8 dm = 800 mm in the file, and 8 dm again when read into a model in decimeters.
    const [shape] = (await readStep(bytes, 'Decimeters')).shapes
    expect(shape.boundingBox.width).toBeCloseTo(8, 6)
    const [inMm] = (await readStep(bytes, 'Millimeters')).shapes
    expect(inMm.boundingBox.width).toBeCloseTo(800, 4)
  })

  it('keeps faces that are not part of a solid', async () => {
    const square = R.makeFace(R.assembleWire([R.makeLine([0, 0, 5], [1, 0, 5]), R.makeLine([1, 0, 5], [1, 1, 5]), R.makeLine([1, 1, 5], [0, 1, 5]), R.makeLine([0, 1, 5], [0, 0, 5])]))
    const bytes = await writeStep([
      { geometry: wall, name: 'Walls', color: '#c0392b' },
      { geometry: toBrep(square), name: 'Sheet', color: '#00ff00' },
    ], 'Meters')
    const { shapes } = await readStep(bytes, 'Meters')
    expect(shapes).toHaveLength(2)
    expect(shapes.reduce((n, s) => n + s.faces.length, 0)).toBe(7)
  })

  it('reads loose curves back: lines, circles and arcs exactly, splines closely', async () => {
    const circle: AnyCurve = { type: 'circle', center: v(1, 2), xaxis: v(1, 0), yaxis: v(0, 1), radius: 3 }
    const arc: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2, angle: Math.PI / 2 }
    const spline: AnyCurve = { type: 'curve', degree: 3, points: [v(0, 5), v(2, 8), v(5, 3), v(8, 6)], knots: clampedKnots(4, 3) }
    const outline: AnyCurve = { type: 'polyline', points: [v(10, 0), v(14, 0), v(14, 3), v(10, 3)], closed: true }
    const bytes = await writeStep([axis, circle, arc, spline, outline].map((geometry) => ({ geometry, name: 'Curves', color: '#000000' })), 'Meters')
    const { shapes, curves } = await readStep(bytes, 'Meters')
    expect(shapes).toHaveLength(0)
    const byType = (t: string) => curves.filter((c) => c.type === t)
    expect(byType('circle')).toHaveLength(1)
    expect((byType('circle')[0] as Extract<AnyCurve, { type: 'circle' }>).radius).toBeCloseTo(3, 9)
    expect(byType('arc')).toHaveLength(1)
    expect(length(byType('arc')[0])).toBeCloseTo(Math.PI, 9)
    expect(byType('curve')).toHaveLength(1)
    // Splines are fitted through points on them, so they match closely rather than exactly.
    expect(Math.abs(length(byType('curve')[0]) - length(spline)) / length(spline)).toBeLessThan(1e-3)
    // The line and the closed outline come back as polylines; the outline's four edges are joined again.
    const polylines = byType('polyline') as Extract<AnyCurve, { type: 'polyline' }>[]
    expect(polylines.map((p) => p.points.length).sort()).toEqual([2, 4])
    expect(polylines.find((p) => p.points.length === 4)!.closed).toBe(true)
  })
})
