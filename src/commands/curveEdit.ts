import { Vector3 } from 'three'
import { closestPoint, explode as explodeCurve, join as joinCurves, split as splitCurve } from '../core/curves'
import { chamferLines, filletCorners as roundCorners, filletLines } from '../core/fillet'
import { extend as extendCurve } from '../core/curveTools'
import { AnyCurve, domain, Geometry, isCurve, PolylineGeometry, tessellate, wireframe } from '../core/geometry'
import { intersect } from '../core/intersect'
import { offset as offsetCurve } from '../core/offset'
import { CancelError } from '../input/interaction'
import { isOption, memory, plural, valueOption } from './helpers'
import { explodeInstance } from './blocks'
import type { Command, CommandContext } from './runner'

/** Parameters where `target` meets any of the cutting objects (other than itself). */
function cutParams(ctx: CommandContext, target: AnyCurve, targetId: number, cutterIds: Iterable<number>): number[] {
  const params: number[] = []
  for (const id of cutterIds) {
    if (id === targetId) continue
    const cutter = ctx.doc.objects.get(id)?.geometry
    // Cutting with surfaces and solids is not supported yet.
    if (cutter && isCurve(cutter)) for (const hit of intersect(target, cutter)) params.push(hit.ta)
  }
  return params
}

/** The geometry of an object if it is a curve. */
function curveOf(ctx: CommandContext, id: number): AnyCurve | null {
  const g = ctx.doc.objects.get(id)?.geometry
  return g && isCurve(g) ? g : null
}

/** Replaces an object by several pieces on its layer, returning the new ids. */
function replaceWith(ctx: CommandContext, id: number, pieces: Geometry[]): number[] {
  const obj = ctx.doc.objects.get(id)!
  ctx.doc.remove(id)
  return pieces.map((g) => ctx.doc.add(g, obj.layerId).id)
}

const trim: Command = {
  name: 'Trim',
  async run(ctx) {
    const { doc, input, log } = ctx
    const cutters = new Set(await input.getObjects('Select cutting objects'))
    doc.select(cutters)

    for (;;) {
      const pick = await input.getPick('Select object to trim. Press Enter when done')
      if (pick.kind !== 'pick') return
      if (doc.objects.get(pick.id)?.geometry.type === 'brep') {
        // Surfaces and solids lose the piece that was clicked; curves cut them as seen in the view.
        const direction = pick.viewport.camera.getWorldDirection(new Vector3())
        const kept = await brepHooks.trim(ctx, pick.id, pick.point, [...cutters].filter((id) => id !== pick.id), direction)
        if (kept === null) continue
        if (cutters.delete(pick.id)) for (const id of kept) cutters.add(id)
        doc.select(cutters)
        continue
      }
      const target = curveOf(ctx, pick.id)
      if (!target) {
        log('Trim works on curves, surfaces and solids')
        continue
      }
      const params = cutParams(ctx, target, pick.id, cutters)
      if (params.length === 0) {
        log('That object does not cross any cutting object')
        continue
      }
      const pieces = splitCurve(target, params)
      // Remove the piece that was clicked; keep the others.
      let removed = 0
      let best = Infinity
      pieces.forEach((piece, i) => {
        const d = closestPoint(piece, pick.point).distance
        if (d < best) {
          best = d
          removed = i
        }
      })
      const wasCutter = cutters.delete(pick.id)
      const kept = replaceWith(ctx, pick.id, pieces.filter((_, i) => i !== removed))
      // A trimmed cutting object keeps cutting with what is left of it.
      if (wasCutter) for (const id of kept) cutters.add(id)
      doc.select(cutters)
    }
  },
}

const split: Command = {
  name: 'Split',
  async run(ctx) {
    const { doc, input, log } = ctx
    const targets = await input.getObjects('Select objects to split')
    doc.clearSelection()
    const cutters = await input.getObjects('Select cutting objects')
    const breps = targets.filter((id) => doc.objects.get(id)?.geometry.type === 'brep')
    // Curves cut surfaces as seen in the active view.
    const direction = ctx.display.active.camera.getWorldDirection(new Vector3())
    let count = breps.length > 0 ? await brepHooks.split(ctx, breps, cutters, direction) : 0
    for (const id of targets) {
      const target = curveOf(ctx, id)
      if (!target) continue
      const params = cutParams(ctx, target, id, cutters)
      if (params.length === 0) continue
      const pieces = splitCurve(target, params)
      if (pieces.length < 2) continue
      replaceWith(ctx, id, pieces)
      count++
    }
    doc.clearSelection()
    log(count === 0 ? 'Nothing was split: the objects do not cross the cutting objects' : `${plural('object', count)} split`)
  },
}

/** Joins and explodes surfaces and solids; provided by the solid commands so this module needs no kernel. */
export const brepHooks = {
  join: async (_ctx: CommandContext, _ids: number[]): Promise<string | null> => null,
  explode: async (_ctx: CommandContext, _ids: number[]): Promise<number> => 0,
  /** Trims a surface or solid at a picked point; resolves to the ids of what is left, or null. */
  trim: async (_ctx: CommandContext, _id: number, _at: Vector3, _cutters: number[], _direction: Vector3): Promise<number[] | null> => null,
  /** Splits surfaces and solids; resolves to how many were split. */
  split: async (_ctx: CommandContext, _ids: number[], _cutters: number[], _direction: Vector3): Promise<number> => 0,
}

