import { Vector3 } from 'three'
import { placeInstance, redefineBlock } from '../core/blocks'
import type { BlockDefinition } from '../core/geometry'
import { adoptModel } from '../app/rhinoModel'
import { isOption, plural } from './helpers'
import type { Command, CommandContext } from './runner'

/**
 * Linked files, for working on a project in parts (as worksessions or external references): another
 * model (.archi or .3dm) shown in this one as a block that stays tied to its file. UpdateLinks reads
 * the files again; the linked objects cannot be edited here. Their content is saved too, so the
 * model still shows them where the file cannot be found.
 */

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, '')
const linked = (ctx: CommandContext) => [...ctx.doc.blocks.values()].filter((b) => b.link)

/** Link: places another model in this one, tied to its file. */
const link: Command = {
  name: 'Link',
  async run(ctx) {
    const { doc, files, input, log } = ctx
    const picked = await files.pickLinkedFile()
    if (!picked) return
    const base = baseName(picked.fileName)
    let name = base
    for (let n = 2; doc.blocks.has(name); n++) name = `${base} ${n}`
    // Its layers come in under its name, so they can be shown and hidden apart from this model's.
    const { objects, scaledFrom } = adoptModel(doc, picked.model, (layer) => `${base}: ${layer}`)
    if (objects.length === 0) throw new Error(`${picked.fileName} has nothing to show`)
    const definition: BlockDefinition = { name, objects, link: { source: picked.source, fileName: picked.fileName } }
    doc.setBlock(name, definition)
    const r = await input.getPoint({ prompt: 'Where its origin goes <0,0,0>' })
    const at = r.kind === 'point' ? r.point : new Vector3()
    if (r.kind !== 'point' && r.kind !== 'enter') return
    const id = doc.add(placeInstance(definition, at), doc.currentLayerId).id
    doc.select([id])
    log(
      `${picked.fileName} linked as "${name}" (${plural('object', objects.length)}${scaledFrom ? `, scaled from ${scaledFrom.toLowerCase()}` : ''}). ` +
        (picked.source === picked.fileName ? 'In the browser it can be read again this session only; the desktop app reads it again any time' : 'UpdateLinks reads it again after it changes'),
    )
  },
}

/** UpdateLinks: reads every linked file again and shows it as it is now. */
const updateLinks: Command = {
  name: 'UpdateLinks',
  async run(ctx) {
    const { doc, files, log } = ctx
    const links = linked(ctx)
    if (links.length === 0) throw new Error('There are no linked files. Link one with Link')
    let updated = 0
    const missing: string[] = []
    const unreadable: string[] = []
    for (const definition of links) {
      const fileLink = definition.link!
      try {
        const model = await files.readLinkedFile(fileLink)
        if (!model) {
          unreadable.push(fileLink.fileName)
          continue
        }
        const { objects } = adoptModel(doc, model, (layer) => `${baseName(fileLink.fileName)}: ${layer}`)
        redefineBlock(doc, { ...definition, objects })
        updated++
      } catch {
        missing.push(fileLink.source)
      }
    }
    const parts = [`${plural('linked file', updated)} read again`]
    if (missing.length > 0) parts.push(`not found (kept as they were): ${missing.join(', ')}`)
    if (unreadable.length > 0) parts.push(`${unreadable.join(', ')} can only be read again in the desktop app, or after linking it again`)
    log(parts.join('; '))
  },
}

/** Unlink: makes linked files part of this model (plain blocks), to edit them here. */
const unlink: Command = {
  name: 'Unlink',
  async run(ctx) {
    const { doc, input, log } = ctx
    const links = linked(ctx)
    if (links.length === 0) throw new Error('There are no linked files')
    const names = links.map((b) => b.name)
    const option = links.length === 1 ? null : await input.getOption(`Linked file to make part of this model <All>`, ['All', ...names.map((n) => n.replace(/\s+/g, ''))])
    const chosen = option === null || isOption(option, 'All') ? links : links.filter((b) => isOption(option, b.name.replace(/\s+/g, '')))
    for (const definition of chosen) {
      redefineBlock(doc, { name: definition.name, objects: definition.objects })
    }
    log(`${plural('linked file', chosen.length)} now part of this model, as blocks: edit them with BlockEdit`)
  },
}

export const linkCommands: Command[] = [link, updateLinks, unlink]
