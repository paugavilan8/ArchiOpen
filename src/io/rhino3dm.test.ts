import { Matrix4, Vector3 } from 'three'
import type { RhinoModule } from 'rhino3dm'
import rhino3dm from 'rhino3dm/rhino3dm.module.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { length } from '../core/curves'
import type { Layer } from '../core/document'
import { AnnotationGeometry, AnyCurve, BlockDefinition, BrepGeometry, domain, Geometry, InstanceGeometry, isCurve, pointAt, wireframe } from '../core/geometry'
import { clampedKnots } from '../math/nurbs'
import { describeSkipped, readRhinoFile, RhinoExportReport, writeRhinoFile } from './rhino3dm'
// Two texts from the rhino3dm test models (MIT), one of them on a tilted plane, as base64.
import textFile from './fixtures/rhino-text.3dm.b64?raw'

let rhino: RhinoModule
beforeAll(async () => {
  rhino = await rhino3dm()
})

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/** Same shape: compare points spread along both curves. */
function expectSameCurve(a: Geometry, b: Geometry) {
  if (!isCurve(a) || !isCurve(b)) throw new Error('curves expected')
  expect(length(b)).toBeCloseTo(length(a), 6)
  const [a0, a1] = domain(a)
  const [b0, b1] = domain(b)
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    expect(pointAt(b, b0 + (b1 - b0) * f).distanceTo(pointAt(a, a0 + (a1 - a0) * f))).toBeLessThan(1e-6)
  }
}

describe('.3dm round trip', () => {
  const layers: Layer[] = [
    { id: 1, name: 'Default', color: '#000000', visible: true, locked: false },
    { id: 7, name: 'Walls', color: '#c0392b', visible: false, locked: true },
    { id: 9, name: 'Plans::Doors', color: '#1e5ac8', visible: true, locked: false },
  ]
  const geometries: AnyCurve[] = [
    { type: 'polyline', points: [v(0, 0), v(10, 0)], closed: false },
    { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 5), v(0, 5)], closed: true },
    { type: 'circle', center: v(1, 2, 3), xaxis: v(0, 1), yaxis: v(-1, 0), radius: 4 },
    { type: 'arc', center: v(0, 0), xaxis: v(Math.SQRT1_2, Math.SQRT1_2), yaxis: v(-Math.SQRT1_2, Math.SQRT1_2), radius: 2, angle: 2 },
    { type: 'curve', degree: 3, points: [v(0, 0), v(2, 4), v(5, -1), v(8, 3), v(10, 0)], knots: clampedKnots(5, 3) },
    {
      type: 'polycurve',
      segments: [
        { type: 'polyline', points: [v(0, 0), v(10, 0)], closed: false },
        { type: 'arc', center: v(10, 5), xaxis: v(0, -1), yaxis: v(1, 0), radius: 5, angle: Math.PI },
      ],
    },
  ]

  it('keeps every kind of curve, its layer and the units', () => {
    const bytes = writeRhinoFile(rhino, {
      units: 'Meters',
      layers,
      objects: geometries.map((geometry, i) => ({ layerId: i === 2 ? 7 : 1, geometry })),
    })
    const result = readRhinoFile(rhino, bytes)
    expect(result.units).toBe('Meters')
    // The nested layer brings back its parent, created first.
    expect(result.layers.map((l) => l.name)).toEqual(['Default', 'Walls', 'Plans', 'Plans::Doors'])
    expect(result.layers[3].color).toBe('#1e5ac8')
    expect(result.layers[1]).toMatchObject({ color: '#c0392b', visible: false, locked: true })
    expect(result.objects.map((o) => o.geometry.type)).toEqual(geometries.map((g) => g.type))
    expect(result.objects[2].layer).toBe(1)
    result.objects.forEach((o, i) => expectSameCurve(geometries[i], o.geometry))
    expect(result.skipped.size).toBe(0)
  })
})

describe('exporting surfaces and solids', () => {
  it('writes them as meshes of their display triangles', () => {
    const square: BrepGeometry = {
      type: 'brep',
      brep: '',
      matrix: null,
      kind: 'surface',
      faces: 1,
      display: { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], triangles: [0, 1, 2, 0, 2, 3], edges: [] },
    }
    const bytes = writeRhinoFile(rhino, { units: 'Millimeters', layers: [{ id: 1, name: 'Default', color: '#000000', visible: true, locked: false }], objects: [{ layerId: 1, geometry: square }] })
    const file = rhino.File3dm.fromByteArray(bytes)
    const mesh = file.objects().get(0).geometry() as InstanceType<RhinoModule['Mesh']>
    expect(mesh).toBeInstanceOf(rhino.Mesh)
    expect(mesh.vertices().count).toBe(4)
    expect(mesh.faces().count).toBe(2)
    file.destroy()
  })
})

