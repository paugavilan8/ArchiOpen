import { describe, expect, it } from 'vitest'
import { t } from './language'
import { es } from './locales/es'

const sources = import.meta.glob('../ui/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** The texts the interface shows, as written in its code. */
function interfaceTexts(): string[] {
  const texts = new Set<string>()
  const add = (text: string) => texts.add(text.replace(/\s{2}\(.+\)$/, ''))
  for (const source of Object.values(sources)) {
    for (const m of source.matchAll(/\bitem\('([^']+)'/g)) add(m[1])
    for (const m of source.matchAll(/\blabel: '([^']+)'/g)) add(m[1])
    for (const m of source.matchAll(/\btip: '([^']+)'/g)) add(m[1])
    for (const m of source.matchAll(/\biconButton\('\w+', '([^']+)'/g)) add(m[1])
    for (const m of source.matchAll(/\bdataset\.tip = '([^']+)'/g)) add(m[1])
    for (const m of source.matchAll(/\bt\('([^']+)'/g)) add(m[1])
  }
  // Menu titles.
  for (const m of sources['../ui/menuBar.ts'].matchAll(/^ {6}'([A-Z][a-z]+)',$/gm)) add(m[1])
  texts.delete('Language / Idioma')
  return [...texts]
}

describe('interface language', () => {
  it('translates texts, keeps shortcuts and fills in values', () => {
    expect(t('Save', undefined, 'es')).toBe('Guardar')
    expect(t('Save', undefined, 'en')).toBe('Save')
    expect(t('Move  (M)', undefined, 'es')).toBe('Mover  (M)')
    expect(t('Layer {name}', { name: 'Muros' }, 'es')).toBe('Capa Muros')
    expect(t('Layer {name}', { name: 'Walls' }, 'en')).toBe('Layer Walls')
  })

  it('matches texts made elsewhere against texts with parts', () => {
    expect(t('Unknown command: Foo', undefined, 'es')).toBe('Comando desconocido: Foo')
    expect(t('Drag to move along Z, click to type a distance', undefined, 'es')).toBe('Arrastra para mover según Z, clic para escribir una distancia')
    expect(t('12 objects copied to the clipboard', undefined, 'es')).toBe('12 objetos copiados al portapapeles')
  })

  it('leaves what has no translation in English', () => {
    expect(t('Something new', undefined, 'es')).toBe('Something new')
  })

  it('has Spanish for every text of the menus, toolbars and panels', () => {
    // (Some words are the same in both: they are in the dictionary all the same.)
    const missing = interfaceTexts().filter((text) => !(text in es) && t(text, undefined, 'es') === text)
    expect(missing).toEqual([])
  })

  it('keeps the parts of each text in its translation', () => {
    const parts = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const wrong = Object.entries(es).filter(([from, to]) => parts(from).join() !== parts(to).join())
    expect(wrong).toEqual([])
  })
})
