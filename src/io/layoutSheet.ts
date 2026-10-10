import { Vector3 } from 'three'
import type { Document } from '../core/document'
import { isCurve, tessellate } from '../core/geometry'
import { Detail, detailObjects, Layout, Point, paperFactor, sheetFrame, sheetSize, viewAxes, wireframeDrawing } from '../core/layout'
import { dashesOf, DEFAULT_PRINT_WIDTH } from '../core/linetypes'
import { kernelJob } from '../kernel/client'
import { shapeRef } from '../kernel/wire'
import type { Sheet, SheetItem } from './pdf'

/** Lines on the sheet of details drawn with hidden lines removed, by detail id. */
export type HiddenDrawings = Map<number, Point[][]>

/**
 * The visible lines of a detail's surfaces, solids and curves, on the sheet. Needs the geometry
 * kernel. Texts, dimensions and hatches are not included: they are drawn on top as they are.
 */
export async function hiddenLineDrawing(doc: Document, detail: Detail): Promise<Point[][]> {
  const { right, up, back } = viewAxes(detail.view)
  const objects = detailObjects(doc).map((o) => o.geometry)
  const surfaces = objects.filter((g) => g.type === 'brep')
  const shapes = surfaces.map(shapeRef)
  const curves = objects.filter(isCurve)
  const meshes = objects.filter((g) => g.type === 'mesh')
  if (shapes.length === 0 && curves.length === 0 && meshes.length === 0) return []
  const { visible } = await kernelJob('make2DWithMeshes', shapes, surfaces, curves, meshes, { direction: back, xaxis: right }, false)
  // make2D draws in the view plane through the world origin; the detail centers its target.
  const target = new Vector3(...detail.target)
  const k = paperFactor(doc, detail)
  const [x, y, w, h] = detail.rect
  const ox = x + w / 2 - target.dot(right) * k
  const oy = y + h / 2 - target.dot(up) * k
  return visible.map((c) => tessellate(c).map((p): Point => [ox + p.x * k, oy + p.y * k]))
}

const cache = new Map<string, { revision: number; lines: Point[][] }>()

/** The hidden line drawing of a detail, computed again only when the model or the detail changed. */
export function cachedHiddenLines(doc: Document, detail: Detail): Point[][] | null {
  const key = JSON.stringify([detail.view, detail.target, detail.scale, detail.rect])
  const hit = cache.get(key)
  return hit && hit.revision === doc.revision ? hit.lines : null
}

export async function computeHiddenLines(doc: Document, detail: Detail): Promise<Point[][]> {
  const key = JSON.stringify([detail.view, detail.target, detail.scale, detail.rect])
  // The model may change while the kernel works: the drawing is of the model as it was asked for.
  const revision = doc.revision
  const lines = await hiddenLineDrawing(doc, detail)
  if (cache.size > 64) cache.clear()
  cache.set(key, { revision, lines })
  return lines
}

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
