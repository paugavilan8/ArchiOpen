import { Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import { AnyCurve, wireframe } from '../core/geometry'
import { blendSurface, edgeSurface, networkSurface, patch, pipe, surfaceFromPoints, sweep2 } from '../kernel/advancedSurfaces'
import { shapeOf, toBrep } from '../kernel/brep'
import { isOption, plural, valueOption, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'
import { addShape, brepOf, curveOf, kernel, nearestEdge } from './solids'

/** Surfaces from networks of curves, blends and pipes. */

const memory = {
  pipeRadius: 1,
  pipeCap: true,
  bulge: 1,
}

/** Picks one curve, showing it in the selection color; null when the user finishes or cancels. */
async function pickCurve(ctx: CommandContext, prompt: string, chosen: number[]): Promise<number | null> {
  for (;;) {
    const pick = await ctx.input.getPick(prompt, [], (id) => !!curveOf(ctx, id))
    if (pick.kind !== 'pick') return null
    if (!curveOf(ctx, pick.id)) {
      ctx.log('Pick a curve')
      continue
    }
    if (chosen.includes(pick.id)) continue
    chosen.push(pick.id)
    ctx.doc.select(chosen)
    return pick.id
  }
}

/** Selected curves (or asks for them). */
async function getCurves(ctx: CommandContext, prompt: string): Promise<{ ids: number[]; curves: AnyCurve[] }> {
  const ids = (await ctx.input.getObjects(prompt)).filter((id) => curveOf(ctx, id))
  return { ids, curves: ids.map((id) => curveOf(ctx, id)!) }
}

/**
 * Builds a surface with the kernel and adds it on the layer of the first input, selected. Our own
 * errors say what is wrong with the input; the kernel's failures become `Could not …`.
 */
async function build(ctx: CommandContext, inputId: number | undefined, make: () => AnyShape, what: string): Promise<number> {
  await kernel(ctx)
  let shape: AnyShape
  try {
    shape = make()
  } catch (error) {
    if (error instanceof Error) throw error
    console.error(error)
    throw new Error(`Could not ${what}`)
  }
  const id = ctx.doc.add(toBrep(shape), inputId === undefined ? undefined : ctx.doc.objects.get(inputId)?.layerId).id
  ctx.doc.select([id])
  return id
}

const sweep2Command: Command = {
  name: 'Sweep2',
  async run(ctx) {
    const { doc, log } = ctx
    doc.clearSelection()
    const chosen: number[] = []
    const rail1 = await pickCurve(ctx, 'Select the first rail', chosen)
    if (rail1 === null) return
    const rail2 = await pickCurve(ctx, 'Select the second rail', chosen)
    if (rail2 === null) return
    const profiles: number[] = []
    for (;;) {
      const id = await pickCurve(ctx, profiles.length === 0 ? 'Select profiles (from one rail to the other)' : 'Select more profiles. Press Enter to sweep', chosen)
      if (id === null) break
      profiles.push(id)
    }
    if (profiles.length === 0) return
    const made = await build(ctx, profiles[0], () => sweep2(curveOf(ctx, rail1)!, curveOf(ctx, rail2)!, profiles.map((id) => curveOf(ctx, id)!)), 'sweep: each profile must run from one rail to the other')
    ctx.history?.record(made, 'Sweep2', [rail1, rail2, ...profiles])
    log(`Swept ${plural('profile', profiles.length)} along two rails`)
  },
}

const networkSrf: Command = {
  name: 'NetworkSrf',
  async run(ctx) {
    const { ids, curves } = await getCurves(ctx, 'Select curves in two directions')
    if (ids.length < 4) throw new Error('Select at least two curves in each direction')
    ctx.history?.record(await build(ctx, ids[0], () => networkSurface(curves), 'build a surface from this network'), 'NetworkSrf', ids)
  },
}

const patchCommand: Command = {
  name: 'Patch',
  async run(ctx) {
    const { ids, curves } = await getCurves(ctx, 'Select curves: a closed boundary and any curves inside it')
    if (ids.length === 0) throw new Error('Select curves')
    ctx.history?.record(await build(ctx, ids[0], () => patch(curves), 'fit a patch to these curves'), 'Patch', ids)
  },
}

const edgeSrf: Command = {
  name: 'EdgeSrf',
  async run(ctx) {
    const { ids, curves } = await getCurves(ctx, 'Select two, three or four edge curves')
    ctx.history?.record(await build(ctx, ids[0], () => edgeSurface(curves), 'make a surface from these edges'), 'EdgeSrf', ids)
  },
}

const srfPt: Command = {
  name: 'SrfPt',
  async run(ctx) {
    const { input } = ctx
    const points: Vector3[] = []
    for (const prompt of ['First corner', 'Second corner', 'Third corner', 'Fourth corner. Press Enter for a triangle']) {
      const r = await input.getPoint({
        prompt,
        base: points[points.length - 1],
        preview: (p) => [[...points, p, points[0] ?? p]],
      })
      if (r.kind === 'point') points.push(r.point)
      else if (r.kind === 'enter' && points.length === 3) break
      else return
    }
    await build(ctx, undefined, () => surfaceFromPoints(points), 'make a surface from these points (they may be in line)')
  },
}

/** Picks an edge of a surface or solid. */
async function pickEdge(ctx: CommandContext, prompt: string, options: () => string[], onOption: (option: string) => Promise<void>) {
  for (;;) {
    const pick = await ctx.input.getPick(prompt, options(), (id) => !!brepOf(ctx, id))
    if (pick.kind === 'option') {
      await onOption(pick.option)
      continue
    }
    if (pick.kind !== 'pick') return null
    const g = brepOf(ctx, pick.id)
    if (!g) {
      ctx.log('Pick an edge of a surface')
      continue
    }
    const edge = nearestEdge(g, pick.point)
    return { id: pick.id, edge, line: wireframe(g)[edge] }
  }
}

const blendSrf: Command = {
  name: 'BlendSrf',
  async run(ctx) {
    const { display, input } = ctx
    const options = () => [valueOption('Bulge', memory.bulge)]
    const onOption = async () => {
      const n = await input.getNumber('Bulge (1 is natural; more keeps each surface’s direction longer)', memory.bulge)
      if (typeof n === 'number' && n > 0) memory.bulge = n
    }
    const a = await pickEdge(ctx, 'Select an edge of the first surface', options, onOption)
    if (!a) return
    display.setPreview([a.line], true)
    try {
      const b = await pickEdge(ctx, 'Select an edge of the second surface', options, onOption)
      if (!b) return
      const [ga, gb] = [brepOf(ctx, a.id)!, brepOf(ctx, b.id)!]
      await build(ctx, a.id, () => blendSurface(shapeOf(ga), a.edge, shapeOf(gb), b.edge, memory.bulge), 'blend these edges')
    } finally {
      display.setPreview([])
    }
  },
}

const pipeCommand: Command = {
  name: 'Pipe',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select curves for pipes')).filter((id) => curveOf(ctx, id))
    if (ids.length === 0) throw new Error('Select curves')
    let start: number | null = null
    for (;;) {
      const r = await input.getNumber('Radius at the start', memory.pipeRadius, [yesNo('Cap', memory.pipeCap)])
      if (typeof r === 'string') {
        if (isOption(r, 'Cap')) memory.pipeCap = !memory.pipeCap
        continue
      }
      start = r
      break
    }
    if (start === null || start <= 0) throw new Error('The radius must be more than zero')
    memory.pipeRadius = start
    const end = await input.getNumber('Radius at the end', start)
    if (typeof end !== 'number' || end <= 0) throw new Error('The radius must be more than zero')
    await kernel(ctx)
    const made = ids.map((id) => {
      const pipeId = addShape(ctx, () => pipe(curveOf(ctx, id)!, start!, end, memory.pipeCap), 'make the pipe (the radius may be too large for the bends)', doc.objects.get(id)!.layerId)
      ctx.history?.record(pipeId, 'Pipe', [id], { start, end, cap: memory.pipeCap })
      return pipeId
    })
    doc.select(made)
    log(`${plural('pipe', made.length)} made${memory.pipeCap ? ', capped' : ''}`)
  },
}

export const advancedSurfaceCommands: Command[] = [sweep2Command, networkSrf, patchCommand, edgeSrf, srfPt, blendSrf, pipeCommand]
