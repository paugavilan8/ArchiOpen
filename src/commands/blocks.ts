import { Matrix4 } from 'three'
import { defineBlock, instanceContents, placeInstance, redefineBlock, usesBlock } from '../core/blocks'
import { transform } from '../core/curves'
import type { CadObject } from '../core/document'
import { BlockObject, InstanceGeometry, wireframe } from '../core/geometry'
import { CancelError } from '../input/interaction'
import { formatValue, isOption, plural, valueOption } from './helpers'
import type { Command, CommandContext } from './runner'

const memory = { block: '', scale: 1, rotation: 0 }

const instanceOf = (obj: CadObject | undefined): InstanceGeometry | null => (obj?.geometry.type === 'instance' ? obj.geometry : null)

/** The objects of a block, back in the model where an instance shows them, on their own layers when those still exist. */
function placedContents(ctx: CommandContext, obj: CadObject): BlockObject[] {
  const g = instanceOf(obj)!
  return instanceContents(g).map((o) => ({
    layerId: ctx.doc.layers.some((l) => l.id === o.layerId) ? o.layerId : obj.layerId,
    geometry: o.geometry,
  }))
}

/** Finds a block by name, ignoring case; a unique beginning of a name also matches. */
function findBlock(ctx: CommandContext, text: string): string | null {
  const names = [...ctx.doc.blocks.keys()]
  const lower = text.trim().toLowerCase()
  const exact = names.find((n) => n.toLowerCase() === lower)
  if (exact) return exact
  const starts = names.filter((n) => n.toLowerCase().startsWith(lower))
  return starts.length === 1 ? starts[0] : null
}

const block: Command = {
  name: 'Block',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to make a block')
    const base = await input.getPoint({ prompt: 'Block base point' })
    if (base.kind !== 'point') return
    const name = (await input.getString('Block name'))?.trim()
    if (!name) return
    const objects = ids.map((id) => doc.objects.get(id)!)
    const definition = defineBlock(
      name,
      objects.map((o) => ({ layerId: o.layerId, geometry: o.geometry })),
      base.point,
    )
    if (usesBlock(definition, name)) throw new Error(`A block cannot contain itself: the selection uses "${name}"`)
    if (doc.blocks.has(name)) {
      const answer = await input.getOption(`A block named "${name}" exists. Redefine it (its instances change too)?`, ['Yes', 'No'])
      if (answer === null || !isOption(answer, 'Yes')) return
      redefineBlock(doc, definition)
    } else {
      doc.setBlock(name, definition)
    }
    for (const id of ids) doc.remove(id)
    const instance = doc.add(placeInstance(definition, base.point), objects[0].layerId)
    doc.select([instance.id])
    memory.block = name
    log(`Block "${name}" made from ${plural('object', ids.length)}`)
  },
}

const insert: Command = {
  name: 'Insert',
  async run(ctx) {
    const { doc, input, log } = ctx
    if (doc.blocks.size === 0) throw new Error('There are no blocks yet. Make one with Block, or import a DXF with blocks')
    const names = [...doc.blocks.keys()].sort((a, b) => a.localeCompare(b))
    const fallback = doc.blocks.has(memory.block) ? memory.block : names[0]
    const typed = await input.getString(`Block to insert (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}) <${fallback}>`)
    const name = typed ? findBlock(ctx, typed) : fallback
    if (!name) throw new Error(`There is no block named "${typed}"`)
    memory.block = name
    const definition = doc.blocks.get(name)!

    for (;;) {
      const result = await input.getPoint({
        prompt: `Insertion point of "${name}"`,
        options: [valueOption('Scale', memory.scale), valueOption('Rotation', memory.rotation)],
        rubberBand: false,
        preview: (p) => wireframe(placeInstance(definition, p, memory.scale, (memory.rotation * Math.PI) / 180, ctx.display.active.cplane)),
      })
      if (result.kind === 'option') {
        if (isOption(result.option, 'Scale')) {
          const value = await input.getNumber('Scale', memory.scale)
          if (typeof value === 'number' && value !== 0) memory.scale = value
        } else if (isOption(result.option, 'Rotation')) {
          const value = await input.getNumber('Rotation in degrees', memory.rotation)
          if (typeof value === 'number') memory.rotation = value
        }
        continue
      }
      if (result.kind !== 'point') return
      const g = placeInstance(definition, result.point, memory.scale, (memory.rotation * Math.PI) / 180, result.viewport.cplane)
      doc.select([doc.add(g).id])
      log(`Inserted "${name}"${memory.scale !== 1 ? ` at scale ${formatValue(memory.scale)}` : ''}`)
      return
    }
  },
}

const blockEdit: Command = {
  name: 'BlockEdit',
  async run(ctx) {
    const { doc, input, log } = ctx
    if (doc.blockEdit) throw new Error(`Block "${doc.blockEdit.block}" is being edited: finish or cancel that first`)
    let obj = doc.selection.size === 1 ? doc.objects.get([...doc.selection][0]) : undefined
    while (!instanceOf(obj)) {
      const pick = await input.getPick('Select a block to edit')
      if (pick.kind !== 'pick') return
      obj = doc.objects.get(pick.id)
      if (!instanceOf(obj)) log('That is not a block')
    }
    const g = instanceOf(obj)!
    doc.setBlockEdit({ block: g.definition.name, instanceId: obj!.id, matrix: g.matrix, startId: doc.nextId })
    const ids = placedContents(ctx, obj!).map((o) => doc.add(o.geometry, o.layerId).id)
    doc.select(ids)
    log(`Editing block "${g.definition.name}". Change, add or delete its objects, then run BlockEditFinish (or BlockEditCancel)`)
  },
}

