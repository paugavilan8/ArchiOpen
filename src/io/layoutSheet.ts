import { Vector3 } from 'three'
import type { Document } from '../core/document'
import { Geometry, isCurve, tessellate } from '../core/geometry'
import { Detail, detailObjects, Layout, Point, paperFactor, sheetFrame, sheetSize, viewAxes, wireframeDrawing } from '../core/layout'
import { dashesOf, DEFAULT_PRINT_WIDTH } from '../core/linetypes'
import { type ClipPlane, drawingClipPlanes } from '../core/clipPlanes'
import { kernelJob } from '../kernel/client'
import { shapeRef } from '../kernel/wire'
import type { Sheet, SheetItem } from './pdf'

/** A detail drawn with hidden lines removed: its lines on the sheet, and the cut lines of its clipping planes. */
export interface DetailLines {
  lines: Point[][]
  section: Point[][]
}

/** Hidden line drawings of details, by detail id. */
export type HiddenDrawings = Map<number, DetailLines>

/** Pen width of cut lines on the sheet, heavier than the rest as plans and sections are drawn. */
export const SECTION_WIDTH = 0.5

/** What a hidden line drawing is made of: the surfaces, solids, meshes and curves the details show. */
function drawnGeometry(doc: Document): Geometry[] {
  return detailObjects(doc)
    .map((o) => o.geometry)
    .filter((g) => g.type === 'brep' || g.type === 'mesh' || isCurve(g))
}

/**
 * Hidden line drawings in the view plane, by view direction, with the geometry they were made of.
 * Making one is the costly part (the kernel's hidden line removal); placing it on the sheet is not.
 * So a drawing is made again only when what it shows changes (not for a new layer color, a text, or
 * an object out of sight), and moving, scaling or resizing a detail only places it again.
 */
const drawings = new Map<string, { geometry: Geometry[]; lines: Vector3[][]; section: Vector3[][] }>()

/** The clipping planes that cut a detail. */
const detailPlanes = (doc: Document, detail: Detail): ClipPlane[] => (detail.clipping ? drawingClipPlanes(doc) : [])

/** A drawing depends on the view direction and on the planes that cut it. */
const viewKey = (doc: Document, detail: Detail) => {
  const { right, back } = viewAxes(detail.view)
  const planes = detailPlanes(doc, detail).map((p) => [...p.normal.toArray(), p.constant])
  return JSON.stringify([right.toArray(), back.toArray(), planes])
}

const sameGeometry = (a: Geometry[], b: Geometry[]) => a.length === b.length && a.every((g, i) => g === b[i])

/** The drawing for a view if it is still that of the model's geometry. */
function cachedDrawing(doc: Document, detail: Detail, geometry: Geometry[]): { lines: Vector3[][]; section: Vector3[][] } | null {
  const hit = drawings.get(viewKey(doc, detail))
  return hit && sameGeometry(hit.geometry, geometry) ? hit : null
}

/** A view-plane drawing placed on the sheet through the detail. */
function placed(doc: Document, detail: Detail, drawing: { lines: Vector3[][]; section: Vector3[][] }): DetailLines {
  const { right, up } = viewAxes(detail.view)
  // make2D draws in the view plane through the world origin; the detail centers its target.
  const target = new Vector3(...detail.target)
  const k = paperFactor(doc, detail)
  const [x, y, w, h] = detail.rect
  const ox = x + w / 2 - target.dot(right) * k
  const oy = y + h / 2 - target.dot(up) * k
  const place = (lines: Vector3[][]) => lines.map((line) => line.map((p): Point => [ox + p.x * k, oy + p.y * k]))
  return { lines: place(drawing.lines), section: place(drawing.section) }
}

/**
 * The visible lines of a detail's surfaces, solids and curves, on the sheet. Needs the geometry
 * kernel. Texts, dimensions and hatches are not included: they are drawn on top as they are.
 */