const join: Command = {
  name: 'Join',
  async run(ctx) {
    const { doc, input, log } = ctx
    const selected = await input.getObjects('Select curves, surfaces or solids to join')
    const brepIds = selected.filter((id) => doc.objects.get(id)?.geometry.type === 'brep')
    if (brepIds.length > 0) {
      const message = await brepHooks.join(ctx, brepIds)
      if (message) log(message)
    }
    const ids = selected.filter((id) => curveOf(ctx, id))
    if (ids.length === 0) return
    const geometries = ids.map((id) => curveOf(ctx, id)!)
    const chains = joinCurves(geometries)
    let joined = 0
    const result: number[] = []
    for (const chain of chains) {
      if (chain.used.length < 2) {
        result.push(ids[chain.used[0]])
        continue
      }
      const layerId = doc.objects.get(ids[chain.used[0]])!.layerId
      for (const i of chain.used) doc.remove(ids[i])
      result.push(doc.add(chain.geometry, layerId).id)
      joined += chain.used.length
    }
    doc.select(result)
    log(joined === 0 ? 'No curves could be joined: their ends do not meet' : `${plural('curve', joined)} joined into ${plural('curve', chains.filter((c) => c.used.length > 1).length)}`)
  },
}

const explode: Command = {
  name: 'Explode',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to explode')
    let pieces = await brepHooks.explode(ctx, ids.filter((id) => doc.objects.get(id)?.geometry.type === 'brep'))
    for (const id of ids) {
      const obj = doc.objects.get(id)
      const g = obj?.geometry
      if (obj && g?.type === 'instance') {
        // Blocks become their objects, one level at a time.
        const parts = explodeInstance(ctx, obj)
        doc.remove(id)
        for (const part of parts) doc.add(part.geometry, part.layerId)
        pieces += parts.length
        continue
      }
      if (g?.type === 'annotation') {
        // Texts and dimensions become their line work.
        const parts = wireframe(g).map((points): AnyCurve => ({ type: 'polyline', points, closed: false }))
        replaceWith(ctx, id, parts)
        pieces += parts.length
        continue
      }
      const curve = curveOf(ctx, id)
      if (!curve) continue
      const parts = explodeCurve(curve)
      if (parts.length < 2) continue
      replaceWith(ctx, id, parts)
      pieces += parts.length
    }
    doc.clearSelection()
    log(pieces === 0 ? 'Nothing to explode' : `Exploded into ${plural('object', pieces)}`)
  },
}

/** Asks for a positive (or, with allowZero, non-negative) value until one is given. */
async function askDistance(ctx: CommandContext, prompt: string, value: number, allowZero = false): Promise<number> {
  const result = await ctx.input.getNumber(prompt, value)
  if (typeof result !== 'number') throw new CancelError()
  if (result < 0 || (!allowZero && result === 0)) throw new Error(`${prompt} must be ${allowZero ? 'zero or more' : 'more than zero'}`)
  return result
}

const offset: Command = {
  name: 'Offset',
  async run(ctx) {
    const { doc, input, log } = ctx
    for (;;) {
      const pick = await input.getPick('Select curve to offset', [valueOption('Distance', memory.offsetDistance)])
      if (pick.kind === 'option') {
        memory.offsetDistance = await askDistance(ctx, 'Offset distance', memory.offsetDistance)
        continue
      }
      if (pick.kind !== 'pick') return
      const obj = doc.objects.get(pick.id)!
      const curve = curveOf(ctx, pick.id)
      if (!curve) {
        log('Offset works on curves for now')
        continue
      }
      const n = pick.viewport.cplane.normal

      for (;;) {
        const side = await input.getPoint({
          prompt: 'Side to offset (or type a distance)',
          acceptNumber: true,
          options: [valueOption('Distance', memory.offsetDistance)],
          preview: (p: Vector3) => {
            const r = offsetCurve(curve, memory.offsetDistance, p, n)
            return r ? [tessellate(r)] : []
          },
        })
        if (side.kind === 'number') {
          if (side.value > 0) memory.offsetDistance = side.value
          continue
        }
        if (side.kind === 'option') {
          memory.offsetDistance = await askDistance(ctx, 'Offset distance', memory.offsetDistance)
          continue
        }
        if (side.kind !== 'point') return
        const result = offsetCurve(curve, memory.offsetDistance, side.point, n)
        if (result) doc.add(result, obj.layerId)
        else log('The offset distance is too large for this curve')
        return
      }
    }
  },
}

const isLine = (g: Geometry): g is PolylineGeometry => g.type === 'polyline' && g.points.length === 2 && !g.closed

/** Picks a line for Fillet, handling the Radius option. Returns null when the user presses Enter. */
interface LineOptions {
  /** The options offered while picking, as they read now. */
  options: () => string[]
  change: (option: string) => Promise<void>
  /** The command's name, for messages. */
  what: string
}

