import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Layer } from '../core/document'
import type { Geometry } from '../core/geometry'
import { aciOf, dxfName, writeDxf } from './dxf'
import { contentStream, writePdf } from './pdf'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const text = (bytes: Uint8Array) => String.fromCharCode(...bytes)

describe('PDF', () => {
  const sheet = {
    width: 420,
    height: 297,
    items: [
      { lines: [[[10, 10], [110, 10]] as [number, number][]], fills: [], color: '#ff0000', width: 0.5, dashes: [3, -1.5] },
      { lines: [], fills: [[[[0, 0], [10, 0], [10, 10]] as [number, number][]]], color: '#000000', width: 0.18, dashes: [] },
    ],
  }

  it('strokes lines in points with color, width and dashes, after the fills', () => {
    const ops = contentStream(sheet)
    expect(ops).toContain('1 0 0 RG')
    expect(ops).toContain('1.417 w')
    expect(ops).toContain('[8.504 4.252] 0 d')
    expect(ops).toContain('28.346 28.346 m\n311.811 28.346 l\nS')
    expect(ops.indexOf('f*')).toBeLessThan(ops.indexOf('S'))
  })

  it('writes a well-formed file whose cross-reference table points at the objects', async () => {
    const bytes = await writePdf({ ...sheet, title: 'Planta (baja)' })
    const file = text(bytes)
    expect(file.startsWith('%PDF-1.4')).toBe(true)
    expect(file).toContain('/MediaBox [0 0 1190.551 841.89]')
    expect(file).toContain('/Title (Planta \\(baja\\))')
    const xref = Number(/startxref\n(\d+)/.exec(file)![1])
    expect(file.slice(xref, xref + 4)).toBe('xref')
    const offsets = [...file.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
    offsets.forEach((o, i) => expect(file.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true))
    // The page content is deflated and inflates back to the drawing operators.
    const start = file.indexOf('stream\n') + 7
    const end = file.indexOf('\nendstream')
    const inflated = new Blob([bytes.slice(start, end)]).stream().pipeThrough(new DecompressionStream('deflate'))
    expect(text(new Uint8Array(await new Response(inflated).arrayBuffer()))).toBe(contentStream(sheet))
  })
})

describe('DXF', () => {
  const layers: Layer[] = [
    { id: 1, name: 'Default', color: '#000000', visible: true, locked: false },
    { id: 2, name: 'Muros cortados', color: '#ff0000', visible: true, locked: false, linetype: 'Hidden' },
  ]
  const objects: { layerId: number; geometry: Geometry }[] = [
    { layerId: 1, geometry: { type: 'polyline', points: [v(0, 0), v(10, 0)], closed: false } },
    { layerId: 2, geometry: { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 5)], closed: true } },
    { layerId: 2, geometry: { type: 'circle', center: v(5, 5), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 } },
    // An arc turning clockwise seen from above: from (7, 5) down through (5, 3) to (3, 5).
    { layerId: 1, geometry: { type: 'arc', center: v(5, 5), xaxis: v(1, 0), yaxis: v(0, -1), radius: 2, angle: Math.PI } },
    {
      layerId: 1,
      geometry: {
        type: 'hatch',
        loops: [{ type: 'polyline', points: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)], closed: true }],
        pattern: 'Solid',
        scale: 1,
        rotation: 0,
        origin: v(0, 0),
        xaxis: v(1, 0),
        yaxis: v(0, 1),
      },
    },
  ]
  const dxf = writeDxf({ units: 'Millimeters', layers, objects, linetypeScale: 50, millimetersPerUnit: 1 })
  const pairs = dxf.trim().split('\r\n')
  const count = (entity: string) => pairs.filter((s, i) => i % 2 === 1 && s === entity && pairs[i - 1] === '0').length
  const after = (code: string, from: number) => pairs[pairs.indexOf(code, from) + 1]

  it('writes an R12 file with units, linetypes and layers', () => {
    expect(pairs.slice(0, 2)).toEqual(['0', 'SECTION'])
    expect(after('$ACADVER', 0)).toBe('1')
    expect(pairs[pairs.indexOf('$ACADVER') + 2]).toBe('AC1009')
    expect(pairs[pairs.indexOf('$INSUNITS') + 2]).toBe('4')
    expect(pairs).toContain('MUROS_CORTADOS')
    expect(pairs).toContain('HIDDEN')
    expect(pairs.slice(-2)).toEqual(['0', 'EOF'])
  })

  it('writes lines, polylines, circles, arcs and solid fills', () => {
    expect(count('LINE')).toBe(1)
    expect(count('POLYLINE')).toBe(1)
    expect(count('VERTEX')).toBe(3)
    expect(count('CIRCLE')).toBe(1)
    expect(count('ARC')).toBe(1)
    expect(count('SOLID')).toBe(2)
    // Counterclockwise from (3, 5) to (7, 5): 180° to 360° (0°).
    const arc = pairs.indexOf('ARC')
    expect(Number(after('50', arc))).toBeCloseTo(180, 6)
    expect(Math.abs(Number(after('51', arc)))).toBeCloseTo(0, 6)
  })

  it('maps colors and names to what R12 allows', () => {
    expect(aciOf('#ff0000')).toBe(1)
    expect(aciOf('#000000')).toBe(7)
    expect(aciOf('#ffffff')).toBe(7)
    // Known palette entries: 11 is light red, 30 orange, 150 a blue.
    expect(aciOf('#ff7f7f')).toBe(11)
    expect(aciOf('#ff7f00')).toBe(30)
    expect(aciOf('#007fff')).toBe(150)
    expect(dxfName('Planta baja: muros (ext.)')).toBe('PLANTA_BAJA_MUROS_EXT_')
    expect(dxfName('Fachada señal')).toBe('FACHADA_SENAL')
  })
})
