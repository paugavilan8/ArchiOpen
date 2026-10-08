import type { Document } from '../core/document'

export const FILE_EXTENSION = 'archi'
const UNTITLED = 'Untitled'
const FILTERS = [{ name: 'ArchiOpen model', extensions: [FILE_EXTENSION] }]
const PICKER_TYPES = [{ description: 'ArchiOpen model', accept: { 'application/json': [`.${FILE_EXTENSION}`] } }]

/** True when running inside the desktop shell rather than a plain browser tab. */
export const isDesktop = '__TAURI_INTERNALS__' in window

// Minimal typing for the File System Access API, which only Chromium-based browsers provide.
interface PickerFileHandle {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
}
type PickerWindow = Window & {
  showOpenFilePicker?: (options: object) => Promise<PickerFileHandle[]>
  showSaveFilePicker?: (options: object) => Promise<PickerFileHandle>
}
const pickers = window as PickerWindow

/** Where the current document lives: a path on the desktop, a picker handle in the browser, or nowhere yet. */
type Location = { kind: 'path'; path: string } | { kind: 'handle'; handle: PickerFileHandle } | null

/** New / Open / Save for the document, with a desktop and a browser implementation. */
export class FileManager {
  name = UNTITLED
  private location: Location = null
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

  async open(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false
    const file = await this.pickAndRead()
    if (!file) return false
    this.doc.load(JSON.parse(file.text))
    this.setLocation(file.name, file.location)
    return true
  }

  /** Saves to the current file, or asks for one if there is none yet (or if `saveAs` is set). */
  async save(saveAs = false): Promise<boolean> {
    const text = JSON.stringify(this.doc.toJSON(), null, 1)
    let location = saveAs ? null : this.location
    let name = this.name

    if (isDesktop) {
      if (!location) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({ defaultPath: `${this.name}.${FILE_EXTENSION}`, filters: FILTERS })
        if (!path) return false
        location = { kind: 'path', path: withExtension(path) }
      }
      if (location.kind !== 'path') return false
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_text_file', { path: location.path, contents: text })
      name = baseName(location.path)
    } else if (pickers.showSaveFilePicker) {
      if (!location) {
        try {
          const handle = await pickers.showSaveFilePicker({ suggestedName: `${this.name}.${FILE_EXTENSION}`, types: PICKER_TYPES })
          location = { kind: 'handle', handle }
        } catch {
          return false // The user closed the picker.
        }
      }
      if (location.kind !== 'handle') return false
      const writable = await location.handle.createWritable()
      await writable.write(text)
      await writable.close()
      name = baseName(location.handle.name)
    } else {
      // No way to write to disk: hand the file over as a download.
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      link.download = `${this.name}.${FILE_EXTENSION}`
      link.click()
      URL.revokeObjectURL(link.href)
    }

    this.doc.modified = false
    this.setLocation(name, location)
    return true
  }

  private async pickAndRead(): Promise<{ name: string; text: string; location: Location } | null> {
    if (isDesktop) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const path = await open({ multiple: false, directory: false, filters: FILTERS })
      if (typeof path !== 'string') return null
      const { invoke } = await import('@tauri-apps/api/core')
      const text = await invoke<string>('read_text_file', { path })
      return { name: baseName(path), text, location: { kind: 'path', path } }
    }
    if (pickers.showOpenFilePicker) {
      try {
        const [handle] = await pickers.showOpenFilePicker({ types: PICKER_TYPES })
        const text = await (await handle.getFile()).text()
        return { name: baseName(handle.name), text, location: { kind: 'handle', handle } }
      } catch {
        return null
      }
    }
    const file = await pickWithInput()
    return file ? { name: baseName(file.name), text: await file.text(), location: null } : null
  }

  private setLocation(name: string, location: Location): void {
    this.name = name
    this.location = location
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `.${FILE_EXTENSION},application/json`
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

function withExtension(path: string): string {
  return path.toLowerCase().endsWith(`.${FILE_EXTENSION}`) ? path : `${path}.${FILE_EXTENSION}`
}

function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return file.replace(new RegExp(`\\.${FILE_EXTENSION}$`, 'i'), '')
}
