import { Vector3 } from 'three'
import {
  checkOpening,
  DEFAULT_OPENINGS,
  DEFAULT_SLAB,
  DEFAULT_WALL,
  lengthAtPoint,
  paramAtLength,
  slabParams,
  openingBox,
  wallOutline,
  wallParams,
  type Justification,
  type Level,
  type Opening,
  type SavedJoin,
  type SlabHole,
  type WallParams,
} from '../core/architecture'
import { formatValue, isOption, valueOption, yesNo } from './helpers'
import { nextOpeningId } from '../app/openingParts'
import { AnyCurve, isClosed, isCurve, pointAt, startPoint, tangentAt, tessellate } from '../core/geometry'
import type { HistoryRecord } from '../core/document'
import { kernelJob } from '../kernel/client'
import { LINE_SPACING, textShape } from '../text/strokeFont'
import { wallDimensions, type DimensionedWall } from '../core/autoDimensions'
import { MATERIAL_PRESETS } from '../core/materials'
import { DEFAULT_RAILING, type RailingSides, type RailingStyle } from '../core/railings'
import { columnOutline, comfortable, DEFAULT_COLUMN, DEFAULT_ROOF, DEFAULT_STAIR, roofPlan, stairFootprint, stairOutlines, stairParams, stairPlan, type RoofType } from '../core/buildingParts'
import { layerNamed } from './drawing'
import { kernel, readable } from './solids'
import type { Command, CommandContext } from './runner'

/**
 * Architectural commands: Level (the heights drawn at), Wall, Slab, Window and Door. Walls and slabs
 * are solids made from a path or outline curve that stays in the model (on the Construction layer):
 * editing the curve, or the wall's parameters in the Properties panel, makes them again.
 */

const memory = {
  thickness: DEFAULT_WALL.thickness,
  justification: DEFAULT_WALL.justification as Justification,
  slab: DEFAULT_SLAB.thickness,
  openings: { window: { ...DEFAULT_OPENINGS.window }, door: { ...DEFAULT_OPENINGS.door } },
  frame: true,
  hinge: 'start' as 'start' | 'end',
  roof: { ...DEFAULT_ROOF },
  stair: { width: DEFAULT_STAIR.width, risers: DEFAULT_STAIR.risers, opening: true },
  column: { ...DEFAULT_COLUMN },
  railing: { ...DEFAULT_RAILING },
  dimensions: { offset: 800, height: 200 },
  room: { height: 250 },
  floor: { thickness: 20, material: 'Wood' as (typeof FLOOR_MATERIALS)[number] },
  skirting: { height: 80, thickness: 15 },
}

const JUSTIFICATIONS: Justification[] = ['center', 'left', 'right']
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const construction = (ctx: CommandContext) => layerNamed(ctx, 'Construction', '#8c8c8c', 'Dashed')
const wallsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Walls', '#5b5b5b')
const slabsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Slabs', '#7a7a7a')
const roofsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Roofs', '#9c5a43')
const stairsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Stairs', '#6e6e6e')
const columnsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Columns', '#666666')
/** Railings go on their own layer, in brushed steel. */
const railingsLayer = (ctx: CommandContext) => {
  const layer = layerNamed(ctx, 'Railings', '#8d9399')
  if (!layer.material) {
    const steel = MATERIAL_PRESETS.find((m) => m.name === 'Brushed steel')!
    if (!ctx.doc.materials.some((m) => m.name === steel.name)) ctx.doc.setMaterials([...ctx.doc.materials, { ...steel }])
    ctx.doc.updateLayer(layer.id, { material: steel.name })
  }
  return layer
}

/** Is this object a wall (or slab), made from its curve? */
export const isWall = (ctx: CommandContext, id: number) => ctx.doc.objects.get(id)?.history?.command === 'Wall'

/** Moves every view's construction plane to a level's height. */
function goToLevel(ctx: CommandContext, level: Level): void {
  for (const vp of ctx.display.viewports) {
    const o = vp.cplane.origin
    vp.setCPlane({ ...vp.cplane, origin: new Vector3(o.x, o.y, level.elevation) })
  }
}

const describeLevels = (levels: Level[], current: string) =>
  levels.map((l) => `${l.name === current ? '*' : ''}${l.name} (${formatValue(l.elevation)}, ${formatValue(l.height)} high)`).join(', ')

