import { Box3, Matrix4, Vector3 } from 'three'
import { flatten } from '../core/blocks'
import type { ClipPlane } from '../core/clipPlanes'
import { transform } from '../core/curves'
import type { AnyCurve, AnnotationGeometry, Geometry } from '../core/geometry'
import { kernelJob } from '../kernel/client'
import type { Drawing2D, DrawingView } from '../kernel/make2d'
import { shapeRef } from '../kernel/wire'
import { textShape } from '../text/strokeFont'
import { boundsOf, layerNamed, SECTION_PEN, sectionFill } from './drawing'
import type { Command, CommandContext } from './runner'
import { kernel, readable } from './solids'

/**
 * Building views for drawings: the four elevations of the model, and sections along a line drawn
 * in plan, each with a ground line and a title, laid out beside the model ready for layouts. A
 * section also gets its section mark in plan.
 */

const UP = new Vector3(0, 0, 1)

/** Layers that hold drawings and notes rather than the building, left out of its views. */
const NOT_BUILDING = new Set(['Construction', 'Plan Symbols', 'Dimensions', 'Rooms', 'Elevations', 'Sections', 'Section Marks'])

/** The solids and surfaces of the building that are shown (blocks drawn from what they hold). */
export function buildingGeometry(ctx: CommandContext): Geometry[] {
  const { doc } = ctx
  return [...doc.objects.values()]
    .filter((o) => doc.isVisible(o) && !NOT_BUILDING.has(doc.layerOf(o).name) && !doc.layerOf(o).name.startsWith('Make2D'))
    .flatMap((o) => flatten(o.geometry))
    .filter((g) => g.type === 'brep' || g.type === 'mesh')
}

export function modelBox(objects: Geometry[]): Box3 {
  const box = new Box3()
  for (const g of objects) {
    const v = g.type === 'brep' ? g.display.vertices : g.type === 'mesh' ? g.vertices : []
    for (let i = 0; i < v.length; i += 3) box.expandByPoint(new Vector3(v[i], v[i + 1], v[i + 2]))
  }
  return box
}

/** A view looking along a horizontal direction (`look`), as a drawing view (direction to the viewer). */
function lookingAlong(look: Vector3): DrawingView {
  const direction = look.clone().setZ(0).normalize().negate()
  return { direction, xaxis: UP.clone().cross(direction).normalize() }
}

async function draw(ctx: CommandContext, objects: Geometry[], view: DrawingView, clip: ClipPlane[]): Promise<Drawing2D> {
  const surfaces = objects.filter((g) => g.type === 'brep')
  const meshes = objects.filter((g) => g.type === 'mesh')
  return readable(kernelJob('make2DWithMeshes', surfaces.map(shapeRef), surfaces, [], meshes, view, false, clip), 'compute the drawing')
}

/** Text, centred on a point, of a height. */
function title(text: string, at: Vector3, height: number): AnnotationGeometry {
  const width = Math.max(...textShape(text).widths) * height
  return { type: 'annotation', kind: 'text', points: [new Vector3(at.x - width / 2, at.y, at.z)], xaxis: new Vector3(1, 0, 0), yaxis: new Vector3(0, 1, 0), text, height, arrow: 'arrow', precision: 0 }
}

/**
 * Adds a drawing at an offset with its ground line (at the drawing's height of the model's lowest
 * level) and a title under it; returns the new objects' ids.
 */
function place(ctx: CommandContext, drawing: Drawing2D, offset: Vector3, ground: number, name: string, layerName: string, textHeight: number): number[] {
  const { doc } = ctx
  const m = new Matrix4().makeTranslation(offset.x, offset.y, offset.z)
  const lines = layerNamed(ctx, layerName, '#000000')
  const cut = drawing.section?.length ? layerNamed(ctx, `${layerName} Cut`, '#000000', undefined, SECTION_PEN) : null
  const fill = drawing.fills?.length ? layerNamed(ctx, `${layerName} Fill`, '#5a5a5a') : null
  const ids: number[] = []
  for (const c of drawing.visible) ids.push(doc.add(transform(c, m), lines.id).id)
  if (cut) for (const c of drawing.section ?? []) ids.push(doc.add(transform(c, m), cut.id).id)
  if (fill) for (const loops of drawing.fills ?? []) ids.push(doc.add(sectionFill(loops, m), fill.id).id)
  const box = boundsOf([...drawing.visible, ...(drawing.section ?? [])])
  const reach = (box.max.x - box.min.x) * 0.08
  const y = ground + offset.y
  ids.push(doc.add({ type: 'polyline', points: [new Vector3(box.min.x - reach + offset.x, y, 0), new Vector3(box.max.x + reach + offset.x, y, 0)], closed: false } as AnyCurve, cut?.id ?? lines.id).id)
  ids.push(doc.add(title(name, new Vector3((box.min.x + box.max.x) / 2 + offset.x, y - textHeight * 3, 0), textHeight), lines.id).id)
  doc.group(ids)
  return ids
}

const ELEVATIONS: { name: string; look: Vector3 }[] = [
  { name: 'South elevation', look: new Vector3(0, 1, 0) },
  { name: 'East elevation', look: new Vector3(-1, 0, 0) },
  { name: 'North elevation', look: new Vector3(0, -1, 0) },
  { name: 'West elevation', look: new Vector3(1, 0, 0) },
]