export async function hiddenLineDrawing(doc: Document, detail: Detail): Promise<DetailLines> {
  // The model may change while the kernel works: the drawing is of the geometry as it was asked for.
  const geometry = drawnGeometry(doc)
  const cached = cachedDrawing(doc, detail, geometry)
  if (cached) return placed(doc, detail, cached)
  const key = viewKey(doc, detail)
  const { right, back } = viewAxes(detail.view)
  const surfaces = geometry.filter((g) => g.type === 'brep')
  const curves = geometry.filter(isCurve)
  const meshes = geometry.filter((g) => g.type === 'mesh')
  let drawing = { lines: [] as Vector3[][], section: [] as Vector3[][] }
  if (geometry.length > 0) {
    const planes = detailPlanes(doc, detail)
    const { visible, section } = await kernelJob('make2DWithMeshes', surfaces.map(shapeRef), surfaces, curves, meshes, { direction: back, xaxis: right }, false, planes)
    drawing = { lines: visible.map((c) => tessellate(c)), section: (section ?? []).map((c) => tessellate(c)) }
  }
  if (drawings.size > 64) drawings.clear()
  drawings.set(key, { geometry, ...drawing })
  return placed(doc, detail, drawing)
}

/** The hidden line drawing of a detail if no kernel work is needed for it, else null. */
export function cachedHiddenLines(doc: Document, detail: Detail): DetailLines | null {
  const drawing = cachedDrawing(doc, detail, drawnGeometry(doc))
  return drawing ? placed(doc, detail, drawing) : null
}

/** The hidden line drawing of a detail, from the kernel unless it is still known. */
export const computeHiddenLines = hiddenLineDrawing

/** True if the detail is drawn with hidden lines removed (only parallel views can be). */
export const usesHiddenLines = (detail: Detail) => detail.hidden && !detail.view.eye

/**
 * A layout as a sheet for the PDF writer: each detail cut to its frame (in wireframe, or with the
 * hidden line drawing given for it), then the border, title block and captions.
 */
export function layoutSheet(doc: Document, layout: Layout, options: { black: boolean; sheetNumber: number; sheetCount: number }, hidden: HiddenDrawings): Sheet {
  const [width, height] = sheetSize(layout)
  const items: SheetItem[] = []
  for (const detail of layout.details) {
    const clip = detail.rect
    const hiddenLines = usesHiddenLines(detail) ? hidden.get(detail.id) : undefined
    if (hiddenLines) {
      items.push({ lines: hiddenLines.lines, fills: [], color: '#000000', width: 0.25, dashes: [], clip })
      if (hiddenLines.section.length > 0) items.push({ lines: hiddenLines.section, fills: [], color: '#000000', width: SECTION_WIDTH, dashes: [], clip })
      // Texts, dimensions and hatches go on top as they are; everything else came through hidden lines.
      const flat = wireframeDrawing(doc, detail, (g) => g.type === 'annotation' || g.type === 'hatch')
      for (const layer of doc.layers) {
        const entry = flat.layers.get(layer.id)
        if (!entry) continue
        items.push({ ...entry, color: options.black ? '#000000' : layer.color, width: layer.printWidth || DEFAULT_PRINT_WIDTH, dashes: dashesOf(layer.linetype), clip })
      }
      continue
    }
    const drawing = wireframeDrawing(doc, detail)
    for (const layer of doc.layers) {
      const entry = drawing.layers.get(layer.id)
      if (!entry) continue
      items.push({ ...entry, color: options.black ? '#000000' : layer.color, width: layer.printWidth || DEFAULT_PRINT_WIDTH, dashes: dashesOf(layer.linetype), clip })
    }
  }
  const frame = sheetFrame(layout, width, height, String(options.sheetNumber), options.sheetCount)
  items.push({ lines: frame, fills: [], color: '#000000', width: 0.25, dashes: [] })
  return { width, height, items, title: layout.titleBlock.project || layout.name }
}
