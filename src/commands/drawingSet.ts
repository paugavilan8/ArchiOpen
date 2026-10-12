import { Box3, Vector3 } from 'three'
import type { Geometry } from '../core/geometry'
import { clippingNormal, wireframe } from '../core/geometry'
import type { Level } from '../core/architecture'
import { drawingArea, STANDARD_SCALES, sheetSize, view, type Detail, type Layout } from '../core/layout'
import { millimetersPer } from '../core/units'
import { buildingGeometry, drawElevations, modelBox } from './buildingViews'
import { layerNamed } from './drawing'
import type { Command, CommandContext } from './runner'

/**
 * DrawingSet: the building's drawings laid out on sheets in one go, each with its title block: a
 * plan of each level with something in it (cut 1.2 above its floor, without the levels under it),
 * the four elevations, and any sections drawn with Section. Elevations are drawn first if there are none. The sheets are ordinary layouts, to
 * adjust, print or export to PDF.
 */

/** Height of the plan cut above the floor (1.2 m in millimeters). */
const PLAN_CUT = 1200
/**
 * How far above a level's floor its plan starts: just above, so the tops of the walls and slabs of
 * the level under it (which reach its floor) are left out.
 */
const ABOVE_FLOOR = 1
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

/** A horizontal clipping plane on the 'Plan Cut' layer at a height (made if missing, cutting no view). */
function horizontalCut(ctx: CommandContext, building: Box3, z: number, keepBelow: boolean): number {
  const { doc } = ctx
  const layer = layerNamed(ctx, 'Plan Cut', '#c0392b')
  const existing = [...doc.objects.values()].find(
    (o) => o.layerId === layer.id && o.geometry.type === 'clipping' && Math.abs(o.geometry.center.z - z) < 1 && clippingNormal(o.geometry).z < 0 === keepBelow,
  )
  if (existing) return existing.id
  const size = building.getSize(new Vector3())
  const centre = building.getCenter(new Vector3())
  return doc.add(
    {
      type: 'clipping',
      center: new Vector3(centre.x, centre.y, z),
      xaxis: new Vector3(1, 0, 0),
      // x × (−y) points down: what lies below the cut is kept; x × y keeps what lies above.
      yaxis: new Vector3(0, keepBelow ? -1 : 1, 0),
      width: size.x * 1.2 + 1,
      height: size.y * 1.2 + 1,
      // Only the plan details are cut, by these planes by name: the views on screen stay whole.
      views: [],
    },
    layer.id,
  ).id
}

/**
 * The planes that cut a level's plan: 1.2 above its floor, and (above the lowest level) just above
 * its floor, so the levels under it are left out.
 */
function planCuts(ctx: CommandContext, building: Box3, level: Level, lowest: boolean): number[] {
  const cuts = [horizontalCut(ctx, building, level.elevation + PLAN_CUT, true)]
  if (!lowest) cuts.push(horizontalCut(ctx, building, level.elevation + ABOVE_FLOOR, false))
  return cuts
}

/** The levels with something of the building in them (the current one if none has). */
export function levelsWithBuilding(levels: readonly Level[], current: Level, building: Geometry[]): Level[] {
  const boxes = building.map((g) => modelBox([g])).filter((b) => !b.isEmpty())
  const used = levels.filter((level, i) => {
    const top = levels[i + 1]?.elevation ?? Infinity
    // Something reaching above the floor (more than a slab's top face) and starting below the next.
    return boxes.some((b) => b.max.z > level.elevation + 1 && b.min.z < top - 1)
  })
  return used.length > 0 ? used : [current]
}

/** Details laid out in a grid over a sheet's drawing area, all at one standard scale that fits them. */
function gridDetails(ctx: CommandContext, boxes: Box3[], clipPlanes: number[] | null, titles: string[]): Detail[] {
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
      // Plans with hidden lines removed, so their cut is drawn (outlined and filled).
      hidden: clipPlanes !== null,
      title: titles[i] ?? '',
      clipping: clipPlanes !== null,
      ...(clipPlanes ? { clipPlanes } : {}),
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
    if (drawingGroups(ctx, ['Elevations', 'Elevations Cut']).length === 0) {
      log('Drawing the elevations first…')
      await drawElevations(ctx)
    }
    const elevations = drawingGroups(ctx, ['Elevations', 'Elevations Cut'])
    const sections = drawingGroups(ctx, ['Sections', 'Sections Cut', 'Sections Fill'])
    // A plan for each level with something in it, the building cut above its floor. Each reaches out
    // to the section marks and door swings round the building; all are at the same scale.
    const marks = drawingGroups(ctx, ['Section Marks', 'Plan Symbols'])
    const levels = levelsWithBuilding(doc.levels, doc.level, building as Geometry[])
    const lowest = doc.levels[0]
    const plans = levels.map((level) => {
      const plan = new Box3(new Vector3(box.min.x, box.min.y, level.elevation), new Vector3(box.max.x, box.max.y, level.elevation))
      for (const m of marks) {
        plan.expandByPoint(new Vector3(m.min.x, m.min.y, level.elevation))
        plan.expandByPoint(new Vector3(m.max.x, m.max.y, level.elevation))
      }
      return { level, plan, cuts: planCuts(ctx, box, level, level === lowest) }
    })
    // Every plan sized to fit the largest, so they share a scale.
    const size = plans.reduce((max, p) => max.max(p.plan.getSize(new Vector3())), new Vector3())
    const planSheets = plans.map(({ level, plan, cuts }) => {
      const sized = new Box3().setFromCenterAndSize(plan.getCenter(new Vector3()), size)
      const name = `Plan, ${level.name}`
      return { name, details: gridDetails(ctx, [sized], cuts, [name]) }
    })

    let id = doc.layouts.reduce((max, l) => Math.max(max, l.id), 0)
    const today = new Date().toISOString().slice(0, 10)
    const sheets: { name: string; details: Detail[] }[] = [
      ...planSheets,
      { name: 'Elevations', details: gridDetails(ctx, elevations, null, []) },
      ...(sections.length > 0 ? [{ name: sections.length === 1 ? 'Section' : 'Sections', details: gridDetails(ctx, sections, null, []) }] : []),
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
