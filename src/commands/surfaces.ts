import { Vector3 } from 'three'
import { nearestFace } from '../core/brepFaces'
import { AnyCurve, BrepGeometry, wireframe } from '../core/geometry'
import { CancelError } from '../input/interaction'
import { kernelJob } from '../kernel/client'
import { shapeRef, ShapeRef } from '../kernel/wire'
import { brepHooks } from './curveEdit'
import { isOption, plural, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'
import { brepOf, curveOf, faceOutline, kernel, nearestEdge, readable, shapeOfId } from './solids'

const memory = { offset: 1, offsetSolid: false, extrude: 10, deleteInput: true }

/** The cutting objects among `ids`: curves (cut along a direction) and surfaces and solids. */
function cuttersFor(ctx: CommandContext, ids: number[]): { curves: AnyCurve[]; shapes: ShapeRef[] } {
  const curves: AnyCurve[] = []
  const shapes: ShapeRef[] = []
  for (const id of ids) {
    const curve = curveOf(ctx, id)
    if (curve) curves.push(curve)
    const brep = brepOf(ctx, id)
    if (brep) shapes.push(shapeRef(brep))
  }
  return { curves, shapes }
}

/** Replaces an object with pieces on its layer; returns their ids. */
function replaceWith(ctx: CommandContext, id: number, pieces: BrepGeometry[]): number[] {
  const layerId = ctx.doc.objects.get(id)!.layerId
  ctx.doc.remove(id)
  return pieces.map((g) => ctx.doc.add(g, layerId).id)
}

/** Lets a cancel through a catch that only reports failures. */
function passCancel(error: unknown): void {
  if (error instanceof CancelError) throw error
  console.error(error)
}

brepHooks.trim = async (ctx, id, at, cutterIds, direction) => {
  const g = brepOf(ctx, id)!
  await kernel(ctx)
  const { curves, shapes } = cuttersFor(ctx, cutterIds)
  if (curves.length + shapes.length === 0) {
    ctx.log('Select curves, surfaces or solids as cutting objects')
    return null
  }
  let result
  try {
    result = await kernelJob('trim', shapeRef(g), at, curves, shapes, direction)
  } catch (error) {
    passCancel(error)
    ctx.log('Could not trim that object')
    return null
  }
  if (!result || result.pieces.length < 2) {
    ctx.log('The cutting objects do not cross that object')
    return null
  }
  return replaceWith(
    ctx,
    id,
    result.pieces.filter((_, i) => i !== result.nearest),
  )
}

brepHooks.split = async (ctx, ids, cutterIds, direction) => {
  await kernel(ctx)
  let count = 0
  for (const id of ids) {
    const { curves, shapes } = cuttersFor(
      ctx,
      cutterIds.filter((c) => c !== id),
    )
    if (curves.length + shapes.length === 0) continue
    try {
      const pieces = await kernelJob('split', shapeOfId(ctx, id), curves, shapes, direction)
      if (!pieces || pieces.length < 2) continue
      replaceWith(ctx, id, pieces)
      count++
    } catch (error) {
      passCancel(error)
    }
  }
  return count
}

const cap: Command = {
  name: 'Cap',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select open surfaces or polysurfaces to cap')).filter((id) => brepOf(ctx, id)?.kind !== 'solid' && brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select open surfaces or polysurfaces')
    await kernel(ctx)
    let holes = 0
    let solids = 0
    const created: number[] = []
    for (const id of ids) {
      const { shape, capped } = await readable(kernelJob('capHoles', shapeOfId(ctx, id)), 'cap that object')
      if (capped === 0) continue
      holes += capped
      const [newId] = replaceWith(ctx, id, [shape])
      if (brepOf(ctx, newId)!.kind === 'solid') solids++
      created.push(newId)
    }
    doc.select(created)
    log(holes === 0 ? 'No planar holes to cap' : `${plural('hole', holes)} capped${solids > 0 ? `, ${plural('closed solid', solids)} made` : ''}`)
  },
}