const level: Command = {
  name: 'Level',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    for (;;) {
      log(`Levels: ${describeLevels(doc.levels, doc.currentLevel)}`)
      const option = await input.getOption(`Current level: ${doc.level.name}`, ['Current', 'New', 'Edit', 'Remove'])
      if (option === null) return
      if (isOption(option, 'New')) {
        const top = doc.levels[doc.levels.length - 1]
        const name = (await input.getString(`Name of the new level <Level ${doc.levels.length}>`))?.trim() || `Level ${doc.levels.length}`
        if (doc.levels.some((l) => l.name === name)) {
          log(`There is already a level called ${name}`)
          continue
        }
        const elevation = await input.getNumber('Elevation', top.elevation + top.height)
        const height = await input.getNumber('Floor-to-floor height', top.height)
        if (typeof elevation !== 'number' || typeof height !== 'number' || !(height > 0)) continue
        doc.setLevels([...doc.levels, { name, elevation, height }], name)
        goToLevel(ctx, doc.level)
      } else if (isOption(option, 'Current') || isOption(option, 'Edit') || isOption(option, 'Remove')) {
        const name = (await input.getString(`Name of the level (${doc.levels.map((l) => l.name).join(', ')})`))?.trim()
        const chosen = doc.levels.find((l) => l.name.toLowerCase() === name?.toLowerCase())
        if (!chosen) {
          if (name) log(`There is no level called ${name}`)
          continue
        }
        if (isOption(option, 'Current')) {
          doc.setLevels(doc.levels, chosen.name)
          goToLevel(ctx, chosen)
        } else if (isOption(option, 'Edit')) {
          const elevation = await input.getNumber('Elevation', chosen.elevation)
          const height = await input.getNumber('Floor-to-floor height', chosen.height)
          if (typeof elevation !== 'number' || typeof height !== 'number' || !(height > 0)) continue
          doc.setLevels(doc.levels.map((l) => (l === chosen ? { ...l, elevation, height } : l)))
          if (doc.currentLevel === chosen.name) goToLevel(ctx, doc.level)
          // Stairs from this level climb the new height, and their openings follow.
          if (height !== chosen.height) {
            const stairs = [...doc.objects.values()].filter((o) => {
              const line = o.history?.command === 'Stair' ? doc.objects.get(o.history.inputs[0])?.geometry : undefined
              return line && isCurve(line) && Math.abs(startPoint(line).z - chosen.elevation) < 1 && Math.abs(stairParams(o.history!.params).height - chosen.height) < 1
            })
            if (stairs.length > 0) {
              doc.begin()
              for (const o of stairs) await remake(ctx, o.id, { ...o.history!, params: { ...o.history!.params, height } })
              await cutStairwells(ctx, stairs.map((o) => o.id))
              doc.commit()
              log(`${stairs.length} stair${stairs.length === 1 ? '' : 's'} made again to climb ${formatValue(height)}`)
            }
          }
        } else if (doc.levels.length === 1) log('A building keeps at least one level')
        else {
          doc.setLevels(doc.levels.filter((l) => l !== chosen))
          goToLevel(ctx, doc.level)
        }
      }
    }
  },
}

/** Asks for a number option's new value; positive values only. */
async function askPositive(ctx: CommandContext, prompt: string, value: number): Promise<number> {
  const v = await ctx.input.getNumber(prompt, value)
  return typeof v === 'number' && v > 0 ? v : value
}

/** Makes a solid from its curve with a record, adds both, and returns the solid's id. */
async function addRecorded(ctx: CommandContext, curve: AnyCurve, curveId: number | null, record: Omit<HistoryRecord, 'inputs'>, layerId: number, what: string): Promise<number> {
  const { doc } = ctx
  await kernel(ctx)
  const geometry = await readable(kernelJob('rebuild', record.command, [curve], record.params ?? {}), what)
  const inputId = curveId ?? doc.add(curve, construction(ctx).id).id
  const id = doc.add(geometry, layerId).id
  doc.setHistory(id, { ...record, inputs: [inputId] })
  return id
}

/** The plan outline of a wall being drawn, for the preview. */
function wallPreview(points: Vector3[], params: WallParams): Vector3[][] {
  if (points.length < 2) return []
  try {
    return wallOutline({ type: 'polyline', points, closed: false }, params).map(tessellate)
  } catch {
    return [points]
  }
}

const wall: Command = {
  name: 'Wall',
  async run(ctx) {
    const { doc, input, log } = ctx
    const params = (): WallParams => ({ thickness: memory.thickness, height: doc.level.height, justification: memory.justification, openings: [] })
    const options = () => [valueOption('Thickness', memory.thickness), `Justification=${capital(memory.justification)}`, 'Curve']
    // Options, until a first point or the Curve option.
    const handle = async (option: string): Promise<boolean> => {
      if (isOption(option, 'Thickness')) memory.thickness = await askPositive(ctx, 'Wall thickness', memory.thickness)
      else if (isOption(option, 'Justification')) memory.justification = JUSTIFICATIONS[(JUSTIFICATIONS.indexOf(memory.justification) + 1) % JUSTIFICATIONS.length]
      else return false
      return true
    }
    let start: Vector3 | null = null
    while (!start) {
      const r = await input.getPoint({ prompt: 'Start of wall', options: options() })
      if (r.kind === 'point') start = r.point
      else if (r.kind === 'option' && isOption(r.option, 'Curve')) return wallsFromCurves(ctx, params())
      else if (r.kind === 'option') await handle(r.option)
      else return
    }
    const points = [start]
    let closed = false
    for (;;) {
      const extra = points.length >= 3 ? ['Close', 'Undo'] : points.length === 2 ? ['Undo'] : []
      const r = await input.getPoint({
        prompt: 'Next point of wall. Press Enter when done',
        base: points[points.length - 1],
        options: [...options().slice(0, 2), ...extra],
        preview: (p) => [...wallPreview([...points, p], params()), [...points, p]],
      })
      if (r.kind === 'point') points.push(r.point)
      else if (r.kind === 'option' && r.option === 'Undo') points.pop()
      else if (r.kind === 'option' && r.option === 'Close') {
        closed = true
        break
      } else if (r.kind === 'option') await handle(r.option)
      else break
    }
    if (points.length < 2) return
    const path: AnyCurve = { type: 'polyline', points, closed }
    const id = await addRecorded(ctx, path, null, { command: 'Wall', params: { ...params() } }, wallsLayer(ctx).id, 'make the wall')
    doc.select([id])
    log(`Wall made on ${doc.level.name}. Edit its line on the Construction layer, or its parameters in Properties, to change it`)
  },
}

