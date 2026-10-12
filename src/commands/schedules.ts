import { Box3, Vector3 } from 'three'
import { wallParams } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { domain, isCurve, isClosed, pointAt, wireframe } from '../core/geometry'
import { areaInside, levelName, openingSchedule, openingTypes, roomSchedule, tableGeometry, type ScheduledOpening, type ScheduledRoom, type Table } from '../core/schedules'
import { millimetersPer } from '../core/units'
import { quantityTable, sumQuantities } from '../core/quantities'
import { quantityItems } from './quantities'
import { areaUnits } from './architecture'
import { buildingGeometry, modelBox } from './buildingViews'
import { layerNamed } from './drawing'
import { isOption } from './helpers'
import type { Command, CommandContext } from './runner'

/**
 * Schedule: the doors and windows table and the rooms table, drawn in the model on a Schedules
 * layer, each grouped, for layout details. Each keeps how it was made on its title, so
 * UpdateDrawings makes it again in place from the model as it is.
 */

export type ScheduleKind = 'openings' | 'rooms' | 'quantities'

/** The doors and windows in the model's walls, with their walls' levels. */
function scheduledOpenings(ctx: CommandContext): ScheduledOpening[] {
  const { doc } = ctx
  const out: ScheduledOpening[] = []
  for (const obj of doc.objects.values()) {
    if (obj.history?.command !== 'Wall') continue
    const path = doc.objects.get(obj.history.inputs[0])?.geometry
    const z = path && isCurve(path) ? pointAt(path, domain(path)[0]).z : 0
    const level = levelName(doc.levels, z)
    for (const opening of wallParams(obj.history.params).openings) out.push({ opening, level })
  }
  return out
}

/** The rooms labelled with Room: each label's name and the area inside the outlines grouped with it. */
function scheduledRooms(ctx: CommandContext): ScheduledRoom[] {
  const { doc } = ctx
  const rooms = doc.layers.find((l) => l.name === 'Rooms')
  if (!rooms) return []
  const out: ScheduledRoom[] = []
  for (const obj of doc.objects.values()) {
    const g = obj.geometry
    if (obj.layerId !== rooms.id || g.type !== 'annotation' || g.kind !== 'text') continue
    const group = obj.groups?.[0]
    const loops = group === undefined ? [] : [...doc.objects.values()].filter((o) => o.groups?.includes(group) && isCurve(o.geometry) && isClosed(o.geometry as AnyCurve)).map((o) => o.geometry as AnyCurve)
    // Without its outlines, the area written on the label.
    const written = Number(/([\d.]+)\s*\S*$/.exec(g.text.split('\n')[1] ?? '')?.[1] ?? NaN)
    const area = loops.length > 0 ? areaInside(loops) : Number.isFinite(written) ? written / areaUnits(doc.units).factor : 0
    out.push({ name: g.text.split('\n')[0], level: levelName(doc.levels, g.points[0].z), area })
  }
  return out
}

/** A schedule's table from the model as it is, or null if there is nothing for it. */
export function scheduleTable(ctx: CommandContext, kind: ScheduleKind): Table | null {
  const { doc } = ctx
  if (kind === 'openings') {
    const openings = scheduledOpenings(ctx)
    return openings.length > 0 ? openingSchedule(openingTypes(openings, doc.levels), millimetersPer(doc.units)) : null
  }
  if (kind === 'quantities') {
    const rows = sumQuantities(quantityItems(ctx), doc.levels.map((l) => l.name))
    return rows.length > 0 ? quantityTable(rows) : null
  }
  const rooms = scheduledRooms(ctx)
  const units = areaUnits(doc.units)
  return rooms.length > 0 ? roomSchedule(rooms, doc.levels, units.factor, units.name) : null
}

/** Draws a schedule with its top left corner at a point; returns its objects' ids (the title first). */
function placeSchedule(ctx: CommandContext, kind: ScheduleKind, table: Table, at: Vector3, height: number): number[] {
  const { doc } = ctx
  const layer = layerNamed(ctx, 'Schedules', '#000000')
  const ids = tableGeometry(table, at, height).map((g) => doc.add(g, layer.id).id)
  doc.setHistory(ids[0], { command: 'ScheduleTable', inputs: [], params: { kind, at: at.toArray(), height } })
  doc.group(ids)
  return ids
}

