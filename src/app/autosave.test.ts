import { describe, expect, it } from 'vitest'
import { Autosaver, autosaveFileName, copiesToPrune, DEFAULT_AUTOSAVE, joinPath, parseAutosaveName, safeName, type AutosaveFolder } from './autosave'

/** A folder in memory. */
function memoryFolder() {
  const files = new Map<string, Uint8Array>()
  const folder: AutosaveFolder = {
    defaultFolder: async () => '/home/me/Documents/ArchiOpen/Autosave',
    create: async () => {},
    list: async (path) => [...files.keys()].filter((p) => p.startsWith(path + '/')).map((p) => ({ name: p.slice(path.length + 1), modified: 0 })),
    write: async (path, data) => void files.set(path, data),
    read: async (path) => files.get(path)!,
    remove: async (path) => void files.delete(path),
  }
  return { files, folder }
}

describe('autosave names', () => {
  it('names copies by model and local time, so they sort by time', () => {
    const name = autosaveFileName('Casa: planta/baja', new Date(2026, 9, 12, 9, 5, 7))
    expect(name).toBe('Casa_ planta_baja 2026-10-12 09-05-07.archi')
    expect(parseAutosaveName(name)).toEqual({ name: 'Casa_ planta_baja', stamp: '2026-10-12 09:05:07' })
    expect(parseAutosaveName('Casa.archi')).toBeNull()
    expect(safeName('  ')).toBe('Untitled')
  })

  it('prunes the oldest copies of one model only', () => {
    const names = ['A 2026-01-01 10-00-00.archi', 'A 2026-01-02 10-00-00.archi', 'A 2026-01-03 10-00-00.archi', 'B 2026-01-01 10-00-00.archi', 'A.archi']
    expect(copiesToPrune(names, 'A', 2)).toEqual(['A 2026-01-01 10-00-00.archi'])
    expect(copiesToPrune(names, 'B', 2)).toEqual([])
  })

  it('joins paths with the folder separator', () => {
    expect(joinPath('C:\\Users\\me\\Autosave', 'a.archi')).toBe('C:\\Users\\me\\Autosave\\a.archi')
    expect(joinPath('/home/me/', 'a.archi')).toBe('/home/me/a.archi')
  })
})

describe('Autosaver', () => {
  it('writes a copy only when the model changed and is not saved, keeping the newest', async () => {
    const { files, folder } = memoryFolder()
    let modified = false
    const saver = new Autosaver({ name: () => 'Casa', modified: () => modified, data: () => new Uint8Array([1, 2, 3]) }, folder, { ...DEFAULT_AUTOSAVE, keep: 2 })
    // Nothing changed yet.
    expect(await saver.tick()).toBeNull()
    saver.touch()
    // Changed but saved (e.g. just opened).
    expect(await saver.tick()).toBeNull()
    modified = true
    const first = await saver.tick()
    expect(first).toMatch(/^\/home\/me\/Documents\/ArchiOpen\/Autosave\/Casa \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.archi$/)
    expect(files.get(first!)).toEqual(new Uint8Array([1, 2, 3]))
    // No change since that copy.
    expect(await saver.tick()).toBeNull()
    for (const day of [1, 2, 3]) await saver.saveNow(new Date(2030, 0, day))
    const left = [...files.keys()].map((p) => p.split('/').pop()).sort()
    expect(left).toEqual(['Casa 2030-01-02 00-00-00.archi', 'Casa 2030-01-03 00-00-00.archi'])
    // Copies listed newest first, ready to recover.
    const copies = await saver.copies()
    expect(copies.map((c) => c.stamp)).toEqual(['2030-01-03 00:00:00', '2030-01-02 00:00:00'])
    expect(await folder.read(copies[0].path)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('goes to a chosen folder, and does nothing without one (in the browser)', async () => {
    const { files, folder } = memoryFolder()
    const saver = new Autosaver({ name: () => 'X', modified: () => true, data: () => new Uint8Array() }, folder, { ...DEFAULT_AUTOSAVE, folder: '/backup' })
    expect(await saver.saveNow(new Date(2030, 0, 1))).toBe('/backup/X 2030-01-01 00-00-00.archi')
    expect(files.has('/backup/X 2030-01-01 00-00-00.archi')).toBe(true)
    const browser = new Autosaver({ name: () => 'X', modified: () => true, data: () => new Uint8Array() }, null)
    expect(browser.available).toBe(false)
    browser.touch()
    expect(await browser.tick()).toBeNull()
  })
})
