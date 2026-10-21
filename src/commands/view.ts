import { language, LANGUAGES, setLanguage, type Language } from '../app/language'
import { isOption } from './helpers'
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

const UNITS = ['Millimeters', 'Centimeters', 'Meters', 'Inches', 'Feet']

const units: Command = {
  name: 'Units',
  history: false,
  repeat: false,
  async run({ doc, input, log }) {
    // Changing units relabels the model; it does not rescale it (as with Rhino's "No" to scaling).
    const option = await input.getOption(`Model units are ${doc.units}. New units`, UNITS)
    if (!option || option === doc.units) return
    doc.setUnits(option)
    log(`Model units set to ${option}. Geometry was not scaled`)
  },
}

/** Language: the language of menus, panels and messages. Command names stay the same in all. */
const languageCommand: Command = {
  name: 'Language',
  history: false,
  repeat: false,
  async run({ input }) {
    const names = Object.values(LANGUAGES).map((name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    const option = await input.getOption(`Language <${LANGUAGES[language()]}>`, names)
    const chosen = (Object.keys(LANGUAGES) as Language[]).find((code, i) => option !== null && isOption(option, names[i]))
    if (chosen) setLanguage(chosen)
  },
}

export const viewCommands: Command[] = [zoom, maxViewport, snap, ortho, osnap, units, languageCommand]
