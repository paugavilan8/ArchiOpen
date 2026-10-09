import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { length } from '../core/curves'
import type { AnnotationGeometry, AnyCurve, Geometry, HatchGeometry } from '../core/geometry'
import { measure } from '../core/annotation'
import { hatchTriangles } from '../core/hatch'
import { writeDxf } from './dxf'
import { mtextPlain, readDxf } from './dxfRead'
import sample from './fixtures/ezdxf-sample.dxf?raw'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const fixture = new TextEncoder().encode(sample)
const model = readDxf(fixture, 'Meters')
const layerName = (i: number) => model.layers[i].name
const of = (type: string) => model.objects.filter((o) => o.geometry.type === type)
const annotations = (kind: string) => of('annotation').map((o) => o.geometry as AnnotationGeometry).filter((g) => g.kind === kind)

function area(flat: number[]): number {
  let sum = 0
  for (let i = 0; i < flat.length; i += 9) sum += Math.abs((flat[i + 3] - flat[i]) * (flat[i + 7] - flat[i + 1]) - (flat[i + 6] - flat[i]) * (flat[i + 4] - flat[i + 1])) / 2
  return sum
}

describe('reading a DXF 2018 file written by ezdxf', () => {
  it('reads units and layers with their color, state, linetype and lineweight', () => {
    expect(model.units).toBe('Millimeters')
    const layer = (name: string) => model.layers.find((l) => l.name === name)!
    expect(layer('Muros')).toMatchObject({ color: '#ff0000', visible: true, locked: false, printWidth: 0.5 })
    expect(layer('Ejes')).toMatchObject({ color: '#0000ff', linetype: 'Center' })
    expect(layer('Oculto').visible).toBe(false)
    expect(layer('Bloqueado').locked).toBe(true)
    expect(layer('Fachada').color).toBe('#1f6fb5')
  })

  it('reads every model space entity, exploding blocks, and skips points and paper space', () => {
    // 2 lines, 1 polyline, 2 circles, 1 arc, 1 ellipse, 2 splines, 3 texts, 2 hatches, 5 dimensions,
    // 1 solid, 1 face; blocks: 2 + 6 × 2 + (2 + 1).
    expect(model.objects).toHaveLength(21 + 2 + 12 + 3)
    expect([...model.skipped.values()]).toEqual([1])
  })

  it('reads polylines with arcs (bulges) exactly', () => {
    const slot = model.objects.find((o) => o.geometry.type === 'polycurve')!.geometry as AnyCurve
    expect(length(slot)).toBeCloseTo(50 + Math.PI * 10 + 50 + 20, 6)
    expect(layerName(model.objects.find((o) => o.geometry === slot)!.layer)).toBe('Muros')
  })

  it('places circles from their object coordinate system', () => {
    const tilted = of('circle').map((o) => o.geometry).find((g) => g.type === 'circle' && g.radius === 3)
    expect(tilted && tilted.type === 'circle' && tilted.center.toArray()).toEqual([-10, 0, -5])
  })

  it('reads arcs, ellipses and splines', () => {
    const arc = of('arc')[0].geometry as AnyCurve
    expect(length(arc)).toBeCloseTo((Math.PI * 20) / 2, 6)
    const curves = of('curve').map((o) => o.geometry as AnyCurve)
    // The ellipse (a = 50, b = 25), about 242.2 around.
    expect(curves.some((c) => Math.abs(length(c) - 242.2) < 0.2)).toBe(true)
    // The clamped spline comes through exactly: same control points.
    expect(curves.some((c) => c.type === 'curve' && c.points.length === 4 && c.points[1].equals(v(30, 360)))).toBe(true)
  })

  it('reads texts with their codes and alignment, and multi-line text without formatting', () => {
    const texts = annotations('text')
    expect(texts.map((t) => t.text)).toEqual(['Planta baja', 'Ø20', 'Línea uno\nLínea dos'])
    expect(texts[0].points[0].toArray()).toEqual([0, -50, 0])
    expect(texts[0].height).toBe(5)
    // Centered on (100, -50): the text's lower left is half its width to the left and half its height down.
    expect(texts[1].points[0].y).toBeCloseTo(-50 - 1.25, 9)
    expect(texts[1].points[0].x).toBeLessThan(100)
  })

  it('turns dimensions into live dimensions with the same values', () => {
    const values = of('annotation')
      .map((o) => o.geometry as AnnotationGeometry)
      .filter((g) => g.kind !== 'text')
      .map((g) => `${g.kind}:${measure(g).toFixed(3)}`)
    expect(values).toEqual(['linear:100.000', 'linear:50.000', 'radius:25.000', 'diameter:50.000', 'angle:90.000'])
  })

  it('explodes block references with their scale, rotation, arrays and nesting', () => {
    const chairs = of('circle').filter((o) => (o.geometry as { radius: number }).radius !== 25 && (o.geometry as { radius: number }).radius !== 3)
    // 1 scaled ×2 + 6 in the array + 1 nested in the table.
    expect(chairs).toHaveLength(8)
    const scaled = chairs.find((o) => (o.geometry as { radius: number }).radius === 4)!.geometry as { center: Vector3 }
    expect(scaled.center.x).toBeCloseTo(500, 9)
    expect(scaled.center.y).toBeCloseTo(0, 9)
    const centers = chairs.map((o) => (o.geometry as { center: Vector3 }).center).filter((c) => c.x >= 600 && c.x < 700)
    expect(centers.map((c) => `${c.x},${c.y}`).sort()).toEqual(['600,0', '600,30', '640,0', '640,30', '680,0', '680,30'])
    // Outlines on layer 0 take the layer of the reference; the circle keeps its own.
    const outline = model.objects.find((o) => o.geometry.type === 'polyline' && o.geometry.closed && layerName(o.layer) === 'Fachada')
    expect(outline).toBeDefined()
  })

  it('reads hatches with holes, patterns and edge boundaries', () => {
    const hatches = of('hatch').map((o) => o.geometry as HatchGeometry)
    const pattern = hatches.find((h) => h.pattern === 'Lines')!
    expect(pattern.loops).toHaveLength(2)
    expect(pattern.scale).toBeCloseTo(2 * 3.175, 9)
    expect(area(hatchTriangles({ ...pattern, pattern: 'Solid' }))).toBeCloseTo(10000 - 2500, 6)
    const half = hatches.find((h) => h.pattern === 'Solid' && h.loops[0].type === 'polycurve')!
    expect(area(hatchTriangles(half))).toBeCloseTo((Math.PI * 50 * 50) / 2, -1)
  })
})

