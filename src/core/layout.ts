import { Box3, Vector3 } from 'three'
import { annotationLines } from './annotation'
import { flatten } from './blocks'
import type { CadObject, Document } from './document'
import { AnnotationGeometry, Geometry, tessellate, wireframe } from './geometry'
import { millimetersPer } from './units'
import { textShape } from '../text/strokeFont'

/**
 * Layouts: sheets of paper holding details (views of the model at a scale) and a title block. Page
 * coordinates are millimeters from the sheet's lower left corner. Layouts are immutable values; the
 * document replaces them as a whole, which keeps undo simple.
 */

export type Vec = [number, number, number]
export type Point = [number, number]

export interface DetailView {
  name: string
  /** From the model towards the viewer. */
  direction: Vec
  /** Right on the sheet. */
  right: Vec
  /** Where the eye is, for perspective views; parallel views have none. */
  eye?: Vec
}

export interface Detail {
  id: number
  /** [x, y, width, height] on the sheet. */
  rect: [number, number, number, number]
  view: DetailView
  /** The model point at the center of the detail. */
  target: Vec
  /** Drawing scale 1:scale. */
  scale: number
  /** Hidden line drawing (parallel views only); wireframe otherwise. */
  hidden: boolean
  /** Caption under the detail; empty for none. */
  title: string
}

export interface TitleBlock {
  project: string
  title: string
  number: string
  author: string
  date: string
}

export interface Layout {
  id: number
  name: string
  paper: string
  landscape: boolean
  details: Detail[]
  titleBlock: TitleBlock
}

const iso = (dx: number, dy: number): Omit<DetailView, 'name'> => {
  const direction = new Vector3(dx, dy, 1).normalize()
  const right = new Vector3(0, 0, 1).cross(direction).normalize()
  return { direction: direction.toArray() as Vec, right: right.toArray() as Vec }
}

/** The standard views a detail can show. */
export const STANDARD_VIEWS: Record<string, Omit<DetailView, 'name'>> = {
  Top: { direction: [0, 0, 1], right: [1, 0, 0] },
  Front: { direction: [0, -1, 0], right: [1, 0, 0] },
  Right: { direction: [1, 0, 0], right: [0, 1, 0] },
  Back: { direction: [0, 1, 0], right: [-1, 0, 0] },
  Left: { direction: [-1, 0, 0], right: [0, -1, 0] },
  'SW Isometric': iso(-1, -1),
  'SE Isometric': iso(1, -1),
  'NE Isometric': iso(1, 1),
  'NW Isometric': iso(-1, 1),
}

export const view = (name: string): DetailView => ({ name, ...STANDARD_VIEWS[name] })

/** Scales offered for details, as 1:n. */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]

export const PAGE_MARGIN = 10
export const TITLE_BLOCK_SIZE: Point = [180, 32]

const vec = (v: Vec) => new Vector3(...v)

/** Axes of a detail's view: right and up on the sheet, and the direction towards the viewer. */
export function viewAxes(v: DetailView): { right: Vector3; up: Vector3; back: Vector3 } {
  const back = vec(v.direction).normalize()
  const right = vec(v.right).normalize()
  return { right, up: back.clone().cross(right).normalize(), back }
}

/** Millimeters on the sheet per model unit. */
export const paperFactor = (doc: Document, detail: Detail) => millimetersPer(doc.units) / detail.scale

/** Projects model points onto the sheet through a detail. Null for points behind a perspective eye. */
export function detailProjector(doc: Document, detail: Detail): (p: Vector3) => Point | null {
  const { right, up, back } = viewAxes(detail.view)
  const k = paperFactor(doc, detail)
  const [x, y, w, h] = detail.rect
  const cx = x + w / 2
  const cy = y + h / 2
  const target = vec(detail.target)
  const d = new Vector3()
  if (!detail.view.eye) {
    return (p) => {
      d.copy(p).sub(target)
      return [cx + d.dot(right) * k, cy + d.dot(up) * k]
    }
  }
  const eye = vec(detail.view.eye)
  const distance = eye.distanceTo(target)
  return (p) => {
    d.copy(p).sub(eye)
    const z = -d.dot(back)
    if (z < 1e-9) return null
    return [cx + ((d.dot(right) * distance) / z) * k, cy + ((d.dot(up) * distance) / z) * k]
  }
}

