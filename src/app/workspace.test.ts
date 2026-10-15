import { describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import { defaultTemplate, joinPath } from './workspace'

describe('ArchiOpen folder', () => {
  it('joins paths with the folder\'s own separator', () => {
    expect(joinPath('C:\\Users\\a\\AppData\\Local\\ArchiOpen', 'Templates')).toBe('C:\\Users\\a\\AppData\\Local\\ArchiOpen\\Templates')
    expect(joinPath('/home/a/.local/share/ArchiOpen/', 'Scripts')).toBe('/home/a/.local/share/ArchiOpen/Scripts')
  })

  it('makes a default template with levels and the usual layers, that opens as a model', () => {
    const doc = new Document()
    doc.load(JSON.parse(new TextDecoder().decode(defaultTemplate())))
    expect(doc.objects.size).toBe(0)
    expect(doc.levels.length).toBeGreaterThan(0)
    for (const name of ['Walls', 'Slabs', 'Doors', 'Windows', 'Dimensions', 'Rooms']) expect(doc.layers.some((l) => l.name === name)).toBe(true)
  })
})
