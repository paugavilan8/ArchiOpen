import { Box3, Matrix4, Vector3 } from 'three'
import { flatten } from '../core/blocks'
import { drawingClipPlanes } from '../core/clipPlanes'
import { transform } from '../core/curves'
import { AnyCurve, expandBox, HatchGeometry, isCurve, tessellate } from '../core/geometry'
import type { Layer } from '../core/document'
import { kernelJob } from '../kernel/client'
import type { Drawing2D, DrawingView } from '../kernel/make2d'
import { shapeRef } from '../kernel/wire'
import type { Viewport } from '../view/viewport'
import { isOption, plural, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'
import { kernel, readable } from './solids'

const VIEWS = ['CurrentView', 'Top', 'Front', 'Right', 'Back', 'Left', 'FourView'] as const
type ViewChoice = (typeof VIEWS)[number]

const memory: { view: ViewChoice; hidden: boolean; clipping: boolean; fill: boolean } = { view: 'CurrentView', hidden: false, clipping: true, fill: true }

const FIXED: Record<string, DrawingView> = {
  Top: { direction: new Vector3(0, 0, 1), xaxis: new Vector3(1, 0, 0) },
  Front: { direction: new Vector3(0, -1, 0), xaxis: new Vector3(1, 0, 0) },
  Right: { direction: new Vector3(1, 0, 0), xaxis: new Vector3(0, 1, 0) },
  Back: { direction: new Vector3(0, 1, 0), xaxis: new Vector3(-1, 0, 0) },
  Left: { direction: new Vector3(-1, 0, 0), xaxis: new Vector3(0, -1, 0) },
}

/** How a viewport looks at the model. Perspective views are drawn as parallel projections. */
function viewOf(vp: Viewport): DrawingView {
  vp.camera.updateMatrixWorld()
  return {
    direction: vp.camera.getWorldDirection(new Vector3()).negate(),
    xaxis: new Vector3().setFromMatrixColumn(vp.camera.matrixWorld, 0),
  }
}

function boundsOf(curves: AnyCurve[]): Box3 {
  const box = new Box3()
  for (const c of curves) for (const p of tessellate(c)) box.expandByPoint(p)
  return box
}

const shift = (drawing: Drawing2D, offset: Vector3): Drawing2D => {
  const m = new Matrix4().makeTranslation(offset.x, offset.y, 0)
  const move = (c: AnyCurve) => transform(c, m) as AnyCurve
  return {
    visible: drawing.visible.map(move),
    hidden: drawing.hidden.map(move),
    section: drawing.section?.map(move),
    fills: drawing.fills?.map((loops) => loops.map((loop) => loop.map((p) => p.clone().add(offset)))),
  }
}

/** The layer with this name, created if missing. */
function layerNamed(ctx: CommandContext, name: string, color: string, linetype?: string, printWidth?: number): Layer {
  const existing = ctx.doc.layers.find((l) => l.name === name)
  if (existing) return existing
  const layer = ctx.doc.addLayer()
  ctx.doc.updateLayer(layer.id, { name, color, linetype, ...(printWidth ? { printWidth } : {}) })
  return layer
}

/** A solid hatch over a cut face: its outline loops in the drawing's plane, moved by m. */
function sectionFill(loops: Vector3[][], m: Matrix4): HatchGeometry {
  return {
    type: 'hatch',
    loops: loops.map((loop) => ({ type: 'polyline', points: loop.map((p) => p.clone().applyMatrix4(m)), closed: true })),
    pattern: 'Solid',
    scale: 1,
    rotation: 0,
    origin: new Vector3().applyMatrix4(m),
    xaxis: new Vector3(1, 0, 0),
    yaxis: new Vector3(0, 1, 0),
  }
}

/** Print width of Make2D's cut lines, in millimeters. */
const SECTION_PEN = 0.5

/**
 * Lays out the drawings of the views. A single view keeps its own coordinates; four views are
 * arranged as in third-angle projection: Front, Top above it, Right beside it and the perspective
 * view in the remaining corner, with Front and Top sharing X and Front and Right sharing height.
 */
function arrange(drawings: Drawing2D[], gap: number): Drawing2D[] {
  if (drawings.length === 1) return drawings
  const [front, top, right, persp] = drawings
  const box = (d: Drawing2D) => boundsOf([...d.visible, ...d.hidden, ...(d.section ?? [])])
  const [bf, bt, br, bp] = [front, top, right, persp].map(box)
  const fx = bf.isEmpty() ? 0 : bf.max.x
  const fy = bf.isEmpty() ? 0 : bf.max.y
  const rightX = bf.isEmpty() || br.isEmpty() ? 0 : fx + gap - br.min.x
  const topY = bf.isEmpty() || bt.isEmpty() ? 0 : fy + gap - bt.min.y
  const perspAt = new Vector3(
    br.isEmpty() ? fx + gap : br.min.x + rightX,
    bt.isEmpty() ? fy + gap : bt.min.y + topY,
  )
  return [
    front,
    shift(top, new Vector3(0, topY)),
    shift(right, new Vector3(rightX, 0)),
    bp.isEmpty() ? persp : shift(persp, perspAt.sub(bp.min)),
  ]
}

const make2d: Command = {
  name: 'Make2D',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = await input.getObjects('Select objects to draw')
    // Blocks are drawn from what they hold.
    const objects = ids.flatMap((id) => flatten(doc.objects.get(id)!.geometry)).filter((g) => g.type !== 'clipping')

    const model = new Box3()
    for (const g of objects) {
      if (g.type === 'brep') for (let i = 0; i < g.display.vertices.length; i += 3) model.expandByPoint(new Vector3().fromArray(g.display.vertices, i))
      else expandBox(model, g)
    }
    const size = model.getSize(new Vector3())
    const gap = Math.max(size.x, size.y, size.z, 1e-6) * 0.25

    const planes = drawingClipPlanes(doc, display.active.kind)
    let location: Vector3 | null = null
    for (;;) {
      const result = await input.getPoint({
        prompt: 'Lower left corner of the drawing <beside the model>',
        // Clipping planes on in the active viewport cut the drawing (plans and sections).
        options: [`View=${memory.view}`, yesNo('HiddenLines', memory.hidden), ...(planes.length > 0 ? [yesNo('Clipping', memory.clipping), yesNo('SectionFill', memory.fill)] : [])],
      })
      if (result.kind === 'option') {
        if (isOption(result.option, 'View')) memory.view = VIEWS[(VIEWS.indexOf(memory.view) + 1) % VIEWS.length]
        else if (isOption(result.option, 'HiddenLines')) memory.hidden = !memory.hidden
        else if (isOption(result.option, 'Clipping')) memory.clipping = !memory.clipping
        else if (isOption(result.option, 'SectionFill')) memory.fill = !memory.fill
        continue
      }
      if (result.kind === 'point') location = result.point
      else if (result.kind !== 'enter') return
      break
    }

    const perspective = display.viewports.find((vp) => vp.kind === 'Perspective') ?? display.active
    const views: DrawingView[] =
      memory.view === 'FourView'
        ? [FIXED.Front, FIXED.Top, FIXED.Right, viewOf(perspective)]
        : [memory.view === 'CurrentView' ? viewOf(display.active) : FIXED[memory.view]]

    await kernel(ctx)
    const surfaces = objects.filter((g) => g.type === 'brep')
    const shapes = surfaces.map(shapeRef)
    const curves = objects.filter(isCurve)
    const meshes = objects.filter((g) => g.type === 'mesh')
    const views2D: Drawing2D[] = []
    const clip = memory.clipping ? planes : []
    for (const view of views) views2D.push(await readable(kernelJob('make2DWithMeshes', shapes, surfaces, curves, meshes, view, memory.hidden, clip), 'compute the drawing'))
    const drawings = arrange(views2D, gap)

    const all = drawings.flatMap((d) => [...d.visible, ...d.hidden, ...(d.section ?? [])])
    if (all.length === 0) {
      log('Nothing to draw')
      return
    }
    const box = boundsOf(all)
    const corner = location ?? new Vector3(model.max.x + gap, model.min.y, 0)
    const offset = new Vector3(corner.x - box.min.x, corner.y - box.min.y, corner.z)
    const m = new Matrix4().makeTranslation(offset.x, offset.y, offset.z)

    const visibleLayer = layerNamed(ctx, 'Make2D Visible', '#000000')
    const hiddenLayer = memory.hidden ? layerNamed(ctx, 'Make2D Hidden', '#8c8c8c', 'Hidden') : null
    // Cut lines go on a layer of their own, printed with a heavier pen.
    const sectionLayer = drawings.some((d) => d.section?.length) ? layerNamed(ctx, 'Make2D Section', '#000000', undefined, SECTION_PEN) : null
    // Cut faces are filled solid on a layer of their own, so their shade is the layer's color.
    const fillLayer = memory.fill && drawings.some((d) => d.fills?.length) ? layerNamed(ctx, 'Make2D Section Fill', '#5a5a5a') : null
    const created: number[] = []
    for (const d of drawings) {
      for (const c of d.visible) created.push(doc.add(transform(c, m), visibleLayer.id).id)
      if (sectionLayer) for (const c of d.section ?? []) created.push(doc.add(transform(c, m), sectionLayer.id).id)
      if (fillLayer) for (const loops of d.fills ?? []) created.push(doc.add(sectionFill(loops, m), fillLayer.id).id)
      if (hiddenLayer) for (const c of d.hidden) created.push(doc.add(transform(c, m), hiddenLayer.id).id)
    }
    doc.select(created)
    const layers = [visibleLayer, sectionLayer, fillLayer, hiddenLayer].filter((l) => l !== null).map((l) => l.name)
    const fills = created.filter((id) => doc.objects.get(id)?.geometry.type === 'hatch').length
    const made = fills > 0 ? `${plural('curve', created.length - fills)} and ${plural('fill', fills)}` : plural('curve', created.length)
    log(`${made} drawn on layer${layers.length > 1 ? 's' : ''} ${layers.join(', ')}`)
  },
}

export const drawingCommands: Command[] = [make2d]