/** Walls along curves already drawn. */
async function wallsFromCurves(ctx: CommandContext, params: WallParams): Promise<void> {
  const { doc, input, log } = ctx
  const ids = (await input.getObjects('Select curves to make walls along')).filter((id) => isCurve(doc.objects.get(id)!.geometry))
  if (ids.length === 0) throw new Error('Select curves')
  const made: number[] = []
  for (const id of ids) made.push(await addRecorded(ctx, doc.objects.get(id)!.geometry as AnyCurve, id, { command: 'Wall', params: { ...params } }, wallsLayer(ctx).id, 'make a wall along that curve'))
  doc.select(made)
  log(`${made.length} wall${made.length === 1 ? '' : 's'} made`)
}

const slab: Command = {
  name: 'Slab',
  async run(ctx) {
    const { doc, input, log } = ctx
    const options = () => [valueOption('Thickness', memory.slab), 'Curve']
    let start: Vector3 | null = null
    while (!start) {
      const r = await input.getPoint({ prompt: 'First corner of slab outline', options: options() })
      if (r.kind === 'point') start = r.point
      else if (r.kind === 'option' && isOption(r.option, 'Thickness')) memory.slab = await askPositive(ctx, 'Slab thickness', memory.slab)
      else if (r.kind === 'option' && isOption(r.option, 'Curve')) {
        const ids = (await input.getObjects('Select closed curves to make slabs on')).filter((id) => {
          const g = doc.objects.get(id)!.geometry
          return isCurve(g) && isClosed(g)
        })
        if (ids.length === 0) throw new Error('Select closed curves')
        const made: number[] = []
        for (const id of ids) made.push(await addRecorded(ctx, doc.objects.get(id)!.geometry as AnyCurve, id, { command: 'Slab', params: { thickness: memory.slab } }, slabsLayer(ctx).id, 'make a slab on that curve'))
        doc.select(made)
        log(`${made.length} slab${made.length === 1 ? '' : 's'} made`)
        return
      } else return
    }
    const points = [start]
    for (;;) {
      const r = await input.getPoint({
        prompt: points.length < 3 ? 'Next corner' : 'Next corner. Press Enter to close the outline',
        base: points[points.length - 1],
        options: points.length >= 2 ? ['Undo'] : [],
        preview: (p) => [[...points, p, points[0]]],
      })
      if (r.kind === 'point') points.push(r.point)
      else if (r.kind === 'option' && r.option === 'Undo') points.pop()
      else break
    }
    if (points.length < 3) return
    const id = await addRecorded(ctx, { type: 'polyline', points, closed: true }, null, { command: 'Slab', params: { thickness: memory.slab } }, slabsLayer(ctx).id, 'make the slab')
    doc.select([id])
    log(`Slab made, ${formatValue(memory.slab)} thick, its top on its outline`)
  },
}

/** Makes a wall or slab again from a new record, keeping its history. */
async function remake(ctx: CommandContext, id: number, record: HistoryRecord): Promise<void> {
  if (ctx.history) return ctx.history.remake(id, record)
  const curves = record.inputs.map((i) => ctx.doc.objects.get(i)!.geometry as AnyCurve)
  ctx.doc.setGeometry(id, await kernelJob('rebuild', record.command, curves, record.params ?? {}))
  ctx.doc.setHistory(id, record)
}

/** Window and Door: openings cut in walls, placed where the wall is clicked. */
function openingCommand(kind: Opening['kind']): Command {
  return {
    name: capital(kind),
    async run(ctx) {
      const { doc, input, display, log } = ctx
      const sizes = memory.openings[kind]
      const options = () => [valueOption('Width', sizes.width), valueOption('Height', sizes.height), ...(kind === 'window' ? [valueOption('Sill', sizes.sill)] : [`Hinge=${capital(memory.hinge)}`]), yesNo('Frame', memory.frame)]
      let placed = 0
      for (;;) {
        const pick = await input.getPick(`Click a wall where the ${kind} goes${placed ? '. Press Enter when done' : ''}`, options(), (id) => isWall(ctx, id))
        if (pick.kind === 'option') {
          if (isOption(pick.option, 'Width')) sizes.width = await askPositive(ctx, `${capital(kind)} width`, sizes.width)
          else if (isOption(pick.option, 'Height')) sizes.height = await askPositive(ctx, `${capital(kind)} height`, sizes.height)
          else if (isOption(pick.option, 'Frame')) memory.frame = !memory.frame
          else if (isOption(pick.option, 'Hinge')) memory.hinge = memory.hinge === 'start' ? 'end' : 'start'
          else if (isOption(pick.option, 'Sill')) {
            const v = await input.getNumber('Sill height', sizes.sill)
            if (typeof v === 'number' && v >= 0) sizes.sill = v
          }
          continue
        }
        if (pick.kind !== 'pick') break
        const obj = doc.objects.get(pick.id)!
        const record = obj.history!
        const path = doc.objects.get(record.inputs[0])?.geometry
        if (!path || !isCurve(path)) {
          log('That wall has lost its line')
          continue
        }
        const params = wallParams(record.params)
        const at = lengthAtPoint(path, pick.point)
        // A door opens to the side of the wall it was clicked on.
        const t = paramAtLength(path, at)
        const across = new Vector3(0, 0, 1).cross(tangentAt(path, t).setZ(0).normalize())
        const swing = across.dot(pick.point.clone().sub(pointAt(path, t)).setZ(0)) >= 0 ? 'left' : 'right'
        const opening: Opening = {
          id: nextOpeningId(params.openings),
          kind,
          at,
          ...sizes,
          ...(memory.frame ? {} : { frame: false }),
          ...(kind === 'door' ? { hinge: memory.hinge, swing } : {}),
        }
        const problem = checkOpening(path, params, opening)
        if (problem) {
          log(problem)
          continue
        }
        const b = openingBox(path, params, opening)
        display.setPreview([[b.origin, b.origin.clone().add(b.u), b.origin.clone().add(b.u).add(b.w), b.origin.clone().add(b.w), b.origin]], true)
        await kernel(ctx)
        try {
          await readable(remake(ctx, pick.id, { ...record, params: { ...record.params, openings: [...params.openings, opening] } }), `cut the ${kind}`)
          placed++
        } finally {
          display.setPreview([])
        }
      }
      if (placed > 0) log(`${placed} ${kind}${placed === 1 ? '' : 's'} placed`)
    },
  }
}


