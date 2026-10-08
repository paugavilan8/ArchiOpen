import type { Command } from './runner'

const newFile: Command = {
  name: 'New',
  history: false,
  repeat: false,
  async run({ files, display }) {
    if (await files.newFile()) display.fit(display.viewports)
  },
}

const open: Command = {
  name: 'Open',
  history: false,
  repeat: false,
  async run({ files, display, log }) {
    log('Choose an .archi or .3dm file')
    const message = await files.open()
    if (!message) return
    display.fit(display.viewports)
    log(message)
  },
}

const save: Command = {
  name: 'Save',
  history: false,
  repeat: false,
  async run({ files, log }) {
    if (await files.save()) log(`Saved ${files.name}`)
  },
}

const saveAs: Command = {
  name: 'SaveAs',
  history: false,
  repeat: false,
  async run({ files, log }) {
    if (await files.save(true)) log(`Saved ${files.name}`)
  },
}

const importRhino: Command = {
  name: 'Import',
  async run({ doc, files, display, log }) {
    const result = await files.importRhino()
    if (!result) return
    doc.select(result.ids)
    display.fit(display.viewports, result.ids)
    log(result.message)
  },
}

const exportRhino: Command = {
  name: 'Export',
  history: false,
  repeat: false,
  async run({ files, log }) {
    const fileName = await files.exportRhino()
    if (fileName) log(`Exported ${fileName}`)
  },
}

const exportStep: Command = {
  name: 'ExportSTEP',
  history: false,
  repeat: false,
  async run({ doc, files, log }) {
    // The selection if there is one, otherwise everything visible.
    const chosen = doc.selection.size > 0 ? [...doc.selection].map((id) => doc.objects.get(id)!) : [...doc.objects.values()].filter((o) => doc.isVisible(o))
    if (chosen.length === 0) throw new Error('There is nothing to export')
    const objects = chosen.map((o) => {
      const layer = doc.layerOf(o)
      return { geometry: o.geometry, name: layer.name, color: layer.color }
    })
    log(`Exporting ${objects.length} object${objects.length === 1 ? '' : 's'} to STEP…`)
    const fileName = await files.exportStep(objects)
    if (fileName) log(`Exported ${fileName}`)
  },
}

const importStep: Command = {
  name: 'ImportSTEP',
  async run({ doc, files, display, log }) {
    const result = await files.importStep()
    if (!result) return
    doc.select(result.ids)
    display.fit(display.viewports, result.ids)
    log(result.message)
  },
}

export const fileCommands: Command[] = [newFile, open, save, saveAs, importRhino, exportRhino, importStep, exportStep]