/** The objects a detail shows: visible ones (blocks expanded), by layer. */
export function detailObjects(doc: Document): { layerId: number; geometry: Geometry }[] {
  const out: { layerId: number; geometry: Geometry }[] = []
  const shown = (o: CadObject) => doc.isVisible(o) && doc.blockEdit?.instanceId !== o.id
  for (const o of doc.objects.values()) if (shown(o)) for (const g of flatten(o.geometry)) out.push({ layerId: o.layerId, geometry: g })
  return out
}

export interface DetailDrawing {
  /** Polylines and filled regions on the sheet, by layer. */
  layers: Map<number, { lines: Point[][]; fills: Point[][][] }>
}

/** The model as a detail shows it in wireframe: every object's lines, and solid hatches filled. */
export function wireframeDrawing(doc: Document, detail: Detail, only?: (g: Geometry) => boolean): DetailDrawing {
  const project = detailProjector(doc, detail)
  const layers: DetailDrawing['layers'] = new Map()
  for (const { layerId, geometry: g } of detailObjects(doc)) {
    if (only && !only(g)) continue
    let entry = layers.get(layerId)
    if (!entry) layers.set(layerId, (entry = { lines: [], fills: [] }))
    if (g.type === 'hatch' && g.pattern === 'Solid') {
      entry.fills.push(g.loops.map((loop) => tessellate(loop).map(project).filter((p): p is Point => p !== null)))
      continue
    }
    for (const line of wireframe(g)) {
      let run: Point[] = []
      for (const p of line) {
        const q = project(p)
        if (q) run.push(q)
        else {
          if (run.length > 1) entry.lines.push(run)
          run = []
        }
      }
      if (run.length > 1) entry.lines.push(run)
    }
  }
  return { layers }
}