const ROOF_TYPES: RoofType[] = ['hip', 'gable', 'shed']

/** Draws a closed outline corner by corner (Enter closes it), or null if cancelled. */
async function drawOutline(ctx: CommandContext, first: Vector3): Promise<Vector3[] | null> {
  const points = [first]
  for (;;) {
    const r = await ctx.input.getPoint({
      prompt: points.length < 3 ? 'Next corner' : 'Next corner. Press Enter to close the outline',
      base: points[points.length - 1],
      options: points.length >= 2 ? ['Undo'] : [],
      preview: (p) => [[...points, p, points[0]]],
    })
    if (r.kind === 'point') points.push(r.point)
    else if (r.kind === 'option' && r.option === 'Undo') points.pop()
    else break
  }
  return points.length >= 3 ? points : null
}

const roof: Command = {
  name: 'Roof',
  async run(ctx) {
    const { doc, input, log } = ctx
    const m = memory.roof
    const options = () => [`Type=${capital(m.type)}`, valueOption('Pitch', m.pitch), valueOption('Overhang', m.overhang), valueOption('Thickness', m.thickness), 'Curve']
    // Drawn roofs sit on the walls of the current level.
    const eaves = doc.level.elevation + doc.level.height
    const make = async (outline: AnyCurve, curveId: number | null) => {
      roofPlan(outline, m) // Fails early, with the reason, for outlines that cannot be roofed.
      return addRecorded(ctx, outline, curveId, { command: 'Roof', params: { ...m } }, roofsLayer(ctx).id, 'make the roof')
    }
    for (;;) {
      const r = await input.getPoint({ prompt: `First corner of roof outline (eaves at ${formatValue(eaves)})`, options: options() })
      if (r.kind === 'option') {
        if (isOption(r.option, 'Type')) m.type = ROOF_TYPES[(ROOF_TYPES.indexOf(m.type) + 1) % ROOF_TYPES.length]
        else if (isOption(r.option, 'Pitch')) {
          const v = await input.getNumber('Roof pitch in degrees', m.pitch)
          if (typeof v === 'number' && v >= 0 && v < 80) m.pitch = v
        } else if (isOption(r.option, 'Overhang')) {
          const v = await input.getNumber('Overhang', m.overhang)
          if (typeof v === 'number' && v >= 0) m.overhang = v
        } else if (isOption(r.option, 'Thickness')) m.thickness = await askPositive(ctx, 'Roof thickness', m.thickness)
        else if (isOption(r.option, 'Curve')) {
          const ids = (await input.getObjects('Select closed outlines to roof')).filter((id) => {
            const g = doc.objects.get(id)!.geometry
            return isCurve(g) && isClosed(g)
          })
          if (ids.length === 0) throw new Error('Select closed outlines')
          const made: number[] = []
          for (const id of ids) made.push(await make(doc.objects.get(id)!.geometry as AnyCurve, id))
          doc.select(made)
          log(`${made.length} roof${made.length === 1 ? '' : 's'} made`)
          return
        }
        continue
      }
      if (r.kind !== 'point') return
      const corners = await drawOutline(ctx, r.point)
      if (!corners) return
      const outline: AnyCurve = { type: 'polyline', points: corners.map((p) => new Vector3(p.x, p.y, eaves)), closed: true }
      const id = await make(outline, null)
      doc.select([id])
      log(`${capital(m.type)} roof made, ${formatValue(m.pitch)}° pitch, eaves at ${formatValue(eaves)}. Change it in Properties`)
      return
    }
  },
}

const stair: Command = {
  name: 'Stair',
  async run(ctx) {
    const { doc, input, log } = ctx
    const m = memory.stair
    const height = () => doc.level.height
    const options = () => [valueOption('Width', m.width), m.risers > 0 ? valueOption('Risers', m.risers) : 'Risers=Auto', yesNo('Opening', m.opening)]
    const handle = async (option: string) => {
      if (isOption(option, 'Width')) m.width = await askPositive(ctx, 'Stair width', m.width)
      else if (isOption(option, 'Risers')) {
        const v = await input.getNumber('Number of risers (0 for comfortable steps)', m.risers)
        if (typeof v === 'number' && v >= 0) m.risers = Math.round(v)
      } else if (isOption(option, 'Opening')) m.opening = !m.opening
    }
    let start: Vector3 | null = null
    while (!start) {
      const r = await input.getPoint({ prompt: 'Start of stair (bottom step)', options: options() })
      if (r.kind === 'point') start = r.point
      else if (r.kind === 'option') await handle(r.option)
      else return
    }
    const params = () => ({ width: m.width, height: height(), risers: m.risers, waist: DEFAULT_STAIR.waist })
    const points = [start]
    const preview = (p: Vector3) => {
      try {
        return stairOutlines(stairPlan({ type: 'polyline', points: [...points, p], closed: false }, params()))
      } catch {
        return [[...points, p]]
      }
    }
    // Each further point bends the stair round a landing; Enter ends it.
    for (;;) {
      const r = await input.getPoint({
        prompt: points.length === 1 ? 'End of stair run (top step), or where it turns' : 'Next point (the stair turns round a landing). Press Enter when done',
        base: points[points.length - 1],
        options: points.length >= 2 ? ['Undo'] : [],
        preview,
      })
      if (r.kind === 'point') points.push(r.point)
      else if (r.kind === 'option' && r.option === 'Undo') points.pop()
      else break
    }
    if (points.length < 2) return
    const line: AnyCurve = { type: 'polyline', points, closed: false }
    const plan = stairPlan(line, params())
    const id = await addRecorded(ctx, line, null, { command: 'Stair', params: params() }, stairsLayer(ctx).id, 'make the stair')
    const cut = m.opening ? await cutStairwells(ctx, [id]) : 0
    doc.select([id])
    const treads = plan.flights.map((f) => f.tread)
    const [lo, hi] = [Math.min(...treads), Math.max(...treads)]
    const flights = plan.flights.length > 1 ? ` in ${plan.flights.length} flights with ${plan.landings.length} landing${plan.landings.length === 1 ? '' : 's'}` : ''
    log(
      `Stair made${flights}: ${plan.risers} risers of ${formatValue(plan.riser)}, treads of ${formatValue(lo)}${hi - lo > 0.5 ? ` to ${formatValue(hi)}` : ''}` +
        (treads.every((t) => comfortable(plan.riser, t)) ? '' : ' (steeper or shallower than comfortable: 2 risers + 1 tread should be 600 to 650)') +
        (cut > 0 ? `. Opening cut in the slab above` : ''),
    )
  },
}

