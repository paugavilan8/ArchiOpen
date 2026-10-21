import { describe, expect, it } from 'vitest'
import { t } from './language'
import { es } from './locales/es'

const sources = import.meta.glob('../ui/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const messageSources = import.meta.glob(['../commands/*.ts', '../app/*.ts', '../ui/*.ts', '../io/*.ts', '../core/*.ts', '../main.ts', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const commandSources = import.meta.glob(['../commands/*.ts', '!../commands/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

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

  it('leaves what has no translation in English, rather than half translated', () => {
    expect(t('Something new', undefined, 'es')).toBe('Something new')
    expect(t('Nothing selected', undefined, 'es')).toBe('No hay nada seleccionado')
    expect(t('3 curves selected', undefined, 'es')).toBe('3 curves selected')
  })

  it('translates what commands ask', () => {
    expect(t('Start of wall', undefined, 'es')).toBe('Inicio del muro')
    expect(t('Height <2800>', undefined, 'es')).toBe('Altura <2800>')
    expect(t('Click a wall where the door goes. Press Enter when done', undefined, 'es')).toBe('Haz clic en el muro donde va la puerta. Intro para terminar')
  })

  it('translates errors, with their message', () => {
    expect(t('Error in Open: This is not an ArchiOpen file, or it is damaged', undefined, 'es')).toBe('Error en Open: Esto no es un archivo de ArchiOpen, o está dañado')
    expect(t('Error in Foo: something unexpected', undefined, 'es')).toBe('Error en Foo: something unexpected')
  })

  it('has Spanish for every fixed prompt of the commands', () => {
    const prompts = new Set<string>()
    for (const source of Object.values(commandSources)) {
      // (Escapes as the source writes them, such as a backslash before n, become what the prompt shows.)
      const add = (text: string) => prompts.add(text.replace(/\\\\/g, '\\'))
      for (const m of source.matchAll(/\bprompt: '([^']+)'/g)) add(m[1])
      for (const m of source.matchAll(/\bget(?:Objects|Number|Option|Pick|String|Point)\(\s*'([^']+)'/g)) add(m[1])
    }
    expect(prompts.size).toBeGreaterThan(150)
    expect([...prompts].filter((p) => t(p, undefined, 'es') === p && !(p in es))).toEqual([])
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

  it('has Spanish for every fixed message and error', () => {
    // Answers to the AI assistant, which reads English, are left as they are.
    const forAssistant = ['The open model has unsaved changes: save it first (export format "archi"), or pass discard_changes: true', 'None of those objects exist', 'The format must be archi, ifc, pdf, dxf, glb or csv']
    const messages = new Set<string>()
    for (const source of Object.values(messageSources)) {
      for (const m of source.matchAll(/\b(?:log|ctx\.log|this\.log)\(\s*'([^']+)'\s*\)/g)) messages.add(m[1])
      for (const m of source.matchAll(/throw new Error\(\s*'([^']+)'\s*\)/g)) messages.add(m[1])
      // Either side of a choice: log(n === 0 ? 'Nothing is hidden' : ...).
      for (const m of source.matchAll(/\blog\([^)\n]*\? '([A-Z][^']+)'/g)) messages.add(m[1])
    }
    expect(messages.size).toBeGreaterThan(150)
    expect([...messages].filter((m) => !forAssistant.includes(m) && t(m, undefined, 'es') === m && !(m in es))).toEqual([])
  })
})