describe('reading Rhino content', () => {
  it('recognizes rational circles and arcs, flattens polycurves and keeps surfaces for the kernel', () => {
    const file = new rhino.File3dm()
    const parent = new rhino.Layer()
    parent.name = 'Plans'
    file.layers().add(parent)
    const child = new rhino.Layer()
    child.name = 'Doors'
    child.parentLayerId = file.layers().get(0).id
    const childIndex = file.layers().add(child)
    const attributes = new rhino.ObjectAttributes()
    attributes.layerIndex = childIndex

    file.objects().add(rhino.NurbsCurve.createFromCircle(new rhino.Circle([5, 5, 0], 2)), attributes)
    file.objects().add(rhino.NurbsCurve.createFromArc(new rhino.Arc([0, 0, 0], 3, Math.PI / 2)), attributes)
    const poly = new rhino.PolyCurve()
    poly.appendSegment(new rhino.LineCurve([0, 0, 0], [4, 0, 0]))
    poly.appendSegment(new rhino.LineCurve([4, 0, 0], [4, 4, 0]))
    file.objects().add(poly, attributes)
    file.objects().addSphere(new rhino.Sphere([0, 0, 0], 1), attributes)

    const result = readRhinoFile(rhino, file.toByteArray())
    file.destroy()
    expect(result.layers[1].name).toBe('Plans::Doors')
    const [circle, arc, polyline] = result.objects.map((o) => o.geometry as AnyCurve)
    expect(circle).toMatchObject({ type: 'circle', radius: 2 })
    expect(arc.type).toBe('arc')
    expect(length(arc)).toBeCloseTo((3 * Math.PI) / 2, 6)
    expect(polyline).toMatchObject({ type: 'polyline' })
    expect(polyline.type === 'polyline' && polyline.points.length).toBe(3)
    expect(result.objects.every((o) => o.layer === 1)).toBe(true)
    // The sphere is kept as polysurface data for the kernel, not skipped.
    expect(result.breps).toHaveLength(1)
    expect(result.breps[0].data.faces).toHaveLength(1)
    expect(describeSkipped(result.skipped)).toBe('')
  })

  it('reads rational curves that are not arcs exactly', () => {
    const file = new rhino.File3dm()
    // A rational circle of radius 4 squashed to half height in Y is an ellipse with semi-axes 4 and 2.
    const ellipse = rhino.NurbsCurve.createFromCircle(new rhino.Circle([0, 0, 0], 4))
    for (let i = 0; i < ellipse.points().count; i++) {
      const [x, y, z, w] = ellipse.points().get(i)
      ellipse.points().set(i, [x, y / 2, z, w])
    }
    file.objects().add(ellipse, new rhino.ObjectAttributes())
    const [obj] = readRhinoFile(rhino, file.toByteArray()).objects
    file.destroy()
    const curve = obj.geometry as AnyCurve
    expect(curve.type === 'curve' && curve.weights?.length).toBe(9)
    const [t0, t1] = domain(curve)
    for (const f of [0.1, 0.3, 0.6, 0.9]) {
      const p = pointAt(curve, t0 + (t1 - t0) * f)
      expect((p.x * p.x) / 16 + (p.y * p.y) / 4).toBeCloseTo(1, 10)
    }
  })

  it('writes rational curves with their weights', async () => {
    const { ellipse } = await import('../core/curveTools')
    const e = ellipse(v(1, 2), v(1, 0), v(0, 1), 4, 2)
    const bytes = writeRhinoFile(rhino, { units: 'Millimeters', layers: [{ id: 1, name: 'Default', color: '#000000', visible: true, locked: false }], objects: [{ layerId: 1, geometry: e }] })
    const [obj] = readRhinoFile(rhino, bytes).objects
    expectSameCurve(e, obj.geometry)
    expect(obj.geometry.type === 'curve' && obj.geometry.weights).toEqual(e.weights)
  })

  it('rejects files that are not .3dm', () => {
    expect(() => readRhinoFile(rhino, new TextEncoder().encode('not a model'))).toThrow()
  })
})

