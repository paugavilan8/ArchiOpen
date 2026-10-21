/**
 * The .archi file format: the document as JSON (see docs/archi-format.md). Files carry the version
 * of the format they were written in; older ones are brought up to date when read, step by step,
 * so a file saved by any version of ArchiOpen still opens. Files from a newer version open as far
 * as this one understands them: what it does not know is left out, and the file is never changed
 * unless it is saved again.
 */

/** The version of the format this ArchiOpen writes. Raised only with a migration from the last. */
export const ARCHI_FORMAT = 1

/** What tells an .archi file apart from other JSON. */
export const ARCHI_MARK = 'ArchiOpen'

/**
 * The steps from each version of the format to the next: `migrations[n]` turns a file of version
 * n into one of version n + 1. Files written before the format had a version are version 1.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrations: Record<number, (json: any) => any> = {}

export interface ArchiFile {
  /** The content, in the current version of the format. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  /** The version it was written in. */
  version: number
  /** The ArchiOpen that wrote it, when it says. */
  app: string | null
  /** Written by a newer ArchiOpen, in a version of the format this one does not know. */
  newer: boolean
}

/** Brings the content of an .archi file up to the current version of the format. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateArchi(raw: any): ArchiFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('This is not an ArchiOpen file, or it is damaged')
  const given = Number.isInteger(raw.version) && raw.version >= 1 ? (raw.version as number) : 1
  const app = typeof raw.app === 'string' ? raw.app : null
  let json = raw
  for (let v = given; v < ARCHI_FORMAT; v++) {
    const step = migrations[v]
    if (step) json = step(json)
  }
  return { json, version: given, app, newer: given > ARCHI_FORMAT }
}

/** Reads an .archi file's text. */
export function parseArchi(text: string): ArchiFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('This is not an ArchiOpen file, or it is damaged')
  }
  return migrateArchi(raw)
}

/** What to tell about a file that was read: from a newer version, or with objects left out. */
export function archiNotes(file: ArchiFile, skipped: number): string {
  const notes: string[] = []
  if (file.newer) notes.push(`it was saved by a newer ArchiOpen${file.app ? ` (${file.app})` : ''}: update this one to see everything in it`)
  if (skipped > 0) notes.push(`${skipped} object${skipped === 1 ? '' : 's'} of a kind this version does not know left out`)
  return notes.length > 0 ? ` (${notes.join('; ')})` : ''
}