/** The extent of objects, in plan. */
function extentOf(ctx: CommandContext, ids: number[]): Box3 {
  const box = new Box3()
  for (const id of ids) {
    const g = ctx.doc.objects.get(id)?.geometry
    if (g) for (const line of wireframe(g)) for (const p of line) box.expandByPoint(p)
  }
  return box
}

/**
 * Draws the schedules there is something for, side by side over the model (or from `at`). Returns
 * the kinds drawn.
 */
export function drawSchedules(ctx: CommandContext, kinds: ScheduleKind[] = ['openings', 'rooms'], at?: Vector3): ScheduleKind[] {
  const building = buildingGeometry(ctx)
  const model = building.length > 0 ? modelBox(building) : new Box3(new Vector3(), new Vector3(10000, 10000, 3000))
  const size = model.getSize(new Vector3())
  const largest = Math.max(size.x, size.y, size.z, 1)
  // Text as in plan drawings: readable at the scales a building is drawn at.
  const height = Math.min(largest * 0.012, 250 / millimetersPer(ctx.doc.units))
  const tables = kinds.flatMap((kind) => {
    const table = scheduleTable(ctx, kind)
    return table ? [{ kind, table }] : []
  })
  if (tables.length === 0) return []
  const gap = largest * 0.15
  const rows = Math.max(...tables.map((t) => t.table.rows.length + 1))
  const start = at ?? new Vector3(model.min.x, model.max.y + gap + rows * height * 2, 0)
  let x = start.x
  for (const { kind, table } of tables) {
    const ids = placeSchedule(ctx, kind, table, new Vector3(x, start.y, start.z), height)
    x = extentOf(ctx, ids).max.x + gap * 0.5
  }
  return tables.map((t) => t.kind)
}

/** Makes every schedule again in its place from the model as it is; returns how many. */
export function updateSchedules(ctx: CommandContext): number {
  const { doc } = ctx
  let made = 0
  for (const title of [...doc.objects.values()].filter((o) => o.history?.command === 'ScheduleTable')) {
    const { kind, at, height } = title.history!.params as { kind: ScheduleKind; at: [number, number, number]; height: number }
    const group = title.groups?.[0]
    const old = group === undefined ? [title.id] : [...doc.objects.values()].filter((o) => o.groups?.includes(group)).map((o) => o.id)
    for (const id of old) doc.remove(id)
    const table = scheduleTable(ctx, kind)
    if (!table) continue
    placeSchedule(ctx, kind, table, new Vector3(...at), height)
    made++
  }
  return made
}

const schedule: Command = {
  name: 'Schedule',
  async run(ctx) {
    const { input, log } = ctx
    const option = await input.getOption('Schedule to draw', ['Openings', 'Rooms', 'Quantities', 'Both'])
    if (option === null) return
    const kinds: ScheduleKind[] = isOption(option, 'Openings') ? ['openings'] : isOption(option, 'Rooms') ? ['rooms'] : isOption(option, 'Quantities') ? ['quantities'] : ['openings', 'rooms']
    const missing: Record<ScheduleKind, string> = { openings: 'There are no doors or windows in walls', rooms: 'There are no rooms labelled with Room', quantities: 'There are no building elements to measure' }
    for (const kind of kinds) if (!scheduleTable(ctx, kind)) log(missing[kind])
    if (!kinds.some((k) => scheduleTable(ctx, k))) return
    const r = await input.getPoint({ prompt: 'Top left corner of the schedule <over the model>' })
    const drawn = drawSchedules(ctx, kinds, r.kind === 'point' ? r.point : undefined)
    const names: Record<ScheduleKind, string> = { openings: 'Doors and windows', rooms: 'Rooms', quantities: 'Quantities' }
    log(`${drawn.map((k) => names[k]).join(' and ')} schedule${drawn.length > 1 ? 's' : ''} drawn. UpdateDrawings makes them again from the model`)
  },
}

export const scheduleCommands: Command[] = [schedule]

