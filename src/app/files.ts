import type { Document } from '../core/document'
import { readDxf } from '../io/dxfRead'
import { readObj, readStl } from '../io/meshFiles'
import { describeSkipped, readRhinoFile, RhinoImport, writeRhinoFile } from '../io/rhino3dm'
import { loadRhino } from '../io/loadRhino'
import { toBrep } from '../kernel/brep'
import { shapeFromRhino } from '../kernel/fromRhino'
import { loadKernel } from '../kernel/loadKernel'
import { readStep, StepObject, writeStep } from '../kernel/step'
import { applyRhinoImport, mergeRhinoImport } from './rhinoModel'

interface FileType {
  name: string
  /** Extension used when saving. */
  extension: string
  /** Every extension accepted when opening, if more than one. */
  extensions?: string[]
  mime: string
}

export const ARCHI: FileType = { name: 'ArchiOpen model', extension: 'archi', mime: 'application/json' }
export const RHINO: FileType = { name: 'Rhino 3D model', extension: '3dm', mime: 'application/octet-stream' }
export const PDF: FileType = { name: 'PDF drawing', extension: 'pdf', mime: 'application/pdf' }
export const DXF: FileType = { name: 'DXF drawing', extension: 'dxf', mime: 'application/dxf' }
export const STEP: FileType = { name: 'STEP model', extension: 'step', extensions: ['step', 'stp'], mime: 'model/step' }
export const STL: FileType = { name: 'STL mesh', extension: 'stl', mime: 'model/stl' }
export const OBJ: FileType = { name: 'OBJ mesh', extension: 'obj', mime: 'model/obj' }
const UNTITLED = 'Untitled'

const isMeshFile = (fileName: string) => [STL.extension, OBJ.extension].includes(extensionOf(fileName))

/** An STL or OBJ file as an import: its meshes (and OBJ lines) on one layer named after the file. */
function readMeshFile(fileName: string, bytes: Uint8Array, units: string): RhinoImport {
  const layer = { name: baseName(fileName), color: '#000000', visible: true, locked: false }
  const objects: RhinoImport['objects'] =
    extensionOf(fileName) === STL.extension
      ? [{ layer: 0, geometry: readStl(bytes) }]
      : (() => {
          const { meshes, lines } = readObj(new TextDecoder().decode(bytes))
          return [...meshes.map((m) => ({ layer: 0, geometry: m.mesh })), ...lines.map((l) => ({ layer: 0, geometry: l }))]
        })()
  return { units, layers: [layer], objects, breps: [], tolerance: 0, skipped: new Map() }
}
const NOT_REBUILT: [string, string] = ['polysurface that could not be rebuilt', 'polysurfaces that could not be rebuilt']

/** True when running inside the desktop shell rather than a plain browser tab. */
export const isDesktop = '__TAURI_INTERNALS__' in window

// Minimal typing for the File System Access API, which only Chromium-based browsers provide.
interface PickerFileHandle {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>
}
type PickerWindow = Window & {
  showOpenFilePicker?: (options: object) => Promise<PickerFileHandle[]>
  showSaveFilePicker?: (options: object) => Promise<PickerFileHandle>
}
const pickers = window as PickerWindow

/** Where a file lives: a path on the desktop, or a picker handle in the browser. */
type Location = { kind: 'path'; path: string } | { kind: 'handle'; handle: PickerFileHandle }

interface PickedFile {
  /** File name with its extension. */
  fileName: string
  location: Location | null
  read(): Promise<Uint8Array>
}

// --- Platform file access ------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const extensionsOf = (t: FileType) => t.extensions ?? [t.extension]
const dialogFilters = (types: FileType[]) => types.map((t) => ({ name: t.name, extensions: extensionsOf(t) }))
const pickerTypes = (types: FileType[]) => types.map((t) => ({ description: t.name, accept: { [t.mime]: extensionsOf(t).map((e) => `.${e}`) } }))

