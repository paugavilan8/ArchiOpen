import type { Command } from './runner'

const zoom: Command = {
  name: 'Zoom',
  history: false,
  async run({ doc, display, input, log }) {
    const option = await input.getOption('Zoom', ['All', 'Extents', 'Selected'])
    if (option === 'All') display.fit(display.viewports)
    else if (option === 'Extents') display.fit([display.active])
    else if (option === 'Selected') {
      if (doc.selection.size === 0) log('Nothing selected')
      else display.fit([display.active], doc.selection)
    }
  },
}

const maxViewport: Command = {
  name: 'MaxViewport',
  history: false,
  run: ({ display }) => display.toggleMaximize(),
}

const snap: Command = {
  name: 'Snap',
  history: false,
  repeat: false,
  run: ({ settings, log }) => log(`Grid snap ${settings.toggle('gridSnap') ? 'on' : 'off'}`),
}

const ortho: Command = {
  name: 'Ortho',
  history: false,
  repeat: false,
  run: ({ settings, log }) => log(`Ortho ${settings.toggle('ortho') ? 'on' : 'off'}`),
}

const osnap: Command = {
  name: 'Osnap',
  history: false,
  repeat: false,
  run: ({ settings, log }) => log(`Object snap ${settings.toggle('osnap') ? 'on' : 'off'}`),
}

export const viewCommands: Command[] = [zoom, maxViewport, snap, ortho, osnap]
