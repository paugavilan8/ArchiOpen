import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import { Detail, fitDetail, newLayout, sheetFrame, sheetScale, sheetSize, view, wireframeDrawing } from '../core/layout'
import { box, toBrep } from '../kernel/brep'
import { hiddenLineDrawing, layoutSheet } from './layoutSheet'
import { contentStream, writePdf } from './pdf'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/** A 10 m × 6 m rectangle in a model in millimeters. */
function plan(): Document {
  const doc = new Document()
  doc.add({ type: 'polyline', points: [v(0, 0), v(10000, 0), v(10000, 6000), v(0, 6000)], closed: true })
  return doc
}

const extent = (lines: [number, number][][]) => {
  const xs = lines.flat().map((p) => p[0])
  const ys = lines.flat().map((p) => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('layouts', () => {
  it('make a sheet with one detail fitted at a standard scale', () => {
    const doc = plan()
    const layout = newLayout(doc, 1, 'Planta baja')
    expect(sheetSize(layout)).toEqual([420, 297])
    const detail = layout.details[0]
    // The detail is about 390 × 210 mm: 10 m fits at 1:50 (200 mm) but not at 1:25.
    expect(detail.scale).toBe(50)
    expect(sheetScale(layout)).toBe('1:50')
    const lines = wireframeDrawing(doc, detail).layers.get(1)!.lines
    const e = extent(lines)
    expect(e.maxX - e.minX).toBeCloseTo(200, 6)
    expect(e.maxY - e.minY).toBeCloseTo(120, 6)
    // Centered in the detail's frame.
    const [x, y, w, h] = detail.rect
    expect((e.minX + e.maxX) / 2).toBeCloseTo(x + w / 2, 6)
    expect((e.minY + e.maxY) / 2).toBeCloseTo(y + h / 2, 6)
  })

  it('show other views and scales', () => {
    const doc = plan()
    const layout = newLayout(doc, 1, 'A')
    const front: Detail = fitDetail(doc, { ...layout.details[0], view: view('Front'), scale: 100 })
    const e = extent(wireframeDrawing(doc, { ...front, scale: 100 }).layers.get(1)!.lines)
    // Seen from the front, the flat rectangle is a 100 mm line at 1:100.
    expect(e.maxX - e.minX).toBeCloseTo(100, 6)
    expect(e.maxY - e.minY).toBeCloseTo(0, 6)
  })

  it('draw the title block with its fields and the sheet number', () => {
    const doc = plan()
    const layout = { ...newLayout(doc, 1, 'Planta baja'), titleBlock: { project: 'Casa', title: 'Planta', number: 'A-01', author: 'PG', date: '2026-10-09' } }
    const frame = sheetFrame(layout, 420, 297, '1', 3)
    // Border and title block boxes, cell lines, and many text strokes.
    expect(frame.length).toBeGreaterThan(100)
    const e = extent(frame)
    expect(e.minX).toBeCloseTo(10, 6)
    expect(e.maxX).toBeCloseTo(410, 6)
  })

  it('are undone as a whole and saved with the model', () => {
    const doc = plan()
    doc.setLayouts([newLayout(doc, 1, 'A')])
    doc.updateLayout({ ...doc.layouts[0], name: 'B' })
    expect(doc.layouts[0].name).toBe('B')
    doc.undo()
    expect(doc.layouts[0].name).toBe('A')
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.layouts).toEqual(doc.layouts)
  })
})

describe('layout sheets', () => {
  it('cut each detail to its frame and print several sheets in one PDF', async () => {
    const doc = plan()
    const a = newLayout(doc, 1, 'A')
    const b = { ...newLayout(doc, 2, 'B', 'A4', false) }
    const sheetA = layoutSheet(doc, a, { black: true, sheetNumber: 1, sheetCount: 2 }, new Map())
    expect(sheetA.items[0].clip).toEqual(a.details[0].rect)
    expect(contentStream(sheetA)).toMatch(/^1 J 1 j\nq\n[\d. ]+ re W n/)
    const pdf = new TextDecoder('latin1').decode(await writePdf([sheetA, layoutSheet(doc, b, { black: true, sheetNumber: 2, sheetCount: 2 }, new Map())]))
    expect(pdf).toContain('/Count 2')
    expect(pdf).toContain('/MediaBox [0 0 1190.551 841.89]')
    expect(pdf).toContain('/MediaBox [0 0 595.276 841.89]')
  })

  it('draw details with hidden lines removed', () => {
    const doc = new Document()
    // Two boxes, the small one behind the big one seen from the front.
    doc.add(toBrep(box(v(0, 0), v(4000, 0), v(0, 1000), v(0, 0, 3000))))
    doc.add(toBrep(box(v(1000, 3000), v(2000, 0), v(0, 1000), v(0, 0, 1000))))
    const layout = newLayout(doc, 1, 'Alzado')
    const detail = fitDetail(doc, { ...layout.details[0], view: view('Front') })
    const lines = hiddenLineDrawing(doc, detail)
    const e = extent(lines)
    const k = 1 / detail.scale
    // Only the big box's outline shows: 4 m × 3 m at the detail's scale.
    expect(e.maxX - e.minX).toBeCloseTo(4000 * k, 6)
    expect(e.maxY - e.minY).toBeCloseTo(3000 * k, 6)
    const total = lines.reduce((sum, l) => sum + l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0)
    expect(total).toBeCloseTo(14000 * k, 6)
    // Centered like the wireframe drawing.
    const wire = extent(wireframeDrawing(doc, detail).layers.get(1)!.lines)
    expect((e.minX + e.maxX) / 2).toBeCloseTo((wire.minX + wire.maxX) / 2, 6)
  })
})
