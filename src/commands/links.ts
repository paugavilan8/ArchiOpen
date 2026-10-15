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

/** Link: places other models in this one, tied to their files (several can be chosen at once). */
const link: Command = {
  name: 'Link',
  async run(ctx) {
    const { doc, files, input, log } = ctx
    const picked = await files.pickLinkedFiles()
    if (picked.length === 0) return
    const definitions: BlockDefinition[] = []
    for (const file of picked) {
      const base = baseName(file.fileName)
      let name = base
      for (let n = 2; doc.blocks.has(name); n++) name = `${base} ${n}`
      // Its layers come in under its name, so they can be shown and hidden apart from this model's.
      const { objects } = adoptModel(doc, file.model, (layer) => `${base}: ${layer}`)
      if (objects.length === 0) {
        log(`${file.fileName} has nothing to show`)
        continue
      }
      const definition: BlockDefinition = { name, objects, link: { source: file.source, fileName: file.fileName } }
      doc.setBlock(name, definition)
      definitions.push(definition)
    }
    if (definitions.length === 0) return
    // Models of one project share their origin: all go to the same point.
    const r = await input.getPoint({ prompt: 'Where their origin goes <0,0,0>' })
    const at = r.kind === 'point' ? r.point : new Vector3()
    if (r.kind !== 'point' && r.kind !== 'enter') return
    doc.select(definitions.map((d) => doc.add(placeInstance(d, at), doc.currentLayerId).id))
    const browser = picked.some((f) => f.source === f.fileName)
    log(
      `Linked ${definitions.map((d) => `"${d.name}"`).join(', ')}. ` +
        (browser ? 'In the browser they can be read again this session only; the desktop app reads them again any time' : 'UpdateLinks reads them again after they change; EditLink opens one to change it'),
    )
  },
}

/** Reads every linked file again and shows it as it is now; returns what to report. */
async function updateAll(ctx: CommandContext): Promise<string> {
  const { doc, files } = ctx
  let updated = 0
  const missing: string[] = []
  const unreadable: string[] = []
  for (const definition of linked(ctx)) {
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
  return parts.join('; ')
}

/** UpdateLinks: reads every linked file again and shows it as it is now. */
const updateLinks: Command = {
  name: 'UpdateLinks',
  async run(ctx) {
    if (linked(ctx).length === 0) throw new Error('There are no linked files. Link one with Link')
    ctx.log(await updateAll(ctx))
  },
}

/** The model a linked file was opened from (EditLink), to go back to. */
const session: { host: string | null } = { host: null }

/** The linked file named by an answer, asking when there are several. */
async function chooseLink(ctx: CommandContext, prompt: string): Promise<BlockDefinition | null> {
  const links = linked(ctx)
  if (links.length === 0) throw new Error('There are no linked files')
  if (links.length === 1) return links[0]
  const option = await ctx.input.getOption(prompt, links.map((b) => b.name.replace(/\s+/g, '')))
  return option === null ? null : (links.find((b) => isOption(option, b.name.replace(/\s+/g, ''))) ?? null)
}

/**
 * EditLink: opens a linked file to change it (the desktop app). This model must be saved first;
 * ReturnToHost comes back to it with the change shown.
 */
const editLink: Command = {
  name: 'EditLink',
  history: false,
  repeat: false,
  async run(ctx) {
    const { files, display, log } = ctx
    const definition = await chooseLink(ctx, 'Linked file to edit')
    if (!definition) return
    const source = definition.link!.source
    if (!/[\\/]/.test(source)) throw new Error('A file linked in the browser cannot be opened by its path: open it with Open, or use the desktop app')
    const host = files.path
    if (!host) throw new Error('Save this model first, so it can be opened again after the edit')
    const message = await files.openPath(source)
    if (!message) return
    session.host = host
    display.fit(display.viewports)
    log(`${message}. Change it, save it, then ReturnToHost goes back to ${host.split(/[\\/]/).pop()} with it updated`)
  },
}

/** ReturnToHost: back to the model a linked file was opened from (EditLink), its links read again. */
const returnToHost: Command = {
  name: 'ReturnToHost',
  history: false,
  repeat: false,
  async run(ctx) {
    const { files, display, log } = ctx
    const host = session.host
    if (!host) throw new Error('No linked file is open for editing (EditLink opens one)')
    const message = await files.openPath(host)
    if (!message) return
    session.host = null
    display.fit(display.viewports)
    log(`${message}. ${await updateAll(ctx)}`)
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

export const linkCommands: Command[] = [link, updateLinks, unlink, editLink, returnToHost]
