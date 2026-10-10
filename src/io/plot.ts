import { PerspectiveCamera, Vector3 } from 'three'
import { flatten } from '../core/blocks'
import type { CadObject, Document } from '../core/document'
import { tessellate, wireframe } from '../core/geometry'
import { dashesOf, DEFAULT_PRINT_WIDTH } from '../core/linetypes'
import { millimetersPer } from '../core/units'
import type { Viewport } from '../view/viewport'
import { PAPER_SIZES, Sheet, SheetItem } from './pdf'

type Point = [number, number]

export interface PlotOptions {
  paper: string
  landscape: boolean
  /** Drawing scale as 1:scale, or null to fit the drawing to the paper. */
  scale: number | null
  /** Everything selected or visible ('Extents'), or what the viewport shows ('View'). */
  area: 'Extents' | 'View'
  /** Print every line in black (fills keep their color). */
  black: boolean
  /** Blank border around the paper, in millimeters. */
  margin?: number
}

/** Projects model points into the plane of a viewport, in model units for parallel views. */
function projector(vp: Viewport): (p: Vector3) => Point | null {
  const camera = vp.camera
  camera.updateMatrixWorld()
  const toView = camera.matrixWorldInverse
  const perspective = camera instanceof PerspectiveCamera
  const depth = camera.position.distanceTo(vp.target)
  const v = new Vector3()
  return (p) => {
    v.copy(p).applyMatrix4(toView)
    if (!perspective) return [v.x, v.y]
    if (v.z > -1e-9) return null
    return [(v.x / -v.z) * depth, (v.y / -v.z) * depth]
  }
}

/** The region of the view plane the viewport shows. */
function viewRect(vp: Viewport): { min: Point; max: Point } {
  const camera = vp.camera
  if (camera instanceof PerspectiveCamera) {
    const depth = camera.position.distanceTo(vp.target)
    const h = depth * Math.tan((camera.fov * Math.PI) / 360)
    return { min: [-h * camera.aspect, -h], max: [h * camera.aspect, h] }
  }
  return {
    min: [camera.left / camera.zoom, camera.bottom / camera.zoom],
    max: [camera.right / camera.zoom, camera.top / camera.zoom],
  }
}

/**
 * The objects as a paper sheet, seen from the viewport. Lines keep their layer's color, print width
 * and linetype; solid hatches are filled. Perspective views can only be fitted to the paper.
 */
export function plotSheet(doc: Document, vp: Viewport, objects: CadObject[], options: PlotOptions): Sheet {
  const [w, h] = PAPER_SIZES[options.paper] ?? PAPER_SIZES.A4
  const [width, height] = options.landscape ? [h, w] : [w, h]
  const margin = options.margin ?? 10
  const project = projector(vp)

  // Project everything once, grouped by layer.
  const byLayer = new Map<number, { lines: Point[][]; fills: Point[][][] }>()
  let min: Point = [Infinity, Infinity]
  let max: Point = [-Infinity, -Infinity]
  const grow = (p: Point) => {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])]
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])]
  }
  for (const obj of objects) {
    let entry = byLayer.get(obj.layerId)
    if (!entry) byLayer.set(obj.layerId, (entry = { lines: [], fills: [] }))
    // Blocks print what they hold, on the block's layer.
    for (const g of flatten(obj.geometry)) {
      // Clipping planes cut views on screen; they are not drawn on paper.
      if (g.type === 'clipping') continue
      if (g.type === 'hatch' && g.pattern === 'Solid') {
        const region = g.loops.map((loop) => tessellate(loop).map(project).filter((p): p is Point => p !== null))
        region.flat().forEach(grow)
        entry.fills.push(region)
        continue
      }
      for (const line of wireframe(g)) {
        // A line that passes behind a perspective camera is split there.
        let run: Point[] = []
        for (const p of line) {
          const q = project(p)
          if (q) {
            run.push(q)
            grow(q)
          } else if (run.length > 0) {
            entry.lines.push(run)
            run = []
          }
        }
        if (run.length > 1) entry.lines.push(run)
      }
    }
  }

  const perspective = vp.camera instanceof PerspectiveCamera
  if (options.area === 'View') ({ min, max } = viewRect(vp))
  if (!Number.isFinite(min[0])) throw new Error('There is nothing to print')

  // Millimeters on paper per model unit, and where the drawing's center goes.
  const room: Point = [width - 2 * margin, height - 2 * margin]
  const size: Point = [Math.max(max[0] - min[0], 1e-12), Math.max(max[1] - min[1], 1e-12)]
  const k = options.scale && !perspective ? millimetersPer(doc.units) / options.scale : Math.min(room[0] / size[0], room[1] / size[1])
  const center: Point = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]
  const toPaper = ([x, y]: Point): Point => [width / 2 + (x - center[0]) * k, height / 2 + (y - center[1]) * k]

  const items: SheetItem[] = []
  for (const layer of doc.layers) {
    const entry = byLayer.get(layer.id)
    if (!entry) continue
    items.push({
      lines: entry.lines.map((line) => line.map(toPaper)),
      fills: entry.fills.map((region) => region.map((loop) => loop.map(toPaper))),
      color: options.black ? '#000000' : layer.color,
      width: layer.printWidth || DEFAULT_PRINT_WIDTH,
      dashes: dashesOf(layer.linetype),
    })
  }
  return { width, height, items, clip: [margin, margin, room[0], room[1]] }
}
