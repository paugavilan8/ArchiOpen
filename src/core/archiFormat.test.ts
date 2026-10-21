import { beforeAll, describe, expect, it } from 'vitest'
import { version as appVersion } from '../../package.json'
import { archiAsImport } from '../app/rhinoModel'
import { ARCHI_FORMAT, ARCHI_MARK, archiNotes, migrateArchi, parseArchi } from './archiFormat'
import { Document } from './document'
import packed from './fixtures/archi-format-1.archi.gz.b64?raw'

/**
 * A file saved by ArchiOpen 0.8.2 (the example house, with its drawing sheets, a named view, a
 * sphere and one object of every other kind). It is never regenerated: files saved then must
 * always open the same. Add one such file for each new version of the format.
 */
let text = ''
const saved = () => text

describe('.archi files', () => {
  beforeAll(async () => {
    const gz = Uint8Array.from(atob(packed.trim()), (c) => c.charCodeAt(0))
    text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  })

  it('opens a file saved by 0.8.2 with everything in it', () => {
    const file = parseArchi(saved())
    expect(file).toMatchObject({ version: 1, app: null, newer: false })
    const doc = new Document()
    expect(doc.load(file.json)).toBe(0)
    expect(doc.objects.size).toBe(346)
    const types = new Set([...doc.objects.values()].map((o) => o.geometry.type))
    expect([...types].sort()).toEqual(['annotation', 'arc', 'brep', 'circle', 'clipping', 'curve', 'hatch', 'instance', 'mesh', 'point', 'polycurve', 'polyline'])
    expect(doc.blocks.has('Columna')).toBe(true)
    expect(doc.layouts.map((l) => l.name)).toHaveLength(4)
    expect(doc.namedViews.map((v) => v.name)).toEqual(['Entrada'])
    expect(doc.levels.map((l) => l.name)).toEqual(['Level 0', 'Level 1'])
    expect([...doc.objects.values()].filter((o) => o.history?.command === 'Wall').length).toBeGreaterThan(0)
    const text = [...doc.objects.values()].find((o) => o.geometry.type === 'annotation' && o.geometry.kind === 'text' && o.geometry.text.startsWith('Planta'))
    expect(text?.geometry.type === 'annotation' && text.geometry.text).toBe('Planta baja — 1:100')
  })

  it('saves it again unchanged, now marked with its format and the app', () => {
    const original = JSON.parse(saved())
    const doc = new Document()
    doc.load(parseArchi(saved()).json)
    const { format, version, app, ...content } = doc.toJSON() as Record<string, unknown>
    expect({ format, version, app }).toEqual({ format: ARCHI_MARK, version: ARCHI_FORMAT, app: appVersion })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { version: _, ...before } = original
    expect(JSON.parse(JSON.stringify(content))).toEqual(before)
  })

  it('links a file saved by 0.8.2', () => {
    const model = archiAsImport(parseArchi(saved()).json)
    expect(model.objects.length).toBeGreaterThan(300)
  })

  it('opens what it can of a file from a newer version, and says so', () => {
    const json = JSON.parse(saved())
    json.version = ARCHI_FORMAT + 1
    json.app = '9.0.0'
    json.objects.push({ id: 9999, layerId: json.layers[0].id, geometry: { type: 'subd', cage: [] } })
    json.blocks[0].objects.push({ layerId: json.layers[0].id, geometry: { type: 'subd' } })
    const file = migrateArchi(json)
    expect(file.newer).toBe(true)
    const doc = new Document()
    const skipped = doc.load(file.json)
    expect(skipped).toBe(2)
    expect(doc.objects.size).toBe(346)
    expect(archiNotes(file, skipped)).toBe(' (it was saved by a newer ArchiOpen (9.0.0): update this one to see everything in it; 2 objects of a kind this version does not know left out)')
    expect(archiAsImport(file.json).objects.length).toBe(archiAsImport(parseArchi(saved()).json).objects.length)
  })

  it('takes files without a version as the first one', () => {
    expect(migrateArchi({ objects: [] })).toMatchObject({ version: 1, newer: false })
    expect(archiNotes(migrateArchi({}), 0)).toBe('')
  })

  it('tells what is not an .archi file', () => {
    expect(() => parseArchi('PK\u0003\u0004 not json')).toThrow('This is not an ArchiOpen file, or it is damaged')
    expect(() => parseArchi('[1, 2]')).toThrow('This is not an ArchiOpen file')
  })
})
