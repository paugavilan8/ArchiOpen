import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import { Detail, fitDetail, newLayout, sheetFrame, sheetScale, sheetSize, view, wireframeDrawing } from '../core/layout'
import { box, toBrep } from '../kernel/brep'
import { cachedHiddenLines, hiddenLineDrawing, layoutSheet, SECTION_WIDTH } from './layoutSheet'
import { Matrix4 } from 'three'
import { transform } from '../core/curves'
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

  it('draw details with hidden lines removed', async () => {
    const doc = new Document()
    // Two boxes, the small one behind the big one seen from the front.
    doc.add(toBrep(box(v(0, 0), v(4000, 0), v(0, 1000), v(0, 0, 3000))))
    doc.add(toBrep(box(v(1000, 3000), v(2000, 0), v(0, 1000), v(0, 0, 1000))))
    const layout = newLayout(doc, 1, 'Alzado')
    const detail = fitDetail(doc, { ...layout.details[0], view: view('Front') })
    const { lines } = await hiddenLineDrawing(doc, detail)
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

  it('draws hidden lines again only when what they show changes', async () => {
    const doc = new Document()
    const big = doc.add(toBrep(box(v(0, 0), v(4000, 0), v(0, 1000), v(0, 0, 3000)))).id
    const layout = newLayout(doc, 1, 'Alzado')
    const detail = fitDetail(doc, { ...layout.details[0], view: view('Top') })
    expect(cachedHiddenLines(doc, detail)).toBeNull()
    const first = await hiddenLineDrawing(doc, detail)
    // A new layer color, a text, an object on a hidden layer: the drawing is still good.
    doc.updateLayer(doc.layers[0].id, { color: '#ff0000' })
    doc.add({
      type: 'annotation',
      kind: 'text',
      points: [v(0, -500)],
      xaxis: v(1, 0),
      yaxis: v(0, 1),
      text: 'Planta',
      height: 200,
      arrow: 'arrow',
      precision: 0,
    })
    const hidden = doc.addLayer()
    doc.updateLayer(hidden.id, { visible: false })
    doc.add(toBrep(box(v(9000, 0), v(100, 0), v(0, 100), v(0, 0, 100))), hidden.id)
    expect(cachedHiddenLines(doc, detail)).toEqual(first)
    // Moving the detail on the sheet only places the same drawing elsewhere.
    const moved = { ...detail, rect: [detail.rect[0] + 50, detail.rect[1], detail.rect[2], detail.rect[3]] as Detail['rect'] }
    const shifted = cachedHiddenLines(doc, moved)!
    expect(shifted.lines[0][0][0]).toBeCloseTo(first.lines[0][0][0] + 50, 9)
    // Moving the box changes what the detail shows.
    const g = doc.objects.get(big)!.geometry
    doc.setGeometry(big, transform(g, new Matrix4().makeTranslation(500, 0, 0)))
    expect(cachedHiddenLines(doc, detail)).toBeNull()
  })

  it('draws a plan cut by a clipping plane, with its cut lines apart, when the detail asks for it', async () => {
    const doc = new Document()
    // A 4 × 1 × 3 m wall, and a clipping plane at 1.5 m keeping what is below.
    doc.add(toBrep(box(v(0, 0), v(4000, 0), v(0, 1000), v(0, 0, 3000))))
    const plane = doc.add({ type: 'clipping', center: v(2000, 500, 1500), xaxis: v(1, 0), yaxis: v(0, -1), width: 6000, height: 3000, views: [] }).id
    const layout = newLayout(doc, 1, 'Planta')
    const plain = fitDetail(doc, { ...layout.details[0], view: view('Front'), hidden: true })
    const cut = { ...plain, clipping: true }
    const whole = await hiddenLineDrawing(doc, plain)
    expect(whole.section).toHaveLength(0)
    const section = await hiddenLineDrawing(doc, cut)
    const k = 1 / cut.scale
    // Seen from the front, the wall now stops at the cut, whose edge is a cut line 4 m long.
    expect(extent([...section.lines, ...section.section]).maxY - extent([...section.lines, ...section.section]).minY).toBeCloseTo(1500 * k, 6)
    const length = (ls: [number, number][][]) => ls.reduce((sum, l) => sum + l.slice(1).reduce((s2, p, i) => s2 + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0)
    expect(length(section.section)).toBeCloseTo(4000 * k, 6)
    // The sheet prints the cut lines with a heavier pen.
    const sheet = layoutSheet(doc, { ...layout, details: [cut] }, { black: true, sheetNumber: 1, sheetCount: 1 }, new Map([[cut.id, section]]))
    expect(sheet.items.some((item) => item.width === SECTION_WIDTH && item.lines.length > 0)).toBe(true)
    // Wireframe details are cut too.
    const wire = extent(wireframeDrawing(doc, { ...cut, hidden: false }).layers.get(1)!.lines)
    expect(wire.maxY - wire.minY).toBeCloseTo(1500 * k, 6)
    // Hiding the plane draws the whole wall again.
    doc.setState(plane, { hidden: 'user' })
    expect(extent(wireframeDrawing(doc, { ...cut, hidden: false }).layers.get(1)!.lines).maxY - wire.minY).toBeCloseTo(3000 * k, 6)
  })
})