const offsetSrf: Command = {
  name: 'OffsetSrf',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces to offset')).filter((id) => brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select surfaces or polysurfaces')
    for (;;) {
      const answer = await input.getNumber('Offset distance (negative for the other side)', memory.offset, [yesNo('Solid', memory.offsetSolid)])
      if (typeof answer === 'string') {
        if (isOption(answer, 'Solid')) memory.offsetSolid = !memory.offsetSolid
        continue
      }
      if (answer === 0) throw new Error('The distance must not be zero')
      memory.offset = answer
      break
    }
    await kernel(ctx)
    const created: number[] = []
    for (const id of ids) {
      try {
        const shape = await kernelJob('offsetSurface', shapeOfId(ctx, id), memory.offset, memory.offsetSolid)
        created.push(doc.add(shape, doc.objects.get(id)!.layerId).id)
      } catch (error) {
        passCancel(error)
        log('One surface could not be offset (the distance may be too large for its curvature)')
      }
    }
    doc.select(created)
    if (created.length) log(`${plural(memory.offsetSolid ? 'solid' : 'surface', created.length)} created`)
  },
}

const extrudeSrf: Command = {
  name: 'ExtrudeSrf',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = (await input.getObjects('Select surfaces to extrude')).filter((id) => brepOf(ctx, id)?.kind !== 'solid' && brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select surfaces or open polysurfaces')
    const n = display.active.cplane.normal.clone()
    for (;;) {
      const answer = await input.getNumber('Extrusion distance along the construction plane normal', memory.extrude, [yesNo('DeleteInput', memory.deleteInput)])
      if (typeof answer === 'string') {
        if (isOption(answer, 'DeleteInput')) memory.deleteInput = !memory.deleteInput
        continue
      }
      if (answer === 0) throw new Error('The distance must not be zero')
      memory.extrude = answer
      break
    }
    await kernel(ctx)
    const created: number[] = []
    for (const id of ids) {
      try {
        const solid = await kernelJob('extrudeSurface', shapeOfId(ctx, id), n.clone().multiplyScalar(memory.extrude))
        created.push(doc.add(solid, doc.objects.get(id)!.layerId).id)
        if (memory.deleteInput) doc.remove(id)
      } catch (error) {
        passCancel(error)
        log('One surface could not be extruded')
      }
    }
    doc.select(created)
    log(`${plural('solid', created.length)} created`)
  },
}

/** Asks for curves, then for the surfaces and solids to put them on. */
async function curvesAndTargets(ctx: CommandContext, what: string): Promise<{ curves: number[]; targets: number[] }> {
  const { doc, input } = ctx
  const curves = (await input.getObjects(`Select curves to ${what}`)).filter((id) => curveOf(ctx, id))
  if (curves.length === 0) throw new Error('Select curves')
  doc.clearSelection()
  const targets = (await input.getObjects('Select surfaces and solids')).filter((id) => brepOf(ctx, id))
  if (targets.length === 0) throw new Error('Select surfaces or solids')
  return { curves, targets }
}

const project: Command = {
  name: 'Project',
  async run(ctx) {
    const { doc, display, log } = ctx
    const { curves, targets } = await curvesAndTargets(ctx, 'project')
    // Along the active construction plane's normal, as in a plan view looking down.
    const direction = display.active.cplane.normal.clone()
    await kernel(ctx)
    const created: number[] = []
    for (const target of targets) {
      const projected = await readable(kernelJob('projectCurves', curves.map((id) => curveOf(ctx, id)!), shapeOfId(ctx, target), direction), 'project the curves')
      for (const c of projected) created.push(doc.add(c).id)
    }
    doc.select(created)
    log(created.length === 0 ? 'The curves do not land on the surfaces' : `${plural('curve', created.length)} projected`)
  },
}

const pull: Command = {
  name: 'Pull',
  async run(ctx) {
    const { doc, log } = ctx
    const { curves, targets } = await curvesAndTargets(ctx, 'pull')
    await kernel(ctx)
    const created: number[] = []
    for (const target of targets) {
      for (const id of curves) {
        const pulled = await readable(kernelJob('pullCurve', curveOf(ctx, id)!, shapeOfId(ctx, target)), 'pull the curve')
        if (pulled) created.push(doc.add(pulled).id)
      }
    }
    doc.select(created)
    log(`${plural('curve', created.length)} pulled`)
  },
}

