import { es } from './locales/es'

/**
 * The language of the interface. Texts are written in English in the code and looked up in a
 * dictionary for the chosen language; whatever has no translation stays in English. Command names
 * and their options are not translated, so typed commands, macros and scripts work in any
 * language (as Rhino's English command names do).
 */

export type Language = 'en' | 'es'

export const LANGUAGES: Record<Language, string> = { en: 'English', es: 'Español' }

const STORAGE_KEY = 'archiopen.language'

const dictionaries: Record<Exclude<Language, 'en'>, Record<string, string>> = { es }

function initial(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'es') return saved
  } catch {
    // No storage (private window): the system's language.
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

let current: Language = initial()

export function language(): Language {
  return current
}

const listeners = new Set<(next: Language) => void>()

/** Called when the language changes (the app then builds its interface again). */
export function onLanguageChange(listener: (next: Language) => void): void {
  listeners.add(listener)
}

/** Chooses the language; the interface takes it when it is built again (the app reloads). */
export function setLanguage(next: Language): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener(next)
}

/** Texts with `{name}` parts, as patterns that match the text with anything in those parts. */
const patterns = new Map<Record<string, string>, { re: RegExp; names: string[]; to: string }[]>()
function patternsOf(dictionary: Record<string, string>) {
  let list = patterns.get(dictionary)
  if (!list) {
    list = Object.entries(dictionary)
      .filter(([from]) => /\{\w+\}/.test(from))
      .map(([from, to]) => {
        const names: string[] = []
        const source = from
          .split(/(\{\w+\})/)
          .map((part) => {
            const m = /^\{(\w+)\}$/.exec(part)
            if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            names.push(m[1])
            return '(.+?)'
          })
          .join('')
        return { re: new RegExp(`^${source}$`), names, to }
      })
    patterns.set(dictionary, list)
  }
  return list
}

function lookup(dictionary: Record<string, string>, text: string): string | undefined {
  const exact = dictionary[text]
  if (exact !== undefined) return exact
  for (const { re, names, to } of patternsOf(dictionary)) {
    const m = re.exec(text)
    if (m) return to.replace(/\{(\w+)\}/g, (whole, name: string) => (names.includes(name) ? m[names.indexOf(name) + 1] : whole))
  }
  // A shortcut after the text ("Move  (M)") stays as it is.
  const shortcut = /^(.+?)(\s{2}\(.+\))$/.exec(text)
  if (shortcut) {
    const head = lookup(dictionary, shortcut[1])
    if (head !== undefined) return head + shortcut[2]
  }
  return undefined
}

/**
 * A text in the interface's language. `values` fill its `{name}` parts. The dictionary may also
 * have texts with `{name}` parts that match texts made elsewhere ("Select objects to {what}").
 */
export function t(text: string, values?: Record<string, string | number>, lang: Language = current): string {
  const translated = lang === 'en' ? text : (lookup(dictionaries[lang], text) ?? text)
  return values ? translated.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole)) : translated
}