/** The objects being edited as a block: those added since the edit started. */
function editedObjects(ctx: CommandContext): CadObject[] {
  const edit = ctx.doc.blockEdit
  if (!edit) throw new Error('No block is being edited')
  return [...ctx.doc.objects.values()].filter((o) => o.id >= edit.startId)
}

const blockEditFinish: Command = {
  name: 'BlockEditFinish',
  async run(ctx) {
    const { doc, log } = ctx
    const objects = editedObjects(ctx)
    const edit = doc.blockEdit!
    if (objects.length === 0) throw new Error('A block cannot be empty: delete its instances instead, or cancel the edit')
    const toBlock = new Matrix4().fromArray(edit.matrix).invert()
    const definition = {
      name: edit.block,
      objects: objects.map((o) => ({ layerId: o.layerId, geometry: transform(o.geometry, toBlock) })),
    }
    if (usesBlock(definition, edit.block)) throw new Error(`A block cannot contain itself: remove the "${edit.block}" instances first`)
    for (const o of objects) doc.remove(o.id)
    redefineBlock(doc, definition)
    doc.setBlockEdit(null)
    doc.select([edit.instanceId])
    const count = doc.blockUsage().get(edit.block) ?? 0
    log(`Block "${edit.block}" updated (${plural('instance', count)})`)
  },
}

const blockEditCancel: Command = {
  name: 'BlockEditCancel',
  async run(ctx) {
    const { doc, log } = ctx
    const objects = editedObjects(ctx)
    const edit = doc.blockEdit!
    for (const o of objects) doc.remove(o.id)
    doc.setBlockEdit(null)
    log(`Block "${edit.block}" left as it was`)
  },
}

const purge: Command = {
  name: 'Purge',
  async run(ctx) {
    const { doc, log } = ctx
    // Removing a block can leave the blocks it nested unused, so repeat until nothing changes.
    let removed = 0
    for (let again = true; again; ) {
      again = false
      const usage = doc.blockUsage()
      for (const name of [...doc.blocks.keys()]) {
        if ((usage.get(name) ?? 0) === 0 && doc.blockEdit?.block !== name) {
          doc.setBlock(name, null)
          removed++
          again = true
        }
      }
    }
    log(removed === 0 ? 'Every block is in use' : `Removed ${plural('unused block', removed)}`)
  },
}

const group: Command = {
  name: 'Group',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to group')
    if (ids.length < 2) throw new Error('Select two or more objects')
    doc.group(ids)
    log(`${plural('object', ids.length)} grouped`)
  },
}

const ungroup: Command = {
  name: 'Ungroup',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select groups to ungroup')).filter((id) => doc.objects.get(id)?.groups)
    if (ids.length === 0) throw new Error('None of the selected objects is grouped')
    // The most recent group goes, so groups of groups come apart one level at a time.
    const outer = Math.max(...ids.flatMap((id) => doc.objects.get(id)!.groups!))
    for (const id of ids) doc.setGroups(id, doc.objects.get(id)!.groups!.filter((g) => g !== outer))
    log('Ungrouped')
  },
}

const addToGroup: Command = {
  name: 'AddToGroup',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to add to a group')
    const pick = await input.getPick('Select an object of the group')
    if (pick.kind !== 'pick') return
    const groups = doc.objects.get(pick.id)?.groups
    if (!groups) throw new Error('That object is not in a group')
    const target = Math.max(...groups)
    for (const id of ids) if (id !== pick.id) doc.setGroups(id, [...(doc.objects.get(id)?.groups ?? []), target])
    doc.select(doc.withGroups([pick.id]))
    log(`${plural('object', ids.length)} added to the group`)
  },
}

const removeFromGroup: Command = {
  name: 'RemoveFromGroup',
  async run(ctx) {
    const { doc, input, log } = ctx
    doc.clearSelection()
    let count = 0
    // Single picks, so one member can be chosen without its group.
    for (;;) {
      const pick = await input.getPick(count === 0 ? 'Select objects to take out of their group' : 'Select more objects. Press Enter when done')
      if (pick.kind === 'enter') break
      if (pick.kind !== 'pick') throw new CancelError()
      if (!doc.objects.get(pick.id)?.groups) {
        log('That object is not in a group')
        continue
      }
      doc.setGroups(pick.id, undefined)
      count++
    }
    log(`${plural('object', count)} taken out of their groups`)
  },
}

export const blockCommands: Command[] = [block, insert, blockEdit, blockEditFinish, blockEditCancel, purge, group, ungroup, addToGroup, removeFromGroup]

/** Contents of selected block instances, for Explode. */
export function explodeInstance(ctx: CommandContext, obj: CadObject): BlockObject[] {
  return placedContents(ctx, obj)
}