/** How far a stairwell reaches past the stair all round. */
const STAIRWELL_MARGIN = 50

/**
 * Cuts the openings for stairs through the slabs they climb to: each slab whose top is at the top
 * of a stair and over it gets the stair's footprint as a hole (in place of the one it had for that
 * stair, if any). Resolves to how many slabs were cut.
 */
async function cutStairwells(ctx: CommandContext, stairIds: number[]): Promise<number> {
  const { doc } = ctx
  const changes = new Map<number, HistoryRecord>()
  for (const stairId of stairIds) {
    const record = doc.objects.get(stairId)?.history
    const line = record && doc.objects.get(record.inputs[0])?.geometry
    if (record?.command !== 'Stair' || !line || !isCurve(line)) continue
    const params = stairParams(record.params)
    const footprint = stairFootprint(stairPlan(line, params), STAIRWELL_MARGIN)
    const top = startPoint(line).z + params.height
    const xs = footprint.flat().map((p) => p[0])
    const ys = footprint.flat().map((p) => p[1])
    for (const slab of doc.objects.values()) {
      const r = changes.get(slab.id) ?? slab.history
      if (r?.command !== 'Slab') continue
      const outline = doc.objects.get(r.inputs[0])?.geometry
      if (!outline || !isCurve(outline) || Math.abs(startPoint(outline).z - top) > 1) continue
      const pts = tessellate(outline)
      const over = Math.min(...xs) < Math.max(...pts.map((p) => p.x)) && Math.max(...xs) > Math.min(...pts.map((p) => p.x)) && Math.min(...ys) < Math.max(...pts.map((p) => p.y)) && Math.max(...ys) > Math.min(...pts.map((p) => p.y))
      const p = slabParams(r.params)
      const kept = (p.holes ?? []).filter((h) => h.stair !== stairId)
      if (!over && kept.length === (p.holes ?? []).length) continue
      const holes: SlabHole[] = [...kept, ...(over ? footprint.map((points) => ({ points, stair: stairId })) : [])]
      changes.set(slab.id, { ...r, params: { ...r.params, holes } })
    }
  }
  for (const [id, record] of changes) await remake(ctx, id, record)
  return changes.size
}

/** StairOpening: cuts (or cuts again) the openings for the stairs picked through the slabs above them. */
const stairOpening: Command = {
  name: 'StairOpening',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select stairs to cut their openings in the slabs above')).filter((id) => doc.objects.get(id)?.history?.command === 'Stair')
    if (ids.length === 0) throw new Error('Select stairs (made with the Stair command)')
    const cut = await cutStairwells(ctx, ids)
    log(cut > 0 ? `Openings cut in ${cut} slab${cut === 1 ? '' : 's'}` : 'There is no slab at the top of those stairs (a slab whose top is at the floor they reach)')
  },
}

const column: Command = {
  name: 'Column',
  async run(ctx) {
    const { doc, input, log } = ctx
    const m = memory.column
    const options = () => [`Shape=${m.shape === 'round' ? 'Round' : 'Rectangular'}`, valueOption(m.shape === 'round' ? 'Diameter' : 'Width', m.width), ...(m.shape === 'round' ? [] : [valueOption('Depth', m.depth)])]
    const made: number[] = []
    for (;;) {
      const r = await input.getPoint({
        prompt: made.length ? 'Centre of next column. Press Enter when done' : 'Centre of column',
        options: options(),
        preview: (p) => [tessellate(columnOutline(p, m.shape, m.width, m.depth))],
      })
      if (r.kind === 'option') {
        if (isOption(r.option, 'Shape')) m.shape = m.shape === 'round' ? 'rectangular' : 'round'
        else if (isOption(r.option, 'Width') || isOption(r.option, 'Diameter')) m.width = await askPositive(ctx, m.shape === 'round' ? 'Column diameter' : 'Column width', m.width)
        else if (isOption(r.option, 'Depth')) m.depth = await askPositive(ctx, 'Column depth', m.depth)
        continue
      }
      if (r.kind !== 'point') break
      made.push(await addRecorded(ctx, columnOutline(r.point, m.shape, m.width, m.depth), null, { command: 'Column', params: { height: doc.level.height } }, columnsLayer(ctx).id, 'make the column'))
    }
    if (made.length > 0) {
      doc.select(made)
      log(`${made.length} column${made.length === 1 ? '' : 's'} made, ${formatValue(doc.level.height)} high`)
    }
  },
}

