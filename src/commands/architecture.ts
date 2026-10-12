import { Vector3 } from 'three'
import {
  checkOpening,
  DEFAULT_OPENINGS,
  DEFAULT_SLAB,
  DEFAULT_WALL,
  lengthAtPoint,
  openingBox,
  wallOutline,
  wallParams,
  type Justification,
  type Level,
  type Opening,
  type WallParams,
} from '../core/architecture'
import { formatValue, isOption, valueOption, yesNo } from './helpers'
import { nextOpeningId } from '../app/openingParts'
import { AnyCurve, isClosed, isCurve, tessellate } from '../core/geometry'
import type { HistoryRecord } from '../core/document'
import { kernelJob } from '../kernel/client'
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
}

const JUSTIFICATIONS: Justification[] = ['center', 'left', 'right']
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const construction = (ctx: CommandContext) => layerNamed(ctx, 'Construction', '#8c8c8c', 'Dashed')
const wallsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Walls', '#5b5b5b')
const slabsLayer = (ctx: CommandContext) => layerNamed(ctx, 'Slabs', '#7a7a7a')

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
      const options = () => [valueOption('Width', sizes.width), valueOption('Height', sizes.height), ...(kind === 'window' ? [valueOption('Sill', sizes.sill)] : []), yesNo('Frame', memory.frame)]
      let placed = 0
      for (;;) {
        const pick = await input.getPick(`Click a wall where the ${kind} goes${placed ? '. Press Enter when done' : ''}`, options(), (id) => isWall(ctx, id))
        if (pick.kind === 'option') {
          if (isOption(pick.option, 'Width')) sizes.width = await askPositive(ctx, `${capital(kind)} width`, sizes.width)
          else if (isOption(pick.option, 'Height')) sizes.height = await askPositive(ctx, `${capital(kind)} height`, sizes.height)
          else if (isOption(pick.option, 'Frame')) memory.frame = !memory.frame
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
        const opening: Opening = { id: nextOpeningId(params.openings), kind, at: lengthAtPoint(path, pick.point), ...sizes, ...(memory.frame ? {} : { frame: false }) }
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

export const architectureCommands: Command[] = [level, wall, slab, openingCommand('window'), openingCommand('door')]
