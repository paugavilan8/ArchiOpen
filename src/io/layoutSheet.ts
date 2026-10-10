import { Vector3 } from 'three'
import type { Document } from '../core/document'
import { Geometry, isCurve, tessellate } from '../core/geometry'
import { Detail, detailObjects, Layout, Point, paperFactor, sheetFrame, sheetSize, viewAxes, wireframeDrawing } from '../core/layout'
import { dashesOf, DEFAULT_PRINT_WIDTH } from '../core/linetypes'
import { kernelJob } from '../kernel/client'
import { shapeRef } from '../kernel/wire'
import type { Sheet, SheetItem } from './pdf'

/** Lines on the sheet of details drawn with hidden lines removed, by detail id. */
export type HiddenDrawings = Map<number, Point[][]>

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
const drawings = new Map<string, { geometry: Geometry[]; lines: Vector3[][] }>()

const viewKey = (detail: Detail) => {
  const { right, back } = viewAxes(detail.view)
  return JSON.stringify([right.toArray(), back.toArray()])
}

const sameGeometry = (a: Geometry[], b: Geometry[]) => a.length === b.length && a.every((g, i) => g === b[i])

/** The drawing for a view if it is still that of the model's geometry. */
function cachedDrawing(detail: Detail, geometry: Geometry[]): Vector3[][] | null {
  const hit = drawings.get(viewKey(detail))
  return hit && sameGeometry(hit.geometry, geometry) ? hit.lines : null
}

/** A view-plane drawing placed on the sheet through the detail. */
function placed(doc: Document, detail: Detail, lines: Vector3[][]): Point[][] {
  const { right, up } = viewAxes(detail.view)
  // make2D draws in the view plane through the world origin; the detail centers its target.
  const target = new Vector3(...detail.target)
  const k = paperFactor(doc, detail)
  const [x, y, w, h] = detail.rect
  const ox = x + w / 2 - target.dot(right) * k
  const oy = y + h / 2 - target.dot(up) * k
  return lines.map((line) => line.map((p): Point => [ox + p.x * k, oy + p.y * k]))
}

/**
 * The visible lines of a detail's surfaces, solids and curves, on the sheet. Needs the geometry
 * kernel. Texts, dimensions and hatches are not included: they are drawn on top as they are.
 */
export async function hiddenLineDrawing(doc: Document, detail: Detail): Promise<Point[][]> {
  // The model may change while the kernel works: the drawing is of the geometry as it was asked for.
  const geometry = drawnGeometry(doc)
  const cached = cachedDrawing(detail, geometry)
  if (cached) return placed(doc, detail, cached)
  const { right, back } = viewAxes(detail.view)
  const surfaces = geometry.filter((g) => g.type === 'brep')
  const curves = geometry.filter(isCurve)
  const meshes = geometry.filter((g) => g.type === 'mesh')
  let lines: Vector3[][] = []
  if (geometry.length > 0) {
    const { visible } = await kernelJob('make2DWithMeshes', surfaces.map(shapeRef), surfaces, curves, meshes, { direction: back, xaxis: right }, false)
    lines = visible.map((c) => tessellate(c))
  }
  if (drawings.size > 64) drawings.clear()
  drawings.set(viewKey(detail), { geometry, lines })
  return placed(doc, detail, lines)
}

/** The hidden line drawing of a detail if no kernel work is needed for it, else null. */
export function cachedHiddenLines(doc: Document, detail: Detail): Point[][] | null {
  const lines = cachedDrawing(detail, drawnGeometry(doc))
  return lines ? placed(doc, detail, lines) : null
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
      items.push({ lines: hiddenLines, fills: [], color: '#000000', width: 0.25, dashes: [], clip })
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
