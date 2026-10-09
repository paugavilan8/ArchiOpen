import { plural, yesNo } from './helpers'
import type { Command } from './runner'

/** Construction history: turning it on and off, and finding or dropping the links it keeps. */

const historyCommand: Command = {
  name: 'History',
  history: false,
  async run({ settings, input, log }) {
    const option = await input.getOption('Construction history', [yesNo('Record', settings.history)])
    if (option === null) return
    settings.toggle('history')
    log(settings.history ? 'History on: surfaces made from curves follow them when they change' : 'History off for new objects')
  },
}

const historyPurge: Command = {
  name: 'HistoryPurge',
  async run({ doc, input, log }) {
    const ids = (await input.getObjects('Select objects to forget their history')).filter((id) => doc.objects.get(id)?.history)
    for (const id of ids) doc.setHistory(id, undefined)
    log(ids.length === 0 ? 'None of these has history' : `${plural('object', ids.length)} no longer follow their curves`)
  },
}

const selChildren: Command = {
  name: 'SelChildren',
  history: false,
  async run({ doc, input, log }) {
    const parents = new Set(await input.getObjects('Select objects whose children to select'))
    const children = [...doc.objects.values()].filter((o) => o.history?.inputs.some((id) => parents.has(id)) && doc.isSelectable(o)).map((o) => o.id)
    doc.select(children)
    log(children.length === 0 ? 'No objects were made from these with history' : `${children.length} ${children.length === 1 ? 'child' : 'children'} selected`)
  },
}

const selParents: Command = {
  name: 'SelParents',
  history: false,
  async run({ doc, input, log }) {
    const ids = await input.getObjects('Select objects whose parents to select')
    const parents = new Set(ids.flatMap((id) => doc.objects.get(id)?.history?.inputs ?? []))
    const selectable = [...parents].filter((id) => doc.objects.has(id) && doc.isSelectable(doc.objects.get(id)!))
    doc.select(selectable)
    log(selectable.length === 0 ? 'These have no history' : `${plural('parent', selectable.length)} selected`)
  },
}

export const historyCommands: Command[] = [historyCommand, historyPurge, selChildren, selParents]