const intersect: Command = {
  name: 'Intersect',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces and solids to intersect')).filter((id) => brepOf(ctx, id))
    if (ids.length < 2) throw new Error('Select two or more surfaces or solids')
    await kernel(ctx)
    const shapes = ids.map((id) => shapeOfId(ctx, id))
    const created: number[] = []
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        for (const c of await readable(kernelJob('intersectionCurves', shapes[i], shapes[j]), 'intersect the objects')) created.push(doc.add(c).id)
      }
    }
    doc.select(created)
    log(created.length === 0 ? 'The objects do not intersect' : `${plural('intersection curve', created.length)} created`)
  },
}

/** Picks faces (or edges) of one surface or solid until Enter. */
async function pickParts(ctx: CommandContext, kind: 'face' | 'edge', prompt: string): Promise<{ id: number; geometry: BrepGeometry; parts: number[] } | null> {
  const { input, display, log } = ctx
  await kernel(ctx)
  let target: number | null = null
  let geometry: BrepGeometry | null = null
  const parts: number[] = []
  for (;;) {
    const pick = await input.getPick(parts.length === 0 ? prompt : `${prompt}. Press Enter when done`)
    if (pick.kind !== 'pick') break
    const g = brepOf(ctx, pick.id)
    if (!g) {
      log(`Pick ${kind === 'face' ? 'a face' : 'an edge'} of a surface or solid`)
      continue
    }
    if (target !== null && pick.id !== target) {
      log('Pick parts of one object at a time')
      continue
    }
    target = pick.id
    geometry ??= kind === 'face' && !g.display.faceTriangles ? await readable(kernelJob('faces', shapeRef(g)), 'find the faces of that object') : g
    const part = kind === 'face' ? nearestFace(geometry, pick.point) : nearestEdge(geometry, pick.point)
    if (part >= 0 && !parts.includes(part)) parts.push(part)
    display.setPreview(kind === 'face' ? parts.flatMap((f) => faceOutline(geometry!, f)) : parts.map((e) => wireframe(geometry!)[e]), true)
  }
  display.setPreview([])
  return target === null || !geometry || parts.length === 0 ? null : { id: target, geometry, parts }
}

const extractSrf: Command = {
  name: 'ExtractSrf',
  async run(ctx) {
    const { doc, log } = ctx
    const picked = await pickParts(ctx, 'face', 'Select faces to extract')
    if (!picked) return
    const { extracted, rest } = await readable(kernelJob('extractFaces', shapeRef(picked.geometry), picked.parts), 'extract those faces')
    const layerId = doc.objects.get(picked.id)!.layerId
    doc.remove(picked.id)
    const ids = extracted.map((g) => doc.add(g, layerId).id)
    for (const g of rest) doc.add(g, layerId)
    doc.select(ids)
    log(`${plural('face', ids.length)} extracted`)
  },
}

const dupBorder: Command = {
  name: 'DupBorder',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces')).filter((id) => brepOf(ctx, id))
    await kernel(ctx)
    const created: number[] = []
    for (const id of ids) for (const c of await readable(kernelJob('borderCurves', shapeOfId(ctx, id)), 'find the borders')) created.push(doc.add(c).id)
    doc.select(created)
    log(created.length === 0 ? 'Closed solids have no border' : `${plural('border curve', created.length)} created`)
  },
}

const dupEdge: Command = {
  name: 'DupEdge',
  async run(ctx) {
    const { doc, log } = ctx
    const picked = await pickParts(ctx, 'edge', 'Select edges to duplicate')
    if (!picked) return
    const curves = await readable(kernelJob('edgeCurves', shapeRef(picked.geometry), picked.parts), 'duplicate those edges')
    const created = curves.map((c) => doc.add(c).id)
    doc.select(created)
    log(`${plural('curve', created.length)} created`)
  },
}

export const surfaceCommands: Command[] = [cap, offsetSrf, extrudeSrf, project, pull, intersect, extractSrf, dupBorder, dupEdge]
