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

export const fileCommands: Command[] = [newFile, open, save, saveAs, importRhino, exportRhino]