async function pickFile(types: FileType[]): Promise<PickedFile | null> {
  if (isDesktop) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const filters = types.length > 1 ? [{ name: 'Models', extensions: types.flatMap(extensionsOf) }, ...dialogFilters(types)] : dialogFilters(types)
    const path = await open({ multiple: false, directory: false, filters })
    if (typeof path !== 'string') return null
    const { invoke } = await import('@tauri-apps/api/core')
    return {
      fileName: fileNameOf(path),
      location: { kind: 'path', path },
      read: async () => fromBase64(await invoke<string>('read_binary_file', { path })),
    }
  }
  if (pickers.showOpenFilePicker) {
    try {
      const [handle] = await pickers.showOpenFilePicker({ types: pickerTypes(types) })
      return { fileName: handle.name, location: { kind: 'handle', handle }, read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()) }
    } catch {
      return null // The user closed the picker.
    }
  }
  const file = await pickWithInput(types)
  return file ? { fileName: file.name, location: null, read: async () => new Uint8Array(await file.arrayBuffer()) } : null
}

/** Asks where to save. Null means cancelled; 'download' means the browser can only offer a download. */
async function pickSaveLocation(suggestedName: string, type: FileType): Promise<Location | 'download' | null> {
  if (isDesktop) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: `${suggestedName}.${type.extension}`, filters: dialogFilters([type]) })
    return path ? { kind: 'path', path: withExtension(path, type) } : null
  }
  if (pickers.showSaveFilePicker) {
    try {
      return { kind: 'handle', handle: await pickers.showSaveFilePicker({ suggestedName: `${suggestedName}.${type.extension}`, types: pickerTypes([type]) }) }
    } catch {
      return null
    }
  }
  return 'download'
}

async function writeFile(location: Location | 'download', data: Uint8Array, fileName: string, type: FileType): Promise<void> {
  if (location === 'download') {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([data as BlobPart], { type: type.mime }))
    link.download = fileName
    link.click()
    URL.revokeObjectURL(link.href)
  } else if (location.kind === 'path') {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_binary_file', { path: location.path, base64: toBase64(data) })
  } else {
    const writable = await location.handle.createWritable()
    await writable.write(new Blob([data as BlobPart], { type: type.mime }))
    await writable.close()
  }
}

function pickWithInput(types: FileType[]): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = types.flatMap(extensionsOf).map((e) => `.${e}`).join(',')
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function withExtension(path: string, type: FileType): string {
  return path.toLowerCase().endsWith(`.${type.extension}`) ? path : `${path}.${type.extension}`
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.\\/]+$/, '')
}

// --- Document files ------------------------------------------------------------------

/** New / Open / Save / Import / Export for the document, with a desktop and a browser implementation. */
export class FileManager {
  name = UNTITLED
  /** Where Save writes. Only ever an .archi file: an opened .3dm is never overwritten by Save. */
  private location: Location | null = null
  private listeners = new Set<() => void>()

  constructor(private readonly doc: Document) {}

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Path of the file on disk, when known. Kept with the autosave so a restored session keeps its file. */
  get path(): string | null {
    return this.location?.kind === 'path' ? this.location.path : null
  }

  restore(name: string, path: string | null): void {
    this.name = name
    this.location = path ? { kind: 'path', path } : null
    this.emit()
  }