/** Bounds of the shown objects seen through a view, relative to `target`, in model units. */
function projectedBounds(doc: Document, detail: Detail): { min: Point; max: Point } | null {
  const probe: Detail = { ...detail, rect: [0, 0, 0, 0], scale: millimetersPer(doc.units) }
  const project = detailProjector(doc, probe)
  let min: Point = [Infinity, Infinity]
  let max: Point = [-Infinity, -Infinity]
  for (const { geometry } of detailObjects(doc)) {
    for (const line of wireframe(geometry)) {
      for (const p of line) {
        const q = project(p)
        if (!q) continue
        min = [Math.min(min[0], q[0]), Math.min(min[1], q[1])]
        max = [Math.max(max[0], q[0]), Math.max(max[1], q[1])]
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null
}

/** The detail centered on the model and at the largest standard scale that fits it. */
export function fitDetail(doc: Document, detail: Detail): Detail {
  const box = new Box3()
  for (const { geometry } of detailObjects(doc)) for (const line of wireframe(geometry)) for (const p of line) box.expandByPoint(p)
  if (box.isEmpty()) return detail
  const center = box.getCenter(new Vector3())
  let fitted: Detail = { ...detail, target: center.toArray() as Vec }
  if (detail.view.eye) {
    // A perspective keeps its eye's direction and distance, moved to look at the model.
    const eye = vec(detail.view.eye)
    const offset = eye.sub(vec(detail.target))
    fitted = { ...fitted, view: { ...detail.view, eye: center.clone().add(offset).toArray() as Vec } }
  }
  const bounds = projectedBounds(doc, fitted)
  if (!bounds) return fitted
  if (!detail.view.eye) {
    // Center the projected drawing, not just the box's center.
    const { right, up } = viewAxes(detail.view)
    const mid = center
      .clone()
      .addScaledVector(right, (bounds.min[0] + bounds.max[0]) / 2)
      .addScaledVector(up, (bounds.min[1] + bounds.max[1]) / 2)
    fitted = { ...fitted, target: mid.toArray() as Vec }
  }
  const mm = millimetersPer(doc.units)
  const [, , w, h] = detail.rect
  const needed = Math.max(((bounds.max[0] - bounds.min[0]) * mm) / (w * 0.9), ((bounds.max[1] - bounds.min[1]) * mm) / (h * 0.9), 1e-9)
  const scale = detail.view.eye ? needed : (STANDARD_SCALES.find((s) => s >= needed) ?? Math.ceil(needed / 1000) * 1000)
  return { ...fitted, scale }
}

/** The scale written in the title block: the details' common scale, or "As shown". */
export function sheetScale(layout: Layout): string {
  const scales = [...new Set(layout.details.filter((d) => !d.view.eye).map((d) => d.scale))]
  if (scales.length === 1) return formatScale(scales[0])
  return scales.length === 0 ? 'NTS' : 'As shown'
}

export const formatScale = (scale: number) => `1:${Number.isInteger(scale) ? scale : scale.toFixed(1)}`

const text = (at: Point, content: string, height: number): AnnotationGeometry => ({
  type: 'annotation',
  kind: 'text',
  points: [new Vector3(at[0], at[1], 0)],
  xaxis: new Vector3(1, 0, 0),
  yaxis: new Vector3(0, 1, 0),
  text: content,
  height,
  arrow: 'arrow',
  precision: 0,
})

const box = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
]

/** The sheet's border, title block and detail captions, as polylines on the sheet. */
export function sheetFrame(layout: Layout, width: number, height: number, sheetNumber = '', sheetCount = 0): Point[][] {
  const m = PAGE_MARGIN
  const [tw, th] = TITLE_BLOCK_SIZE
  const x0 = width - m - tw
  const y0 = m
  const lines: Point[][] = [box(m, m, width - 2 * m, height - 2 * m), box(x0, y0, tw, th)]
  // Rows: project and drawing title on top; number, scale, date, author and sheet below.
  lines.push([[x0, y0 + 12], [x0 + tw, y0 + 12]])
  lines.push([[x0 + 100, y0 + 12], [x0 + 100, y0 + th]])
  for (const x of [36, 72, 108, 144]) lines.push([[x0 + x, y0], [x0 + x, y0 + 12]])
  const t = layout.titleBlock
  const label = (x: number, y: number, s: string) => text([x0 + x + 1.5, y0 + y], s, 1.6)
  const value = (x: number, y: number, s: string, h = 2.5) => text([x0 + x + 1.5, y0 + y], s, h)
  const texts: AnnotationGeometry[] = [
    label(0, th - 3.5, 'PROJECT'),
    value(0, th - 10, t.project, 3.5),
    label(100, th - 3.5, 'DRAWN BY'),
    value(100, th - 10, t.author),
    label(0, 8.5, 'DRAWING'),
    value(0, 2.5, t.title || layout.name),
    label(36, 8.5, 'No.'),
    value(36, 2.5, t.number),
    label(72, 8.5, 'SCALE'),
    value(72, 2.5, sheetScale(layout)),
    label(108, 8.5, 'DATE'),
    value(108, 2.5, t.date),
    label(144, 8.5, 'SHEET'),
    value(144, 2.5, sheetCount > 0 ? `${sheetNumber}/${sheetCount}` : sheetNumber),
  ]
  // Captions under the details, underlined.
  for (const d of layout.details) {
    if (!d.title) continue
    const caption = d.view.eye ? d.title : `${d.title}  ${formatScale(d.scale)}`
    texts.push(text([d.rect[0], d.rect[1] - 5], caption, 3))
    lines.push([
      [d.rect[0], d.rect[1] - 6.5],
      [d.rect[0] + textShape(caption).widths[0] * 3, d.rect[1] - 6.5],
    ])
  }
  for (const t of texts) if (t.text) for (const line of annotationLines(t)) lines.push(line.map((p) => [p.x, p.y]))
  return lines
}

/** The area left for details: inside the border, above the title block. */
export function drawingArea(width: number, height: number): [number, number, number, number] {
  const m = PAGE_MARGIN + 5
  return [m, PAGE_MARGIN + TITLE_BLOCK_SIZE[1] + 10, width - 2 * m, height - PAGE_MARGIN - TITLE_BLOCK_SIZE[1] - 10 - m]
}

/** Standard paper sizes in millimeters, portrait. */
export const PAPER_SIZES: Record<string, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  Letter: [215.9, 279.4],
  Tabloid: [279.4, 431.8],
}

/** Width and height of a layout's sheet. */
export function sheetSize(layout: Pick<Layout, 'paper' | 'landscape'>): Point {
  const [w, h] = PAPER_SIZES[layout.paper] ?? PAPER_SIZES.A3
  return layout.landscape ? [h, w] : [w, h]
}

/** A new sheet with one detail showing the whole model from the top, fitted. */
export function newLayout(doc: Document, id: number, name: string, paper = 'A3', landscape = true): Layout {
  const [w, h] = sheetSize({ paper, landscape })
  const today = new Date()
  const layout: Layout = {
    id,
    name,
    paper,
    landscape,
    details: [],
    titleBlock: { project: '', title: name, number: String(id).padStart(2, '0'), author: '', date: today.toISOString().slice(0, 10) },
  }
  const detail: Detail = { id: 1, rect: drawingArea(w, h), view: view('Top'), target: [0, 0, 0], scale: 100, hidden: false, title: '' }
  return { ...layout, details: [fitDetail(doc, detail)] }
}