const SIDES: RailingSides[] = ['both', 'left', 'right']
const STYLES: RailingStyle[] = ['bars', 'rails']

/**
 * Railings along a line drawn point by point (a slab edge, a balcony), or on stairs (Stair option):
 * up their flights and round their landings, following the stair when it changes.
 */
const railing: Command = {
  name: 'Railing',
  async run(ctx) {
    const { doc, input, log } = ctx
    const m = memory.railing
    const options = () => [valueOption('Height', m.height), `Style=${capital(m.style)}`, `Sides=${capital(m.sides)}`, 'Stair']
    const handle = async (option: string) => {
      if (isOption(option, 'Height')) m.height = await askPositive(ctx, 'Railing height', m.height)
      else if (isOption(option, 'Style')) m.style = STYLES[(STYLES.indexOf(m.style) + 1) % STYLES.length]
      else if (isOption(option, 'Sides')) m.sides = SIDES[(SIDES.indexOf(m.sides) + 1) % SIDES.length]
      else return false
      return true
    }
    let start: Vector3 | null = null
    while (!start) {
      const r = await input.getPoint({ prompt: 'Start of railing line, or Stair to put railings on stairs', options: options() })
      if (r.kind === 'point') start = r.point
      else if (r.kind === 'option' && isOption(r.option, 'Stair')) return railingsOnStairs(ctx)
      else if (r.kind === 'option') await handle(r.option)
      else return
    }
    const points = [start]
    let closed = false
    for (;;) {
      const r = await input.getPoint({
        prompt: 'Next point of railing. Press Enter when done',
        base: points[points.length - 1],
        options: points.length >= 3 ? ['Close', 'Undo'] : points.length === 2 ? ['Undo'] : [],
        preview: (p) => [[...points, p]],
      })
      if (r.kind === 'point') points.push(r.point)
      else if (r.kind === 'option' && r.option === 'Undo') points.pop()
      else if (r.kind === 'option' && r.option === 'Close') {
        closed = true
        break
      } else break
    }
    if (points.length < 2) return
    const id = await addRecorded(ctx, { type: 'polyline', points, closed }, null, { command: 'Railing', params: { height: m.height, style: m.style } }, railingsLayer(ctx).id, 'make the railing')
    doc.select([id])
    log(`Railing made, ${formatValue(m.height)} high`)
  },
}

/** Railings on stairs picked one by one. */
async function railingsOnStairs(ctx: CommandContext): Promise<void> {
  const { doc, input, log } = ctx
  const m = memory.railing
  const made: number[] = []
  for (;;) {
    const pick = await input.getPick(made.length ? 'Select another stair. Press Enter when done' : 'Select a stair', [`Sides=${capital(m.sides)}`], (id) => doc.objects.get(id)?.history?.command === 'Stair')
    if (pick.kind === 'option') {
      m.sides = SIDES[(SIDES.indexOf(m.sides) + 1) % SIDES.length]
      continue
    }
    if (pick.kind !== 'pick') break
    const stair = doc.objects.get(pick.id)!.history!
    const line = doc.objects.get(stair.inputs[0])?.geometry
    if (!line || !isCurve(line)) {
      log('That stair has lost its line')
      continue
    }
    const params = { height: m.height, style: m.style, sides: m.sides, stair: pick.id, stairParams: stair.params ?? {} }
    made.push(await addRecorded(ctx, line, stair.inputs[0], { command: 'Railing', params }, railingsLayer(ctx).id, 'make the railings'))
  }
  if (made.length > 0) {
    doc.select(made)
    log(`Railings put on ${made.length} stair${made.length === 1 ? '' : 's'}; they follow the stair when it changes`)
  }
}

/** A wall's path, parameters and plan outline (with its joins), from its record. */
function dimensionedWall(ctx: CommandContext, id: number): DimensionedWall | null {
  const { doc } = ctx
  const record = doc.objects.get(id)?.history
  if (record?.command !== 'Wall') return null
  const path = doc.objects.get(record.inputs[0])?.geometry
  if (!path || !isCurve(path)) return null
  const params = wallParams(record.params)
  const joins = (Array.isArray(record.params?.joins) ? (record.params!.joins as SavedJoin[]) : []).flatMap((j) => {
    const other = doc.objects.get(record.inputs[j.input])?.geometry
    return other && isCurve(other) ? [{ end: j.end, kind: j.kind, other: { path: other, params: { thickness: j.thickness, justification: j.justification } } }] : []
  })
  return { path, params, outline: wallOutline(path, params, joins) }
}

/**
 * The room around a point, between the walls (and around the columns) at its height, worked out
 * in the kernel; null (with the reason logged) if the walls do not enclose it.
 */
async function regionAt(ctx: CommandContext, point: Vector3): Promise<{ loops: AnyCurve[]; area: number } | null> {
  const { doc, log } = ctx
  const z = point.z
  const near = (c: AnyCurve) => Math.abs(tessellate(c)[0].z - z) <= Math.max(1, doc.level.height)
  const outlines: AnyCurve[][] = []
  for (const obj of doc.objects.values()) {
    const command = obj.history?.command
    if (command === 'Wall') {
      const w = dimensionedWall(ctx, obj.id)
      if (w && near(w.path) && tessellate(w.path)[0].z <= z + 1) outlines.push(w.outline)
    } else if (command === 'Column') {
      const c = doc.objects.get(obj.history!.inputs[0])?.geometry
      if (c && isCurve(c) && isClosed(c) && near(c)) outlines.push([c])
    }
  }
  await kernel(ctx)
  try {
    return await kernelJob('roomRegion', outlines, point)
  } catch (error) {
    // Say why (open room, inside a wall), so another room can be tried.
    log(error instanceof Error ? error.message : String(error))
    return null
  }
}

