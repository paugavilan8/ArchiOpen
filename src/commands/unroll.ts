import { Box3, Vector3 } from 'three'
import { expandBox } from '../core/geometry'
import { kernelJob } from '../kernel/client'
import { shapeRef } from '../kernel/wire'
import { isOption, plural, yesNo } from './helpers'
import type { Command } from './runner'
import { brepOf, kernel, readable } from './solids'

const remembered = { explode: false }

/**
 * Flattens developable surfaces and polysurfaces (planar, cylindrical and conical faces) into
 * cutting patterns: closed outlines in the XY plane, one per face, with faces that share a straight
 * edge joined along it. They are placed beside the model, or where picked.
 */
const unrollSrf: Command = {
  name: 'UnrollSrf',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces or polysurfaces to unroll')).filter((id) => brepOf(ctx, id))
    if (ids.length === 0) throw new Error('Select surfaces, polysurfaces or solids')
    const model = new Box3()
    for (const id of ids) expandBox(model, doc.objects.get(id)!.geometry)
    const size = model.getSize(new Vector3())
    const gap = Math.max(size.x, size.y, size.z, 1e-6) * 0.25

    let location: Vector3 | null = null
    for (;;) {
      const result = await input.getPoint({ prompt: 'Lower left corner of the pattern <beside the model>', options: [yesNo('Explode', remembered.explode)] })
      if (result.kind === 'option') {
        if (isOption(result.option, 'Explode')) remembered.explode = !remembered.explode
        continue
      }
      if (result.kind === 'point') location = result.point
      else if (result.kind !== 'enter') return
      break
    }

    await kernel(ctx)
    let corner = location ?? new Vector3(model.max.x + gap, model.min.y, 0)
    let faces = 0
    let skipped = 0
    const created: number[] = []
    for (const id of ids) {
      const g = brepOf(ctx, id)!
      const unrolled = await readable(kernelJob('unrollShape', shapeRef(g), remembered.explode), 'unroll this object')
      skipped += unrolled.skipped
      if (unrolled.faces.length === 0) continue
      faces += unrolled.faces.length
      const layerId = doc.objects.get(id)!.layerId
      const pattern: number[] = []
      let width = 0
      for (const loops of unrolled.faces) {
        for (const loop of loops) {
          const points = loop.map((p) => p.clone().add(corner))
          width = Math.max(width, ...loop.map((p) => p.x))
          pattern.push(doc.add({ type: 'polyline', points, closed: true }, layerId).id)
        }
      }
      // One pattern per object, kept together; the next goes to its right.
      if (pattern.length > 1) doc.group(pattern)
      created.push(...pattern)
      corner = corner.clone().add(new Vector3(width + gap, 0, 0))
    }
    doc.select(created)
    if (faces === 0) throw new Error('Nothing could be unrolled: only planar, cylindrical and conical faces develop onto a plane')
    log(`${plural('face', faces)} unrolled${skipped > 0 ? `; ${plural('face', skipped)} skipped (not planar, cylindrical or conical)` : ''}`)
  },
}

export const unrollCommands: Command[] = [unrollSrf]