describe('.3dm blocks', () => {
  const layers: Layer[] = [
    { id: 1, name: 'Default', color: '#000000', visible: true, locked: false },
    { id: 2, name: 'Furniture', color: '#8e44ad', visible: true, locked: false },
  ]
  // A leg (nested block) and a chair made of a seat outline and four legs.
  const leg: BlockDefinition = { name: 'Leg', objects: [{ layerId: 2, geometry: { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 0.2 } }] }
  const at = (x: number, y: number): InstanceGeometry => ({ type: 'instance', definition: leg, matrix: new Matrix4().makeTranslation(x, y, 0).toArray() })
  const chair: BlockDefinition = {
    name: 'Chair',
    objects: [
      { layerId: 1, geometry: { type: 'polyline', points: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)], closed: true } },
      ...[at(0.5, 0.5), at(3.5, 0.5), at(3.5, 3.5), at(0.5, 3.5)].map((geometry) => ({ layerId: 2, geometry })),
    ],
  }
  const placed = new Matrix4().makeTranslation(100, 50, 0).multiply(new Matrix4().makeRotationZ(Math.PI / 6)).multiply(new Matrix4().makeScale(2, 2, 2))
  const instances: InstanceGeometry[] = [
    { type: 'instance', definition: chair, matrix: new Matrix4().makeTranslation(10, 0, 0).toArray() },
    { type: 'instance', definition: chair, matrix: placed.toArray() },
  ]

  it('are written as blocks and read back as blocks, nested ones included', () => {
    const report: RhinoExportReport = { exact: 0, meshed: 0 }
    const bytes = writeRhinoFile(rhino, { units: 'Meters', layers, objects: instances.map((geometry) => ({ layerId: 2, geometry })) }, report)
    expect(report.blocks).toBe(2)
    const file = rhino.File3dm.fromByteArray(bytes)!
    // Two definitions in the file, each written once, and two instances in the model.
    expect(file.instanceDefinitions().count).toBe(2)
    file.destroy()

    const result = readRhinoFile(rhino, bytes)
    expect(result.objects).toHaveLength(2)
    const [a, b] = result.objects.map((o) => o.geometry as InstanceGeometry)
    expect(a.type).toBe('instance')
    // Both copies share one definition, as in the file.
    expect(a.definition).toBe(b.definition)
    expect(a.definition.name).toBe('Chair')
    expect(a.definition.objects).toHaveLength(5)
    const legs = a.definition.objects.filter((o) => o.geometry.type === 'instance')
    expect(legs).toHaveLength(4)
    expect((legs[0].geometry as InstanceGeometry).definition.name).toBe('Leg')
    // Layers of the objects inside blocks are kept.
    expect(result.layers[legs[0].layerId].name).toBe('Furniture')
    // Placement (move, turn and scale) is kept exactly.
    b.matrix.forEach((x, i) => expect(x).toBeCloseTo(placed.elements[i], 9))
    expect(result.skipped.size).toBe(0)
  })

  it('keep their contents in the definition: what it draws matches', () => {
    const bytes = writeRhinoFile(rhino, { units: 'Meters', layers, objects: [{ layerId: 1, geometry: instances[1] }] })
    const back = readRhinoFile(rhino, bytes).objects[0].geometry
    const before = wireframe(instances[1]).flat()
    const after = wireframe(back).flat()
    expect(after).toHaveLength(before.length)
    after.forEach((p, i) => expect(p.distanceTo(before[i])).toBeLessThan(1e-9))
  })
})

describe('.3dm texts', () => {
  it('are read as texts, with their plane and their style height', () => {
    const bytes = Uint8Array.from(atob(textFile.replace(/\s/g, '')), (c) => c.charCodeAt(0))
    const result = readRhinoFile(rhino, bytes)
    const texts = result.objects.map((o) => o.geometry as AnnotationGeometry)
    expect(texts.map((t) => t.text)).toEqual(['Hello World!', 'Hello Cruel World!'])
    expect(texts.every((t) => t.type === 'annotation' && t.kind === 'text')).toBe(true)
    expect(texts[0].height).toBe(10)
    expect(texts[0].points[0].toArray()).toEqual([0, 0, 0])
    // The second stands on a tilted plane.
    expect(texts[1].xaxis.length()).toBeCloseTo(1)
    expect(texts[1].xaxis.dot(texts[1].yaxis)).toBeCloseTo(0)
    expect(texts[1].xaxis.z).toBeGreaterThan(0.5)
    expect(result.skipped.size).toBe(0)
  })
})