const filletOptions: LineOptions = {
  options: () => [valueOption('Radius', memory.filletRadius)],
  change: async () => {},
  what: 'Fillet',
}

async function pickLine(ctx: CommandContext, prompt: string, opts: LineOptions = filletOptions): Promise<{ id: number; point: Vector3; line: PolylineGeometry } | null> {
  for (;;) {
    const pick = await ctx.input.getPick(prompt, opts.options())
    if (pick.kind === 'option') {
      if (opts === filletOptions) memory.filletRadius = await askDistance(ctx, 'Fillet radius', memory.filletRadius, true)
      else await opts.change(pick.option)
      continue
    }
    if (pick.kind !== 'pick') return null
    const g = ctx.doc.objects.get(pick.id)!.geometry
    const type = g.type
    if (isLine(g)) return { id: pick.id, point: pick.point, line: g }
    ctx.log(type === 'polyline' ? `Pick a single line. To ${opts.what === 'Fillet' ? 'round' : 'cut'} the corners of a polyline, explode it first` : `${opts.what} works with lines`)
  }
}

const chamferOptions = (ctx: CommandContext): LineOptions => ({
  options: () => [valueOption('Distance1', memory.chamferA), valueOption('Distance2', memory.chamferB)],
  change: async (option) => {
    if (isOption(option, 'Distance1')) memory.chamferA = await askDistance(ctx, 'First chamfer distance', memory.chamferA, true)
    else memory.chamferB = await askDistance(ctx, 'Second chamfer distance', memory.chamferB, true)
  },
  what: 'Chamfer',
})

const chamfer: Command = {
  name: 'Chamfer',
  async run(ctx) {
    const { doc } = ctx
    const opts = chamferOptions(ctx)
    const first = await pickLine(ctx, 'Select first line to chamfer', opts)
    if (!first) return
    doc.select([first.id])
    const second = await pickLine(ctx, 'Select second line to chamfer', opts)
    if (!second) return
    if (second.id === first.id) throw new Error('Pick two different lines')
    const result = chamferLines(first.line, first.point, second.line, second.point, memory.chamferA, memory.chamferB)
    if (!result.ok) throw new Error(result.error)
    const layerId = doc.objects.get(first.id)!.layerId
    doc.setGeometry(first.id, result.a)
    doc.setGeometry(second.id, result.b)
    if (result.chamfer) doc.add(result.chamfer, layerId)
    doc.clearSelection()
  },
}

const extendCommand: Command = {
  name: 'Extend',
  async run(ctx) {
    const { doc, input, log } = ctx
    const boundaries = new Set(await input.getObjects('Select boundary objects'))
    doc.select(boundaries)
    const curves = () => [...boundaries].map((id) => curveOf(ctx, id)).filter((c): c is AnyCurve => c !== null)
    for (;;) {
      const pick = await input.getPick('Select the end of a curve to extend. Press Enter when done')
      if (pick.kind !== 'pick') return
      const g = curveOf(ctx, pick.id)
      if (!g) {
        log('Extend works on curves')
        continue
      }
      // The end nearer the click is extended.
      const [t0, t1] = domain(g)
      const atStart = closestPoint(g, pick.point).t - t0 < t1 - closestPoint(g, pick.point).t
      const longer = extendCurve(g, atStart, curves().filter((c) => c !== g))
      if (!longer) {
        log('That end does not reach any boundary')
        continue
      }
      doc.setGeometry(pick.id, longer)
      doc.select(boundaries)
    }
  },
}

const fillet: Command = {
  name: 'Fillet',
  async run(ctx) {
    const { doc } = ctx
    const first = await pickLine(ctx, 'Select first line to fillet')
    if (!first) return
    doc.select([first.id])
    const second = await pickLine(ctx, 'Select second line to fillet')
    if (!second) return
    if (second.id === first.id) throw new Error('Pick two different lines')

    const result = filletLines(first.line, first.point, second.line, second.point, memory.filletRadius)
    if (!result.ok) throw new Error(result.error)
    const layerId = doc.objects.get(first.id)!.layerId
    doc.setGeometry(first.id, result.a)
    doc.setGeometry(second.id, result.b)
    if (result.arc) doc.add(result.arc, layerId)
    doc.clearSelection()
  },
}

const filletCorners: Command = {
  name: 'FilletCorners',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select polylines')
    memory.filletRadius = await askDistance(ctx, 'Fillet radius', memory.filletRadius)
    let count = 0
    for (const id of ids) {
      const g = doc.objects.get(id)!.geometry
      if (g.type !== 'polyline' || g.points.length < 3) continue
      const result = roundCorners(g, memory.filletRadius)
      if (!result.ok) {
        log(result.error)
        continue
      }
      doc.setGeometry(id, result.geometry)
      count++
    }
    log(`${plural('polyline', count)} filleted`)
  },
}

export const curveEditCommands: Command[] = [trim, split, join, explode, offset, fillet, filletCorners, chamfer, extendCommand]
