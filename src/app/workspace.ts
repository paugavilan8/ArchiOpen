import { Document } from '../core/document'
import tower from '../../examples/scripts/tower.js?raw'
import twistingTower from '../../examples/scripts/twisting-tower.js?raw'
import columnGrid from '../../examples/scripts/column-grid.js?raw'
import house from '../../examples/scripts/house.js?raw'

/**
 * ArchiOpen's own folder on the desktop, in the local application data (never Documents, which is
 * often synced to OneDrive): Templates (models to start from), Scripts (the examples, to copy and
 * change) and Autosave. Made, and filled with what ships with the app, the first time it is needed.
 */

const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const TEMPLATES = 'Templates'
export const SCRIPTS = 'Scripts'

const EXAMPLE_SCRIPTS: Record<string, string> = { 'house.js': house, 'tower.js': tower, 'twisting-tower.js': twistingTower, 'column-grid.js': columnGrid }

/** A path inside a folder, with the folder's own separator. */
export function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return folder.endsWith(separator) ? folder + name : folder + separator + name
}

/** The model new projects start from when there is no other template: levels and the usual layers. */
export function defaultTemplate(): Uint8Array {
  const doc = new Document()
  for (const [name, color] of [
    ['Walls', '#555555'],
    ['Slabs', '#777777'],
    ['Doors', '#8a5a2b'],
    ['Windows', '#2b6ca3'],
    ['Furniture', '#9a9a9a'],
    ['Dimensions', '#000000'],
    ['Rooms', '#b0802f'],
  ]) {
    const layer = doc.addLayer()
    doc.updateLayer(layer.id, { name, color })
  }
  return new TextEncoder().encode(JSON.stringify(doc.toJSON(), null, 1))
}

let ready: Promise<string | null> | null = null

/**
 * The folder, made and filled if it is not yet: the default template and the example scripts, only
 * where they are missing (anything changed or added there is kept). Null outside the desktop app.
 */
export function workspaceFolder(): Promise<string | null> {
  if (!isDesktop) return Promise.resolve(null)
  ready ??= (async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const root = await invoke<string>('app_data_folder')
    const write = async (folder: string, files: Record<string, Uint8Array>) => {
      const path = joinPath(root, folder)
      await invoke('create_folder', { path })
      const existing = new Set((await invoke<[string, number][]>('list_files', { folder: path, extension: folder === TEMPLATES ? 'archi' : 'js' })).map(([name]) => name))
      for (const [name, bytes] of Object.entries(files)) {
        if (folder === TEMPLATES && existing.size > 0) break // Only into an empty templates folder.
        if (existing.has(name)) continue
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        await invoke('write_binary_file', { path: joinPath(path, name), base64: btoa(binary) })
      }
    }
    await write(TEMPLATES, { 'Architecture.archi': defaultTemplate() })
    await write(SCRIPTS, Object.fromEntries(Object.entries(EXAMPLE_SCRIPTS).map(([n, t]) => [n, new TextEncoder().encode(t)])))
    return root
  })().catch((error) => {
    ready = null
    throw error
  })
  return ready
}

/** The templates there are: their names (without .archi), newest first. */
export async function templates(): Promise<string[]> {
  const root = await workspaceFolder()
  if (!root) return []
  const { invoke } = await import('@tauri-apps/api/core')
  const files = await invoke<[string, number][]>('list_files', { folder: joinPath(root, TEMPLATES), extension: 'archi' })
  return files.sort((a, b) => b[1] - a[1]).map(([name]) => name.replace(/\.archi$/i, ''))
}