/** Square units of area for a document's units, and how many of them a square model unit is. */
export function areaUnits(units: string): { name: string; factor: number } {
  const table: Record<string, { name: string; factor: number }> = {
    Millimeters: { name: 'm²', factor: 1e-6 },
    Centimeters: { name: 'm²', factor: 1e-4 },
    Meters: { name: 'm²', factor: 1 },
    Inches: { name: 'ft²', factor: 1 / 144 },
    Feet: { name: 'ft²', factor: 1 },
  }
  return table[units] ?? { name: `${units.toLowerCase()}²`, factor: 1 }
}

/**
 * Room labels: click inside a room to get its outline (between the walls' plan outlines, around
 * any columns in it, ignoring openings) on a Rooms layer and a label with its name and floor area at
 * the click, grouped. The outline can make the room's floor (Slab, Curve option).
 */
const room: Command = {
  name: 'Room',
  async run(ctx) {
    const { doc, input, log } = ctx
    const m = memory.room
    let made = 0
    for (;;) {
      const r = await input.getPoint({ prompt: made ? 'Click inside another room. Press Enter when done' : 'Click inside a room', options: [valueOption('TextHeight', m.height)] })
      if (r.kind === 'option') {
        if (isOption(r.option, 'TextHeight')) m.height = await askPositive(ctx, 'Text height', m.height)
        continue
      }
      if (r.kind !== 'point') break
      const region = await regionAt(ctx, r.point)
      if (!region) continue
      const name = (await input.getString(`Room name <Room ${made + 1}>`))?.trim() || `Room ${made + 1}`
      const units = areaUnits(doc.units)
      const label = `${name}\n${(region.area * units.factor).toFixed(2)} ${units.name}`
      const layer = layerNamed(ctx, 'Rooms', '#b0802f')
      const ids = region.loops.map((loop) => doc.add(loop, layer.id).id)
      // The label centred on the click.
      const shape = textShape(label)
      const width = Math.max(...shape.widths) * m.height
      const lines = shape.widths.length
      const block = ((lines - 1) * LINE_SPACING + 1) * m.height
      // The text sits on the baseline of its last line; its block reaches up from there.
      const at = new Vector3(r.point.x - width / 2, r.point.y - block / 2, r.point.z)
      ids.push(
        doc.add(
          { type: 'annotation', kind: 'text', points: [at], xaxis: new Vector3(1, 0, 0), yaxis: new Vector3(0, 1, 0), text: label, height: m.height, arrow: 'arrow', precision: 0 },
          layer.id,
        ).id,
      )
      doc.group(ids)
      made++
      log(`${name}: ${(region.area * units.factor).toFixed(2)} ${units.name}`)
    }
    if (made > 0) log(`${made} room${made === 1 ? '' : 's'} labelled`)
  },
}

/**
 * Plan dimensions of walls: along the outside face of each straight stretch, a chain through the
 * edges of its openings and, further out, its overall length. The dimensions are grouped, on a
 * Dimensions layer, with architectural ticks.
 */
const wallDimensionsCommand: Command = {
  name: 'WallDimensions',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select walls to dimension')).filter((id) => isWall(ctx, id))
    if (ids.length === 0) throw new Error('Select walls (made with the Wall command)')
    const offset = await input.getNumber('Distance of the dimensions from the walls', memory.dimensions.offset)
    if (typeof offset === 'number' && offset > 0) memory.dimensions.offset = offset
    const height = await input.getNumber('Text height', memory.dimensions.height)
    if (typeof height === 'number' && height > 0) memory.dimensions.height = height
    const walls = ids.map((id) => dimensionedWall(ctx, id)).filter((w): w is DimensionedWall => w !== null)
    const dims = wallDimensions(walls, { offset: memory.dimensions.offset })
    if (dims.length === 0) {
      log('No outside wall faces to dimension')
      return
    }
    const layer = layerNamed(ctx, 'Dimensions', '#2b2b2b')
    const made = dims.map(
      (d) =>
        doc.add(
          {
            type: 'annotation',
            kind: 'aligned',
            points: [d.from, d.to, d.at],
            xaxis: new Vector3(1, 0, 0),
            yaxis: new Vector3(0, 1, 0),
            text: '',
            height: memory.dimensions.height,
            arrow: 'tick',
            precision: 0,
          },
          layer.id,
        ).id,
    )
    doc.group(made)
    doc.select(made)
    log(`${made.length} dimension${made.length === 1 ? '' : 's'} added (grouped)`)
  },
}

const FLOOR_MATERIALS = ['Wood', 'Ceramic tiles', 'Marble', 'Concrete'] as const

/** A preset material, added to the document if it is not there yet; returns its name. */
function presetMaterial(ctx: CommandContext, name: string): string {
  if (!ctx.doc.materials.some((m) => m.name === name)) {
    const preset = MATERIAL_PRESETS.find((m) => m.name === name)
    if (preset) ctx.doc.setMaterials([...ctx.doc.materials, { ...preset }])
  }
  return name
}

/**
 * The rooms a finishing command works on: clicked inside (their outlines worked out between the
 * walls), or closed curves picked with the Curve option. Calls `make` with each room's loops (outer
 * first, then holes round columns) and the ids of those loops if they are curves already drawn.
 */