  /** Asks before throwing away unsaved changes. Resolves to true if it is fine to continue. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.doc.modified) return true
    const message = `Discard the unsaved changes to "${this.name}"?`
    if (isDesktop) {
      const { ask } = await import('@tauri-apps/plugin-dialog')
      return ask(message, { title: 'ArchiOpen', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' })
    }
    return window.confirm(message)
  }

  async newFile(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false
    this.doc.clear()
    this.setLocation(UNTITLED, null)
    return true
  }

  /**
   * Opens an .archi or .3dm file in place of the current document. Resolves to a message for the
   * command history, or null if nothing was opened.
   */
  async open(): Promise<string | null> {
    if (!(await this.confirmDiscard())) return null
    const file = await pickFile([ARCHI, RHINO, DXF, STL, OBJ])
    if (!file) return null
    const bytes = await file.read()
    if (isMeshFile(file.fileName)) {
      // STL and OBJ have no units; millimeters are the usual ones for 3D printing.
      const result = readMeshFile(file.fileName, bytes, 'Millimeters')
      applyRhinoImport(this.doc, result)
      this.setLocation(baseName(file.fileName), null)
      return `Opened ${file.fileName}: ${this.rhinoSummary(result)}, taken as millimeters (Units changes them)`
    }
    if (extensionOf(file.fileName) === DXF.extension) {
      // DXF files without units are taken as millimeters.
      const result = readDxf(bytes, 'Millimeters')
      applyRhinoImport(this.doc, result)
      this.setLocation(baseName(file.fileName), null)
      return `Opened ${file.fileName}: ${this.rhinoSummary(result)}. Save stores it as an .archi file; use ExportDXF to write a DXF`
    }
    if (extensionOf(file.fileName) === RHINO.extension) {
      const result = await this.readRhino(bytes)
      applyRhinoImport(this.doc, result)
      // Saving must not overwrite the Rhino file (it may hold objects that were not loaded).
      this.setLocation(baseName(file.fileName), null)
      return `Opened ${file.fileName}: ${this.rhinoSummary(result)}. Save stores it as an .archi file; use Export to write a .3dm`
    }
    this.doc.load(JSON.parse(new TextDecoder().decode(bytes)))
    this.setLocation(baseName(file.fileName), file.location)
    return `Opened ${file.fileName}`
  }

  /** Saves to the current file, or asks for one if there is none yet (or if `saveAs` is set). */
  async save(saveAs = false): Promise<boolean> {
    const location = !saveAs && this.location ? this.location : await pickSaveLocation(this.name, ARCHI)
    if (!location) return false
    const data = new TextEncoder().encode(JSON.stringify(this.doc.toJSON(), null, 1))
    await writeFile(location, data, `${this.name}.${ARCHI.extension}`, ARCHI)
    this.doc.modified = false
    if (location === 'download') this.emit()
    else this.setLocation(baseName(location.kind === 'path' ? fileNameOf(location.path) : location.handle.name), location)
    return true
  }

  /** Adds the contents of a .3dm, .dxf, .stl or .obj file to the document. Resolves to the new object ids, or null. */
  async importModel(): Promise<{ ids: number[]; message: string } | null> {
    const file = await pickFile([RHINO, DXF, STL, OBJ])
    if (!file) return null
    const bytes = await file.read()
    // Files without units (DXF without $INSUNITS, STL, OBJ) are taken to be in the model's units.
    const result = isMeshFile(file.fileName)
      ? readMeshFile(file.fileName, bytes, this.doc.units)
      : extensionOf(file.fileName) === DXF.extension
        ? readDxf(bytes, this.doc.units)
        : await this.readRhino(bytes)
    const { ids, scaledFrom } = mergeRhinoImport(this.doc, result)
    const scaled = scaledFrom ? `, scaled from ${scaledFrom.toLowerCase()} to ${this.doc.units.toLowerCase()}` : ''
    return { ids, message: `Imported ${file.fileName}: ${this.rhinoSummary(result)}${scaled}` }
  }

  /** Writes the document's curves to a .3dm file. Resolves to the file name, or null if cancelled. */
  async exportRhino(): Promise<string | null> {
    const location = await pickSaveLocation(this.name, RHINO)
    if (!location) return null
    const rhino = await loadRhino()
    const bytes = writeRhinoFile(rhino, {
      units: this.doc.units,
      layers: this.doc.layers,
      objects: [...this.doc.objects.values()].map((o) => ({ layerId: o.layerId, geometry: o.geometry })),
    })
    const fileName = location === 'download' ? `${this.name}.${RHINO.extension}` : location.kind === 'path' ? fileNameOf(location.path) : location.handle.name
    await writeFile(location, bytes, fileName, RHINO)
    return fileName
  }

