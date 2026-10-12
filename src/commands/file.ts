import { IFC } from '../app/files'
import { writeIfc } from '../io/ifc'
import { ifcModel } from '../io/ifcModel'
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

const importModel: Command = {
  name: 'Import',
  async run({ doc, files, display, log }) {
    const result = await files.importModel()
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
    const result = await files.exportRhino()
    if (!result) return
    const { exact, meshed } = result.report
    // How the surfaces and solids went: exactly, or as meshes where they have no exact Rhino form.
    const parts = [exact > 0 ? `${exact} exact` : '', meshed > 0 ? `${meshed} as ${meshed === 1 ? 'a mesh' : 'meshes'}` : ''].filter(Boolean)
    log(`Exported ${result.fileName}${parts.length > 0 ? ` (surfaces and solids: ${parts.join(', ')})` : ''}`)
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

/** Writes the building to an IFC4 file, for BIM tools (Revit, ArchiCAD, BIMcollab, ...). */
const exportIfc: Command = {
  name: 'ExportIFC',
  history: false,
  repeat: false,
  async run({ doc, files, log }) {
    const model = ifcModel(doc, files.name)
    if (model.elements.length === 0 && model.spaces.length === 0) throw new Error('There is nothing to export: the model has no solids, surfaces or meshes')
    const fileName = await files.exportFile(IFC, () => new TextEncoder().encode(writeIfc(model)))
    if (!fileName) return
    const counts = new Map<string, number>()
    for (const e of model.elements) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    if (model.spaces.length > 0) counts.set('IfcSpace', model.spaces.length)
    log(`Exported ${fileName}: ${[...counts].map(([type, n]) => `${n} ${type.replace(/^Ifc/, '')}`).join(', ')} on ${model.levels.length} storey${model.levels.length === 1 ? '' : 's'}`)
  },
}

export const fileCommands: Command[] = [newFile, open, save, saveAs, exportIfc, importModel, exportRhino, importStep, exportStep]
