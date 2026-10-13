import { IFC } from '../app/files'
import { checkForUpdates } from '../app/updates'
import { writeIfc } from '../io/ifc'
import { ifcModel } from '../io/ifcModel'
import { autosaver } from '../app/autosave'
import { isOption, valueOption, yesNo } from './helpers'
import { framesFor, wallPieces } from '../app/ifcNative'
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
  async run(ctx) {
    const { files, display, log, doc } = ctx
    log('Choose a model: .archi, .3dm, .ifc, .dxf, .dwg, .stl or .obj')
    const message = await files.open()
    if (!message) return
    // Walls made from an IFC file get the frames and glass of their doors and windows.
    if (files.nativeWalls.length > 0) {
      await framesFor(ctx, files.nativeWalls)
      await ctx.history?.settled
      doc.modified = false
    }
    display.fit(display.viewports)
    log(message)
    const links = [...doc.blocks.values()].filter((b) => b.link).length
    if (links > 0) log(`This model links ${links} file${links === 1 ? '' : 's'}: UpdateLinks reads them again as they are now`)
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
  async run(ctx) {
    const { doc, files, display, log } = ctx
    files.nativeWalls = []
    const result = await files.importModel()
    if (!result) return
    if (files.nativeWalls.length > 0) {
      // The import is a step of its own; each wall is then made again in its own.
      doc.commit()
      await framesFor(ctx, files.nativeWalls)
      doc.begin()
    }
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
    // Walls along several segments go as one wall for each.
    const model = ifcModel(doc, files.name, await wallPieces(doc))
    if (model.elements.length === 0 && model.spaces.length === 0) throw new Error('There is nothing to export: the model has no solids, surfaces or meshes')
    const fileName = await files.exportFile(IFC, () => new TextEncoder().encode(writeIfc(model)))
    if (!fileName) return
    const counts = new Map<string, number>()
    for (const e of model.elements) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    if (model.spaces.length > 0) counts.set('IfcSpace', model.spaces.length)
    log(`Exported ${fileName}: ${[...counts].map(([type, n]) => `${n} ${type.replace(/^Ifc/, '')}`).join(', ')} on ${model.levels.length} storey${model.levels.length === 1 ? '' : 's'}`)
  },
}

/**
 * Autosave: copies of the model in a folder every few minutes while there are unsaved changes (the
 * desktop app only). Options set it up; Recover opens one of the copies.
 */
const autosave: Command = {
  name: 'Autosave',
  history: false,
  repeat: false,
  async run({ input, files, display, log }) {
    const saver = autosaver()
    if (!saver?.available) {
      log('Autosave to a folder needs the desktop app; in the browser the session is kept in its storage')
      return
    }
    for (;;) {
      const s = saver.settings
      log(`Autosave ${s.enabled ? `every ${s.minutes} min` : 'off'}, keeping ${s.keep} copies of each model in ${await saver.folderPath()}`)
      const option = await input.getOption('Autosave', [yesNo('Enabled', s.enabled), valueOption('Minutes', s.minutes), valueOption('Keep', s.keep), 'Folder', 'SaveNow', 'Recover'])
      if (option === null) return
      if (isOption(option, 'Enabled')) saver.update({ enabled: !s.enabled })
      else if (isOption(option, 'Minutes')) {
        const v = await input.getNumber('Minutes between copies', s.minutes)
        if (typeof v === 'number' && v >= 0.5) saver.update({ minutes: v })
      } else if (isOption(option, 'Keep')) {
        const v = await input.getNumber('Copies kept for each model', s.keep)
        if (typeof v === 'number' && v >= 1) saver.update({ keep: Math.round(v) })
      } else if (isOption(option, 'Folder')) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const folder = await open({ directory: true, multiple: false, defaultPath: await saver.folderPath() })
        if (typeof folder === 'string') saver.update({ folder })
      } else if (isOption(option, 'SaveNow')) {
        log(`Copy saved: ${await saver.saveNow()}`)
      } else if (isOption(option, 'Recover')) {
        const copies = await saver.copies()
        if (copies.length === 0) {
          log('There are no copies in the folder yet')
          continue
        }
        const shown = copies.slice(0, 20)
        shown.forEach((c, i) => log(`${i + 1}. ${c.name}, ${c.stamp}`))
        const n = await input.getNumber(`Copy to open (1-${shown.length})`, 1)
        const copy = typeof n === 'number' ? shown[Math.round(n) - 1] : undefined
        if (!copy) continue
        if (await files.openCopy(copy.name, await saver.folder!.read(copy.path))) {
          display.fit(display.viewports)
          log(`Opened the copy of ${copy.name} from ${copy.stamp}. Save it to keep it`)
        }
        return
      }
    }
  },
}

/** CheckForUpdates: installs a newer version of the desktop app, if there is one. */
const checkUpdates: Command = {
  name: 'CheckForUpdates',
  history: false,
  repeat: false,
  async run({ doc, log }) {
    await checkForUpdates(log, () => doc.modified)
  },
}

export const fileCommands: Command[] = [newFile, open, save, saveAs, autosave, exportIfc, importModel, exportRhino, importStep, exportStep, checkUpdates]