  /** Asks where to save, then writes the bytes made by `make`. Resolves to the file name, or null if cancelled. */
  async exportFile(type: FileType, make: () => Promise<Uint8Array> | Uint8Array): Promise<string | null> {
    const location = await pickSaveLocation(this.name, type)
    if (!location) return null
    const bytes = await make()
    const fileName = location === 'download' ? `${this.name}.${type.extension}` : location.kind === 'path' ? fileNameOf(location.path) : location.handle.name
    await writeFile(location, bytes, fileName, type)
    return fileName
  }

  /** Writes objects to a STEP file. Resolves to the file name, or null if cancelled. */
  async exportStep(objects: StepObject[]): Promise<string | null> {
    const location = await pickSaveLocation(this.name, STEP)
    if (!location) return null
    await loadKernel()
    const bytes = await writeStep(objects, this.doc.units)
    const fileName = location === 'download' ? `${this.name}.${STEP.extension}` : location.kind === 'path' ? fileNameOf(location.path) : location.handle.name
    await writeFile(location, bytes, fileName, STEP)
    return fileName
  }

  /** Adds the solids and surfaces of a STEP file to the current layer. Resolves to the new ids, or null. */
  async importStep(): Promise<{ ids: number[]; message: string } | null> {
    const file = await pickFile([STEP])
    if (!file) return null
    const bytes = await file.read()
    await loadKernel()
    const { shapes, curves } = await readStep(bytes, this.doc.units)
    const ids = [...shapes.map((shape) => this.doc.add(toBrep(shape)).id), ...curves.map((curve) => this.doc.add(curve).id)]
    const parts = [`${shapes.length} solid${shapes.length === 1 ? '' : 's'} or surface${shapes.length === 1 ? '' : 's'}`]
    if (curves.length > 0) parts.push(`${curves.length} curve${curves.length === 1 ? '' : 's'}`)
    return { ids, message: `Imported ${file.fileName}: ${parts.join(' and ')}, in ${this.doc.units.toLowerCase()}` }
  }

  /** Reads a .3dm; its polysurfaces are rebuilt as exact shapes with the geometry kernel. */
  private async readRhino(bytes: Uint8Array): Promise<RhinoImport> {
    const result = readRhinoFile(await loadRhino(), bytes)
    if (result.breps.length === 0) return result
    await loadKernel()
    for (const { layer, data } of result.breps) {
      try {
        result.objects.push({ layer, geometry: toBrep(shapeFromRhino(data, result.tolerance)) })
      } catch (error) {
        console.warn('Could not rebuild a polysurface', error)
        result.skipped.set(NOT_REBUILT, (result.skipped.get(NOT_REBUILT) ?? 0) + 1)
      }
    }
    return result
  }

  private rhinoSummary(result: RhinoImport): string {
    const breps = result.objects.filter((o) => o.geometry.type === 'brep').length
    const meshes = result.objects.filter((o) => o.geometry.type === 'mesh').length
    const curveCount = result.objects.length - breps - meshes
    const parts = curveCount > 0 || breps + meshes === 0 ? [`${curveCount} object${curveCount === 1 ? '' : 's'}`] : []
    if (breps > 0) parts.push(`${breps} polysurface${breps === 1 ? '' : 's'}`)
    if (meshes > 0) parts.push(`${meshes} mesh${meshes === 1 ? '' : 'es'}`)
    const curves = `${parts.join(' and ')} on ${result.layers.length} layer${result.layers.length === 1 ? '' : 's'}`
    const skipped = describeSkipped(result.skipped)
    return skipped ? `${curves}. Not loaded yet: ${skipped}` : curves
  }

  private setLocation(name: string, location: Location | null): void {
    this.name = name
    this.location = location
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