/** Draws the four elevations under the model; returns the new objects' ids. */
export async function drawElevations(ctx: CommandContext): Promise<number[]> {
  const objects = buildingGeometry(ctx)
  if (objects.length === 0) throw new Error('There is nothing to draw: model the building first')
  const model = modelBox(objects)
  const size = model.getSize(new Vector3())
  const gap = Math.max(size.x, size.y, size.z) * 0.3
  const textHeight = Math.max(size.x, size.y, size.z) * 0.025
  await kernel(ctx)
  const drawings = []
  for (const e of ELEVATIONS) drawings.push({ ...e, drawing: await draw(ctx, objects, lookingAlong(e.look), []) })
  // In a row under the model, their ground lines level with each other.
  const boxes = drawings.map((d) => boundsOf([...d.drawing.visible]))
  const tallest = Math.max(...boxes.map((b) => b.max.y))
  const ground = model.min.z
  let x = model.min.x
  const top = model.min.y - gap
  const made: number[] = []
  drawings.forEach((d, i) => {
    const b = boxes[i]
    if (b.isEmpty()) return
    const offset = new Vector3(x - b.min.x, top - tallest, 0)
    made.push(...place(ctx, d.drawing, offset, ground, d.name, 'Elevations', textHeight))
    x += b.max.x - b.min.x + gap
  })
  return made
}

const elevations: Command = {
  name: 'Elevations',
  async run(ctx) {
    const made = await drawElevations(ctx)
    ctx.doc.select(made)
    ctx.log(`4 elevations drawn under the model, on the Elevations layer`)
  },
}

/** The next free section letter (A, B, ...), from the marks already drawn. */
function nextLetter(ctx: CommandContext): string {
  const used = new Set(
    [...ctx.doc.objects.values()]
      .filter((o) => ctx.doc.layerOf(o).name === 'Section Marks' && o.geometry.type === 'annotation')
      .map((o) => (o.geometry as AnnotationGeometry).text),
  )
  for (let i = 0; i < 26; i++) if (!used.has(String.fromCharCode(65 + i))) return String.fromCharCode(65 + i)
  return `S${used.size + 1}`
}

const section: Command = {
  name: 'Section',
  async run(ctx) {
    const { doc, input, log } = ctx
    const objects = buildingGeometry(ctx)
    if (objects.length === 0) throw new Error('There is nothing to cut: model the building first')
    const a = await input.getPoint({ prompt: 'Start of section line' })
    if (a.kind !== 'point') return
    const b = await input.getPoint({ prompt: 'End of section line', base: a.point })
    if (b.kind !== 'point') return
    const along = b.point.clone().sub(a.point).setZ(0)
    if (along.length() < 1e-9) throw new Error('The section line has no length')
    along.normalize()
    const across = UP.clone().cross(along)
    const side = await input.getPoint({
      prompt: 'Side to look towards',
      base: a.point.clone().lerp(b.point, 0.5),
      preview: (p) => {
        const s = across.dot(p.clone().sub(a.point)) >= 0 ? across : across.clone().negate()
        const m = a.point.clone().lerp(b.point, 0.5)
        return [[a.point, b.point], [m, m.clone().addScaledVector(s, a.point.distanceTo(b.point) * 0.15)]]
      },
    })
    if (side.kind !== 'point') return
    const look = across.dot(side.point.clone().sub(a.point)) >= 0 ? across : across.clone().negate()
    const model = modelBox(objects)
    const size = model.getSize(new Vector3())
    const textHeight = Math.max(size.x, size.y, size.z) * 0.025
    const gap = Math.max(size.x, size.y, size.z) * 0.3
    // Keep what lies on the look side of the cut.
    const origin = new Vector3(a.point.x, a.point.y, model.min.z)
    const clip: ClipPlane = { normal: look.clone(), constant: -look.dot(origin), origin }
    await kernel(ctx)
    const drawing = await draw(ctx, objects, lookingAlong(look), [clip])
    const box = boundsOf([...drawing.visible, ...(drawing.section ?? [])])
    if (box.isEmpty()) {
      log('The section line does not cut or look at the building')
      return
    }
    const letter = nextLetter(ctx)
    // Beside the model, its ground line level with the model's floor.
    const offset = new Vector3(model.max.x + gap - box.min.x, model.min.y - box.min.y, 0)
    const made = place(ctx, drawing, offset, model.min.z, `Section ${letter}-${letter}`, 'Sections', textHeight)
    // The mark in plan: the cut line past the building, arrows to the look side and the letters.
    const marks = layerNamed(ctx, 'Section Marks', '#c0392b', 'Center')
    const z = model.min.z
    const ext = textHeight * 2
    const p0 = new Vector3(a.point.x, a.point.y, z).addScaledVector(along, -ext)
    const p1 = new Vector3(b.point.x, b.point.y, z).addScaledVector(along, ext)
    const ids = [doc.add({ type: 'polyline', points: [p0, p1], closed: false }, marks.id).id]
    for (const p of [p0, p1]) {
      const tip = p.clone().addScaledVector(look, textHeight * 2)
      ids.push(doc.add({ type: 'polyline', points: [p, tip, tip.clone().addScaledVector(look, -textHeight * 0.7).addScaledVector(along, textHeight * 0.4)], closed: false }, marks.id).id)
      ids.push(doc.add(title(letter, tip.clone().addScaledVector(look, textHeight * 0.6), textHeight), marks.id).id)
    }
    doc.group(ids)
    doc.select([...made, ...ids])
    log(`Section ${letter}-${letter} drawn beside the model, with its mark in plan`)
  },
}

export const buildingViewCommands: Command[] = [elevations, section]
