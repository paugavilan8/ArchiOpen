import { Vector3 } from 'three'
import { placeInstance } from '../core/blocks'
import { FURNITURE, furnitureItem, type FurnitureItem } from '../core/furniture'
import type { BlockDefinition, BrepGeometry } from '../core/geometry'
import { wireframe } from '../core/geometry'
import { MATERIAL_PRESETS } from '../core/materials'
import { kernelJob } from '../kernel/client'
import { layerNamed } from './drawing'
import { formatValue } from './helpers'
import type { Command, CommandContext } from './runner'
import { kernel, readable } from './solids'

/**
 * Furniture: places items from a small library of furniture and fittings (beds, sofas, tables,
 * kitchen and bathroom fittings) as blocks, each made the first time it is used. An item is placed
 * by the middle of its back (against a wall), then turned to face a point or an angle.
 */

const memory = { item: 'DoubleBed', rotation: 0 }

/** The layer an item's category goes on (bathroom fittings in ceramic). */
function layerFor(ctx: CommandContext, item: FurnitureItem) {
  if (item.category === 'sanitary') {
    const layer = layerNamed(ctx, 'Sanitary', '#e8e8e8')
    if (!layer.material) {
      const ceramic = MATERIAL_PRESETS.find((m) => m.name === 'Ceramic')!
      if (!ctx.doc.materials.some((m) => m.name === ceramic.name)) ctx.doc.setMaterials([...ctx.doc.materials, { ...ceramic }])
      ctx.doc.updateLayer(layer.id, { material: ceramic.name })
    }
    return layer
  }
  return item.category === 'kitchen' ? layerNamed(ctx, 'Kitchen', '#b9b3a8') : layerNamed(ctx, 'Furniture', '#c9b9a3')
}

/** The block of an item, made from its parts in the kernel if the document does not have it yet. */
async function definitionOf(ctx: CommandContext, item: FurnitureItem, layerId: number): Promise<BlockDefinition> {
  const { doc } = ctx
  const name = `Furniture: ${item.label}`
  const existing = doc.blocks.get(name)
  if (existing) return existing
  await kernel(ctx)
  const objects = await Promise.all(
    item.parts.map(async (p) => {
      const geometry =
        'box' in p
          ? await kernelJob('box', new Vector3(p.box[0], p.box[1], p.box[2]), new Vector3(p.box[3], 0, 0), new Vector3(0, p.box[4], 0), new Vector3(0, 0, p.box[5]))
          : await kernelJob('cylinder', new Vector3(p.cylinder[0], p.cylinder[1], p.cylinder[2]), p.cylinder[3], p.cylinder[4], new Vector3(0, 0, 1))
      return { layerId, geometry: geometry as BrepGeometry }
    }),
  )
  const definition: BlockDefinition = { name, objects }
  doc.setBlock(name, definition)
  return definition
}

const furniture: Command = {
  name: 'Furniture',
  async run(ctx) {
    const { doc, input, log } = ctx
    const list = FURNITURE.map((f) => f.key).join(', ')
    const typed = await input.getString(`Item (${list}) <${memory.item}>`)
    const item = furnitureItem(typed?.trim() || memory.item)
    if (!item) throw new Error(`There is no item "${typed}". Items: ${list}`)
    memory.item = item.key
    const layer = layerFor(ctx, item)
    const definition = await readable(definitionOf(ctx, item, layer.id), `make the ${item.label.toLowerCase()}`)
    let placed = 0
    for (;;) {
      const at = await input.getPoint({
        prompt: `Middle of the back of the ${item.label.toLowerCase()} (against a wall)${placed ? '. Press Enter when done' : ''}`,
        rubberBand: false,
        preview: (p) => wireframe(placeInstance(definition, p, 1, memory.rotation)),
      })
      if (at.kind !== 'point') break
      // Facing: a point it faces, or an angle (Enter keeps the last one).
      const facing = await input.getPoint({
        prompt: `Point it faces, or angle <${formatValue((memory.rotation * 180) / Math.PI)}>`,
        base: at.point,
        acceptNumber: true,
        preview: (p) => {
          const d = p.clone().sub(at.point)
          return d.lengthSq() > 1e-9 ? wireframe(placeInstance(definition, at.point, 1, Math.atan2(d.y, d.x) - Math.PI / 2)) : []
        },
      })
      if (facing.kind === 'point') {
        const d = facing.point.clone().sub(at.point)
        if (d.lengthSq() > 1e-9) memory.rotation = Math.atan2(d.y, d.x) - Math.PI / 2
      } else if (facing.kind === 'number') memory.rotation = (facing.value * Math.PI) / 180
      const g = placeInstance(definition, at.point, 1, memory.rotation)
      doc.add(g, layer.id)
      placed++
    }
    if (placed > 0) log(`${placed} ${item.label.toLowerCase()}${placed === 1 ? '' : 's'} placed`)
  },
}

export const furnitureCommands: Command[] = [furniture]
