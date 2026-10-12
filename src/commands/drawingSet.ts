import { Box3, Vector3 } from 'three'
import type { Geometry } from '../core/geometry'
import { wireframe } from '../core/geometry'
import { drawingArea, STANDARD_SCALES, sheetSize, view, type Detail, type Layout } from '../core/layout'
import { millimetersPer } from '../core/units'
import { buildingGeometry, drawElevations, modelBox } from './buildingViews'
import { layerNamed } from './drawing'
import type { Command, CommandContext } from './runner'

/**
 * DrawingSet: the building's drawings laid out on sheets in one go, each with its title block: the
 * plan of the current level (cut 1.2 above its floor), the four elevations, and any sections drawn
 * with Section. Elevations are drawn first if there are none. The sheets are ordinary layouts, to
 * adjust, print or export to PDF.
 */

/** Height of the plan cut above the floor (1.2 m in millimeters). */
const PLAN_CUT = 1200
const PAPER = 'A3'

const memory = { project: '' }

/** The drawings on some layers, by group: each group's objects and their extent. */
function drawingGroups(ctx: CommandContext, layers: string[]): Box3[] {
  const { doc } = ctx
  const groups = new Map<number, Box3>()
  for (const obj of doc.objects.values()) {
    if (!layers.includes(doc.layerOf(obj).name) || !doc.isVisible(obj)) continue
    const key = obj.groups?.[0] ?? -obj.id
    const box = groups.get(key) ?? new Box3()
    for (const line of wireframe(obj.geometry)) for (const p of line) box.expandByPoint(p)
    groups.set(key, box)
  }
  return [...groups.values()].filter((b) => !b.isEmpty()).sort((a, b) => b.min.y - a.min.y || a.min.x - b.min.x)
}

/** The horizontal clipping plane that cuts the current level's plan (made if missing, Top view only). */
function planCut(ctx: CommandContext, building: Box3): number {
  const { doc } = ctx
  const z = doc.level.elevation + PLAN_CUT
  const layer = layerNamed(ctx, 'Plan Cut', '#c0392b')
  const existing = [...doc.objects.values()].find((o) => o.layerId === layer.id && o.geometry.type === 'clipping' && Math.abs(o.geometry.center.z - z) < 1)
  if (existing) return existing.id
  const size = building.getSize(new Vector3())
  const centre = building.getCenter(new Vector3())
  return doc.add(
    {
      type: 'clipping',
      center: new Vector3(centre.x, centre.y, z),
      xaxis: new Vector3(1, 0, 0),
      // x × (−y) points down: what lies below the cut is kept.
      yaxis: new Vector3(0, -1, 0),
      width: size.x * 1.2 + 1,
      height: size.y * 1.2 + 1,
      views: ['Top'],
    },
    layer.id,
  ).id
}

/** Details laid out in a grid over a sheet's drawing area, all at one standard scale that fits them. */
function gridDetails(ctx: CommandContext, boxes: Box3[], clipping: boolean, titles: string[]): Detail[] {
  const [w, h] = sheetSize({ paper: PAPER, landscape: true })
  const [ax, ay, aw, ah] = drawingArea(w, h)
  const cols = boxes.length <= 1 ? 1 : 2
  const rows = Math.ceil(boxes.length / cols)
  const gap = 10
  const cw = (aw - gap * (cols - 1)) / cols
  const ch = (ah - gap * (rows - 1)) / rows
  const mm = millimetersPer(ctx.doc.units)
  const needed = Math.max(...boxes.map((b) => Math.max(((b.max.x - b.min.x) * mm) / (cw * 0.9), ((b.max.y - b.min.y) * mm) / (ch * 0.85))), 1e-9)
  const scale = STANDARD_SCALES.find((s) => s >= needed) ?? Math.ceil(needed / 1000) * 1000
  return boxes.map((b, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const centre = b.getCenter(new Vector3())
    // The detail as big as its drawing (with a margin), in the middle of its cell, so drawings
    // beside it in the model do not show.
    const dw = Math.min(cw, (((b.max.x - b.min.x) * mm) / scale) * 1.08 + 4)
    const dh = Math.min(ch, (((b.max.y - b.min.y) * mm) / scale) * 1.08 + 4)
    const x = ax + col * (cw + gap) + (cw - dw) / 2
    const y = ay + (rows - 1 - row) * (ch + gap) + (ch - dh) / 2
    return {
      id: i + 1,
      rect: [x, y, dw, dh],
      view: view('Top'),
      target: [centre.x, centre.y, centre.z],
      scale,
      hidden: false,
      title: titles[i] ?? '',
      clipping,
    }
  })
}

const drawingSet: Command = {
  name: 'DrawingSet',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const building = buildingGeometry(ctx)
    if (building.length === 0) throw new Error('There is nothing to draw: model the building first')
    const project = (await input.getString(`Project name <${memory.project || 'Project'}>`))?.trim() || memory.project || 'Project'
    memory.project = project
    const box = modelBox(building as Geometry[])
    // The plan: the building cut above the current level's floor.
    planCut(ctx, box)
    if (drawingGroups(ctx, ['Elevations', 'Elevations Cut']).length === 0) {
      log('Drawing the elevations first…')
      await drawElevations(ctx)
    }
    const elevations = drawingGroups(ctx, ['Elevations', 'Elevations Cut'])
    const sections = drawingGroups(ctx, ['Sections', 'Sections Cut', 'Sections Fill'])
    // The plan reaches out to the section marks and door swings round the building.
    const plan = new Box3(new Vector3(box.min.x, box.min.y, doc.level.elevation), new Vector3(box.max.x, box.max.y, doc.level.elevation))
    for (const marks of drawingGroups(ctx, ['Section Marks', 'Plan Symbols'])) {
      plan.expandByPoint(new Vector3(marks.min.x, marks.min.y, doc.level.elevation))
      plan.expandByPoint(new Vector3(marks.max.x, marks.max.y, doc.level.elevation))
    }

    let id = doc.layouts.reduce((max, l) => Math.max(max, l.id), 0)
    const today = new Date().toISOString().slice(0, 10)
    const sheets: { name: string; details: Detail[] }[] = [
      { name: `Plan, ${doc.level.name}`, details: gridDetails(ctx, [plan], true, [`Plan, ${doc.level.name}`]) },
      { name: 'Elevations', details: gridDetails(ctx, elevations, false, []) },
      ...(sections.length > 0 ? [{ name: sections.length === 1 ? 'Section' : 'Sections', details: gridDetails(ctx, sections, false, []) }] : []),
    ]
    const made: Layout[] = sheets.map((s, i) => ({
      id: ++id,
      name: s.name,
      paper: PAPER,
      landscape: true,
      details: s.details,
      titleBlock: { project, title: s.name, number: `A-${String(i + 1).padStart(2, '0')}`, author: '', date: today },
    }))
    doc.setLayouts([...doc.layouts, ...made])
    display.showLayout(made[0].id)
    log(`${made.length} sheets made (${made.map((l) => l.name).join(', ')}). Export them with ExportPDF`)
  },
}

export const drawingSetCommands: Command[] = [drawingSet]