async function eachRoom(ctx: CommandContext, prompt: string, options: () => string[], handle: (option: string) => Promise<void>, make: (loops: AnyCurve[], ids: number[] | null) => Promise<void>): Promise<number> {
  const { doc, input } = ctx
  let made = 0
  for (;;) {
    const r = await input.getPoint({ prompt: made ? `${prompt}. Press Enter when done` : prompt, options: [...options(), 'Curve'] })
    if (r.kind === 'option' && isOption(r.option, 'Curve')) {
      const ids = (await input.getObjects('Select closed outlines')).filter((id) => {
        const g = doc.objects.get(id)!.geometry
        return isCurve(g) && isClosed(g)
      })
      for (const id of ids) {
        await make([doc.objects.get(id)!.geometry as AnyCurve], [id])
        made++
      }
      return made
    }
    if (r.kind === 'option') {
      await handle(r.option)
      continue
    }
    if (r.kind !== 'point') return made
    const region = await regionAt(ctx, r.point)
    if (!region) continue
    await make(region.loops, null)
    made++
  }
}

/** Makes a solid from loops with a record, the loops kept on the Construction layer. */
async function addFromLoops(ctx: CommandContext, loops: AnyCurve[], ids: number[] | null, record: Omit<HistoryRecord, 'inputs'>, layerId: number, what: string): Promise<number> {
  const { doc } = ctx
  await kernel(ctx)
  const geometry = await readable(kernelJob('rebuild', record.command, loops, record.params ?? {}), what)
  const inputs = ids ?? loops.map((loop) => doc.add(loop, construction(ctx).id).id)
  const id = doc.add(geometry, layerId).id
  doc.setHistory(id, { ...record, inputs })
  return id
}

/** Floor finishes over rooms, of a thickness and a material, their top that much above the floor. */
const floor: Command = {
  name: 'Floor',
  async run(ctx) {
    const { doc, log } = ctx
    const m = memory.floor
    const made: number[] = []
    const count = await eachRoom(
      ctx,
      'Click inside a room to floor',
      () => [valueOption('Thickness', m.thickness), `Material=${m.material.replace(/\s+/g, '')}`],
      async (option) => {
        if (isOption(option, 'Thickness')) m.thickness = await askPositive(ctx, 'Floor finish thickness', m.thickness)
        else if (isOption(option, 'Material')) m.material = FLOOR_MATERIALS[(FLOOR_MATERIALS.indexOf(m.material) + 1) % FLOOR_MATERIALS.length]
      },
      async (loops, ids) => {
        const id = await addFromLoops(ctx, loops, ids, { command: 'Floor', params: { thickness: m.thickness } }, layerNamed(ctx, 'Floors', '#a07a52').id, 'make the floor')
        doc.setState(id, { material: presetMaterial(ctx, m.material) })
        made.push(id)
      },
    )
    if (count > 0) {
      doc.select(made)
      log(`${count} floor${count === 1 ? '' : 's'} made in ${m.material.toLowerCase()}, ${formatValue(m.thickness)} thick`)
    }
  },
}

/** Skirting round rooms, along the walls and round columns, broken at doors. */
const skirting: Command = {
  name: 'Skirting',
  async run(ctx) {
    const { doc, log } = ctx
    const m = memory.skirting
    const made: number[] = []
    const count = await eachRoom(
      ctx,
      'Click inside a room for skirting',
      () => [valueOption('Height', m.height), valueOption('Thickness', m.thickness)],
      async (option) => {
        if (isOption(option, 'Height')) m.height = await askPositive(ctx, 'Skirting height', m.height)
        else if (isOption(option, 'Thickness')) m.thickness = await askPositive(ctx, 'Skirting thickness', m.thickness)
      },
      async (loops, ids) => {
        // Gaps at the doors of the walls on this floor.
        const z = tessellate(loops[0])[0].z
        const cuts: { origin: XYZ; u: XYZ; v: XYZ; w: XYZ }[] = []
        for (const obj of doc.objects.values()) {
          if (obj.history?.command !== 'Wall') continue
          const path = doc.objects.get(obj.history.inputs[0])?.geometry
          if (!path || !isCurve(path) || Math.abs(tessellate(path)[0].z - z) > 1) continue
          const params = wallParams(obj.history.params)
          for (const o of params.openings) {
            if (o.kind !== 'door') continue
            const b = openingBox(path, params, { ...o, sill: o.sill - 1, height: o.height + 1 })
            cuts.push({ origin: xyz(b.origin), u: xyz(b.u), v: xyz(b.v), w: xyz(b.w) })
          }
        }
        made.push(
          await addFromLoops(ctx, loops, ids, { command: 'Skirting', params: { height: m.height, thickness: m.thickness, cuts } }, skirtingLayer(ctx).id, 'make the skirting'),
        )
      },
    )
    if (count > 0) {
      doc.select(made)
      log(`Skirting put round ${count} room${count === 1 ? '' : 's'}, ${formatValue(m.height)} high`)
    }
  },
}

type XYZ = { x: number; y: number; z: number }
const xyz = (v: Vector3): XYZ => ({ x: v.x, y: v.y, z: v.z })

/** Skirting goes on its own layer, white. */
const skirtingLayer = (ctx: CommandContext) => {
  const layer = layerNamed(ctx, 'Skirting', '#d8d4cc')
  if (!layer.material) ctx.doc.updateLayer(layer.id, { material: presetMaterial(ctx, 'White plaster') })
  return layer
}

export const architectureCommands: Command[] = [wallDimensionsCommand, room, floor, skirting, level, wall, slab, roof, stair, stairOpening, column, railing, openingCommand('window'), openingCommand('door')]
