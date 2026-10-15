/**
 * Autosave to a folder: every few minutes, while there are unsaved changes, a copy of the model is
 * written to a folder (ArchiOpen/Autosave in the local application data by default, never a synced folder) as `<name> <date> <time>.archi`.
 * The newest copies of each model are kept and older ones deleted. Any copy opens again with
 * `Autosave` > `Recover`, as an unsaved model. This is apart from the session kept in browser
 * storage, which only brings back what was on screen.
 */

export interface AutosaveSettings {
  enabled: boolean
  /** Minutes between copies. */
  minutes: number
  /** Copies kept for each model. */
  keep: number
  /** The folder; empty for the default one. */
  folder: string
}

export const DEFAULT_AUTOSAVE: AutosaveSettings = { enabled: true, minutes: 5, keep: 10, folder: '' }

const SETTINGS_KEY = 'archiopen:autosave'

/** Where the copies go: a folder on disk (the desktop app only). */
export interface AutosaveFolder {
  defaultFolder(): Promise<string>
  create(folder: string): Promise<void>
  /** The .archi files in the folder, with their modified times (ms). */
  list(folder: string): Promise<{ name: string; modified: number }[]>
  write(path: string, data: Uint8Array): Promise<void>
  read(path: string): Promise<Uint8Array>
  remove(path: string): Promise<void>
}

export function loadAutosaveSettings(): AutosaveSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_AUTOSAVE.enabled,
      minutes: Number.isFinite(saved.minutes) && saved.minutes > 0 ? saved.minutes : DEFAULT_AUTOSAVE.minutes,
      keep: Number.isInteger(saved.keep) && saved.keep > 0 ? saved.keep : DEFAULT_AUTOSAVE.keep,
      folder: typeof saved.folder === 'string' ? saved.folder : DEFAULT_AUTOSAVE.folder,
    }
  } catch {
    return { ...DEFAULT_AUTOSAVE }
  }
}

function storeSettings(settings: AutosaveSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Settings that cannot be stored last for this session.
  }
}

/** A model name made safe for a file name (no path separators or characters Windows refuses). */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The file name of a copy: the model's name and the local date and time, sorting by time. */
export function autosaveFileName(name: string, date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${safeName(name)} ${day} ${time}.archi`
}

const COPY = /^(.*) (\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})\.archi$/i

/** The model name and the time in a copy's file name, or null for other files. */
export function parseAutosaveName(fileName: string): { name: string; stamp: string } | null {
  const m = COPY.exec(fileName)
  return m ? { name: m[1], stamp: `${m[2]} ${m[3]}:${m[4]}:${m[5]}` } : null
}

/** The copies of a model past the newest `keep`, to delete. */
export function copiesToPrune(fileNames: string[], name: string, keep: number): string[] {
  const own = fileNames.filter((f) => parseAutosaveName(f)?.name === safeName(name)).sort()
  return own.slice(0, Math.max(0, own.length - keep))
}

/** A folder path and a file name joined with the folder's own separator. */
export function joinPath(folder: string, fileName: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return folder.endsWith(separator) ? folder + fileName : folder + separator + fileName
}

export interface AutosaveSource {
  /** The model's name. */
  name(): string
  /** True while there are unsaved changes. */
  modified(): boolean
  /** The model as an .archi file. */
  data(): Uint8Array
}

/** Writes the copies on a timer, when the model changed since the last one. */
export class Autosaver {
  settings: AutosaveSettings
  /** The last copy written (its path), if any. */
  last: string | null = null
  private changed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private writing = false

  constructor(
    private readonly source: AutosaveSource,
    readonly folder: AutosaveFolder | null,
    settings: AutosaveSettings = loadAutosaveSettings(),
  ) {
    this.settings = settings
  }

  get available(): boolean {
    return this.folder !== null
  }

  /** Marks that the model changed (call on every edit). */
  touch(): void {
    this.changed = true
  }

  /** Starts (or restarts) the timer with the current settings. */
  start(): void {
    this.stop()
    if (!this.folder || !this.settings.enabled) return
    this.timer = setInterval(() => void this.tick(), this.settings.minutes * 60_000)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  update(patch: Partial<AutosaveSettings>): void {
    this.settings = { ...this.settings, ...patch }
    storeSettings(this.settings)
    this.start()
  }

  /** The folder the copies go to. */
  async folderPath(): Promise<string> {
    if (!this.folder) throw new Error('Autosave to a folder needs the desktop app')
    return this.settings.folder || (await this.folder.defaultFolder())
  }

  /** A copy now if the model changed since the last one and is not saved; resolves to its path. */
  async tick(): Promise<string | null> {
    if (!this.changed || !this.source.modified() || this.writing) return null
    try {
      return await this.saveNow()
    } catch (error) {
      console.warn('Could not autosave', error)
      return null
    }
  }

  /** Writes a copy whatever the state, then deletes the oldest past the number kept. */
  async saveNow(date = new Date()): Promise<string> {
    const folder = this.folder
    if (!folder) throw new Error('Autosave to a folder needs the desktop app')
    this.writing = true
    try {
      const path = await this.folderPath()
      await folder.create(path)
      const fileName = autosaveFileName(this.source.name(), date)
      await folder.write(joinPath(path, fileName), this.source.data())
      this.changed = false
      this.last = joinPath(path, fileName)
      const names = (await folder.list(path)).map((f) => f.name)
      for (const old of copiesToPrune(names, this.source.name(), this.settings.keep)) await folder.remove(joinPath(path, old))
      return this.last
    } finally {
      this.writing = false
    }
  }

  /** The copies in the folder, newest first. */
  async copies(): Promise<{ fileName: string; name: string; stamp: string; path: string }[]> {
    if (!this.folder) return []
    const path = await this.folderPath()
    return (await this.folder.list(path))
      .flatMap((f) => {
        const parsed = parseAutosaveName(f.name)
        return parsed ? [{ fileName: f.name, ...parsed, path: joinPath(path, f.name) }] : []
      })
      .sort((a, b) => b.stamp.localeCompare(a.stamp) || a.name.localeCompare(b.name))
  }
}

/** The desktop app's folder access, through its own commands. */
export function desktopFolder(): AutosaveFolder {
  const invoke = async <T>(command: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(command, args)
  const toBase64 = (bytes: Uint8Array) => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
  }
  return {
    defaultFolder: () => invoke<string>('default_autosave_folder', {}),
    create: (path) => invoke<void>('create_folder', { path }),
    list: async (folder) => (await invoke<[string, number][]>('list_files', { folder, extension: 'archi' })).map(([name, modified]) => ({ name, modified })),
    write: (path, data) => invoke<void>('write_binary_file', { path, base64: toBase64(data) }),
    read: async (path) => Uint8Array.from(atob(await invoke<string>('read_binary_file', { path })), (c) => c.charCodeAt(0)),
    remove: (path) => invoke<void>('remove_file', { path }),
  }
}

let current: Autosaver | null = null

/** The app's autosaver (set up by the app). */
export const autosaver = (): Autosaver | null => current
export function setAutosaver(a: Autosaver): void {
  current = a
}
