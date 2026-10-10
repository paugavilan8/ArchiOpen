import { copyObjects, pasteObjects, readClipboard, readClipboardText, writeClipboardText } from '../app/clipboard'
import { plural } from './helpers'
import type { Command } from './runner'

/** Clipboard text handed to Paste by a paste event (Ctrl+V), which can read it without asking. */
let pending: string | null = null

/** Pastes `text` with the next run of Paste. */
export function pasteNext(text: string): void {
  pending = text
}

const copyToClipboard: Command = {
  name: 'CopyToClipboard',
  history: false,
  repeat: false,
  async run({ doc, input, log }) {
    const ids = await input.getObjects('Select objects to copy')
    await writeClipboardText(copyObjects(doc, ids))
    log(`${plural('object', ids.length)} copied to the clipboard`)
  },
}

const cut: Command = {
  name: 'Cut',
  repeat: false,
  async run({ doc, input, log }) {
    const ids = await input.getObjects('Select objects to cut')
    await writeClipboardText(copyObjects(doc, ids))
    for (const id of ids) doc.remove(id)
    log(`${plural('object', ids.length)} cut to the clipboard`)
  },
}

const paste: Command = {
  name: 'Paste',
  repeat: false,
  async run({ doc, log }) {
    const text = pending ?? (await readClipboardText())
    pending = null
    const data = readClipboard(text)
    if (!data) throw new Error('There are no ArchiOpen objects on the clipboard')
    const ids = pasteObjects(doc, data)
    doc.select(ids)
    const scaled = data.units !== doc.units ? ` (scaled from ${data.units.toLowerCase()})` : ''
    log(`${plural('object', ids.length)} pasted${scaled}`)
  },
}

export const clipboardCommands: Command[] = [copyToClipboard, cut, paste]
