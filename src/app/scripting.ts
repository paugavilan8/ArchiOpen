import { Vector3 } from 'three'
import type { CadObject, Document } from '../core/document'
import type { Geometry } from '../core/geometry'
import type { CommandContext, CommandRunner } from '../commands/runner'

/**
 * Scripts: JavaScript files that drive the modeler, to automate repetitive work. A script runs as
 * the body of an async function with `archi` (the API below) and `Vector3` in scope, so it can
 * `await` commands. It has the same access as the app itself: run only scripts you trust.
 */

export interface ObjectInfo {
  id: number
  type: Geometry['type']
  layer: string
  /** The command that made it, for objects with history (Wall, Slab, ...). */
  command?: string
  params?: Record<string, unknown>
}

export interface ScriptApi {
  /** Runs a command with its answers in order ('' is Enter); resolves to the ids selected after it (what it made). */
  command(name: string, ...answers: (string | number)[]): Promise<number[]>
  /** A point. */
  v(x: number, y: number, z?: number): Vector3
  /** Writes to the command history. */
  log(...values: unknown[]): void
  /** Adds geometry (a curve, mesh, point, ...) to a layer, by name (made if missing), as one undo step. */
  add(geometry: Geometry, layer?: string): number
  /** Deletes objects, as one undo step. */
  remove(ids: number[]): void
  /** The objects, optionally only those a test keeps. */
  objects(filter?: (o: ObjectInfo) => boolean): ObjectInfo[]
  /** Selects objects (in place of the selection), for the commands that act on it. */
  select(ids: number[]): void
  /** Levels, by name and elevation, and the current one. */
  levels(): { name: string; elevation: number; height: number }[]
  setLevel(name: string): void
  /** Runs several edits as one undo step. */
  step<T>(edits: () => T | Promise<T>): Promise<T>
  /** The document itself, for anything else (advanced). */
  doc: Document
}

export function scriptApi(ctx: CommandContext, runner: CommandRunner): ScriptApi {
  const { doc } = ctx
  let depth = 0
  const inStep = <T>(edit: () => T): T => {
    if (depth > 0) return edit()
    doc.begin()
    try {
      return edit()
    } finally {
      doc.commit()
    }
  }
  const info = (o: CadObject): ObjectInfo => ({
    id: o.id,
    type: o.geometry.type,
    layer: doc.layerOf(o).name,
    ...(o.history ? { command: o.history.command, params: o.history.params } : {}),
  })
  const layerId = (name?: string) => {
    if (!name) return doc.currentLayerId
    const existing = doc.layers.find((l) => l.name === name)
    if (existing) return existing.id
    const layer = doc.addLayer()
    doc.updateLayer(layer.id, { name })
    return layer.id
  }
  return {
    async command(name, ...answers) {
      await runner.runWith(name, answers.map(String))
      return [...doc.selection]
    },
    v: (x, y, z = 0) => new Vector3(x, y, z),
    log: (...values) => ctx.log(values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')),
    add: (geometry, layer) => inStep(() => doc.add(geometry, layerId(layer)).id),
    remove: (ids) => inStep(() => ids.forEach((id) => doc.objects.has(id) && doc.remove(id))),
    objects: (filter) => [...doc.objects.values()].map(info).filter((o) => !filter || filter(o)),
    select: (ids) => doc.select(ids.filter((id) => doc.objects.has(id))),
    levels: () => doc.levels.map((l) => ({ ...l })),
    setLevel: (name) => {
      if (!doc.levels.some((l) => l.name === name)) throw new Error(`There is no level called ${name}`)
      doc.setLevels(doc.levels, name)
    },
    async step(edits) {
      doc.begin()
      depth++
      try {
        return await edits()
      } finally {
        depth--
        doc.commit()
      }
    },
    doc,
  }
}

type AsyncFn = (archi: ScriptApi, V: typeof Vector3) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => AsyncFn

/** Compiles a script (throwing on a syntax error) into the function that runs it. */
export function compileScript(code: string): AsyncFn {
  return new AsyncFunction('archi', 'Vector3', `"use strict";\n${code}`)
}

/** Runs a script; resolves when it ends, and rejects with its error (the line in the file where possible). */
export async function runScript(code: string, api: ScriptApi): Promise<void> {
  const run = compileScript(code)
  try {
    await run(api, Vector3)
  } catch (error) {
    // The script's own line: the one in the stack inside the compiled function, less the line added.
    const line = /<anonymous>:(\d+):\d+/.exec(error instanceof Error ? (error.stack ?? '') : '')?.[1]
    const at = line ? ` (line ${Number(line) - 3})` : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${at}`)
  }
}

let host: { ctx: CommandContext; runner: CommandRunner } | null = null

/** Lets RunScript drive the app's command runner (set up by the app). */
export function setScriptHost(ctx: CommandContext, runner: CommandRunner): void {
  host = { ctx, runner }
}
export const scriptHost = () => host