describe('DXF reading details', () => {
  it('strips MTEXT formatting', () => {
    expect(mtextPlain('{\\fArial|b1|i0;Muro} de \\H2.5;hormigón\\Pdos\\~líneas \\S1/2;')).toBe('Muro de hormigón\ndos líneas 1/2')
  })

  it('reads back what ArchiOpen writes', () => {
    const objects: { layerId: number; geometry: Geometry }[] = [
      { layerId: 1, geometry: { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 5)], closed: true } },
      { layerId: 1, geometry: { type: 'arc', center: v(5, 5), xaxis: v(1, 0), yaxis: v(0, -1), radius: 2, angle: Math.PI / 2 } },
    ]
    const text = writeDxf({ units: 'Meters', layers: [{ id: 1, name: 'Planta', color: '#ff0000', visible: true, locked: false, linetype: 'Dashed' }], objects, linetypeScale: 1, millimetersPerUnit: 1000 })
    const back = readDxf(new TextEncoder().encode(text), 'Millimeters')
    expect(back.units).toBe('Meters')
    expect(back.layers[0]).toMatchObject({ name: 'PLANTA', color: '#ff0000', linetype: 'Dashed' })
    expect(back.objects.map((o) => o.geometry.type)).toEqual(['polyline', 'arc'])
    expect(length(back.objects[1].geometry as AnyCurve)).toBeCloseTo(Math.PI, 9)
  })

  it('refuses binary DXF', () => {
    expect(() => readDxf(new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00'), 'Millimeters')).toThrow(/ASCII/)
  })
})
