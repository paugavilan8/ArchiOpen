import { Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import { BrepGeometry, wireframe } from '../core/geometry'
import { nearestFace, shapeOf, toBrep } from '../kernel/brep'
import {
  borderCurves,
  capHoles,
  curveCutter,
  edgeCurves,
  extractFaces,
  extrudeSurface,
  intersectionCurves,
  nearestPiece,
  offsetSurface,
  projectCurves,
  pullCurve,
  splitShape,
} from '../kernel/surfaceEdit'
import { brepHooks } from './curveEdit'
import { isOption, plural, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'
import { brepOf, curveOf, faceOutline, kernel, nearestEdge } from './solids'

const memory = { offset: 1, offsetSolid: false, extrude: 10, deleteInput: true }

/** The cutting shapes for a target: curves become surfaces seen along `direction`, surfaces and solids cut as they are. */
function cuttersFor(ctx: CommandContext, target: AnyShape, ids: number[], direction: Vector3): AnyShape[] {
  const out: AnyShape[] = []
  for (const id of ids) {
    const curve = curveOf(ctx, id)
    if (curve) out.push(curveCutter(curve, direction, [target]))
    const brep = brepOf(ctx, id)
    if (brep) out.push(shapeOf(brep))
  }
  return out
}

/** Replaces an object with shapes on its layer; returns their ids. */
function replaceWithShapes(ctx: CommandContext, id: number, shapes: AnyShape[]): number[] {
  const layerId = ctx.doc.objects.get(id)!.layerId
  ctx.doc.remove(id)
  return shapes.map((s) => ctx.doc.add(toBrep(s), layerId).id)
}

brepHooks.trim = async (ctx, id, at, cutterIds, direction) => {
  const g = brepOf(ctx, id)!
  await kernel(ctx)
  const shape = shapeOf(g)
  const cutters = cuttersFor(ctx, shape, cutterIds, direction)
  if (cutters.length === 0) {
    ctx.log('Select curves, surfaces or solids as cutting objects')
    return null
  }
  let pieces: AnyShape[]
  try {
    pieces = splitShape(shape, cutters)
  } catch (error) {
    console.error(error)
    ctx.log('Could not trim that object')
    return null
  }
  if (pieces.length < 2) {
    ctx.log('The cutting objects do not cross that object')
    return null
  }
  const removed = nearestPiece(pieces, at)
  return replaceWithShapes(
    ctx,
    id,
    pieces.filter((_, i) => i !== removed),
  )
}

brepHooks.split = async (ctx, ids, cutterIds, direction) => {
  await kernel(ctx)
  let count = 0
  for (const id of ids) {
    const shape = shapeOf(brepOf(ctx, id)!)
    const cutters = cuttersFor(
      ctx,
      shape,
      cutterIds.filter((c) => c !== id),
      direction,
    )
    if (cutters.length === 0) continue
    try {
      const pieces = splitShape(shape, cutters)
      if (pieces.length < 2) continue
      replaceWithShapes(ctx, id, pieces)
      count++
    } catch (error) {
      console.error(error)
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
      const { shape, capped } = capHoles(shapeOf(brepOf(ctx, id)!))
      if (capped === 0) continue
      holes += capped
      const [newId] = replaceWithShapes(ctx, id, [shape])
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
        const shape = offsetSurface(shapeOf(brepOf(ctx, id)!), memory.offset, memory.offsetSolid)
        created.push(doc.add(toBrep(shape), doc.objects.get(id)!.layerId).id)
      } catch (error) {
        console.error(error)
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
        const solid = extrudeSurface(shapeOf(brepOf(ctx, id)!), n.clone().multiplyScalar(memory.extrude))
        created.push(doc.add(toBrep(solid), doc.objects.get(id)!.layerId).id)
        if (memory.deleteInput) doc.remove(id)
      } catch (error) {
        console.error(error)
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
      const shape = shapeOf(brepOf(ctx, target)!)
      for (const c of projectCurves(curves.map((id) => curveOf(ctx, id)!), shape, direction)) created.push(doc.add(c).id)
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
      const shape = shapeOf(brepOf(ctx, target)!)
      for (const id of curves) {
        const pulled = pullCurve(curveOf(ctx, id)!, shape)
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
    const shapes = ids.map((id) => shapeOf(brepOf(ctx, id)!))
    const created: number[] = []
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) for (const c of intersectionCurves(shapes[i], shapes[j])) created.push(doc.add(c).id)
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
    geometry ??= kind === 'face' && !g.display.faceTriangles ? toBrep(shapeOf(g)) : g
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
    const { extracted, rest } = extractFaces(shapeOf(picked.geometry), picked.parts)
    const layerId = doc.objects.get(picked.id)!.layerId
    doc.remove(picked.id)
    const ids = extracted.map((s) => doc.add(toBrep(s), layerId).id)
    for (const s of rest) doc.add(toBrep(s), layerId)
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
    const created = ids.flatMap((id) => borderCurves(shapeOf(brepOf(ctx, id)!)).map((c) => doc.add(c).id))
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
    const created = edgeCurves(shapeOf(picked.geometry), picked.parts).map((c) => doc.add(c).id)
    doc.select(created)
    log(`${plural('curve', created.length)} created`)
  },
}

export const surfaceCommands: Command[] = [cap, offsetSrf, extrudeSrf, project, pull, intersect, extractSrf, dupBorder, dupEdge]
