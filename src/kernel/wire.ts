import { Box3, Vector3 } from 'three'
import type { BrepGeometry } from '../core/geometry'

/**
 * What crosses between the app and the kernel worker. Messages are copied with the structured clone
 * algorithm, which keeps plain data but drops classes, so vectors and boxes travel tagged and come
 * back as Three.js objects. Kernel shapes never cross: the app sends a surface or solid as a
 * reference to its exact geometry, which the worker loads, and the shapes a job makes come back as
 * document geometry.
 */

/** A surface or solid handed to a kernel job: the worker turns it into the kernel's shape. */
export interface ShapeRef {
  $shape: { brep: string; matrix: number[] | null }
}

export const shapeRef = (g: BrepGeometry): ShapeRef => ({ $shape: { brep: g.brep, matrix: g.matrix } })

export const isShapeRef = (value: unknown): value is ShapeRef => typeof value === 'object' && value !== null && '$shape' in value

/** Turns Three.js values into plain tagged data, after `special` has had its say on each value. */
export function encode(value: unknown, special?: (value: unknown) => unknown): unknown {
  if (special) {
    const replaced = special(value)
    if (replaced !== value) return encode(replaced, special)
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Vector3) return { $v: [value.x, value.y, value.z] }
  if (value instanceof Box3) return { $box: [value.min.toArray(), value.max.toArray()] }
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) {
    // Long lists of numbers (mesh vertices and triangles) go as they are.
    if (typeof value[0] === 'number') return value
    return value.map((v) => encode(v, special))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = encode(v, special)
  return out
}

/** The reverse of encode; `special` sees each value first (the worker turns shape references into shapes). */
export function decode(value: unknown, special?: (value: unknown) => unknown): unknown {
  if (special) {
    const replaced = special(value)
    if (replaced !== value) return replaced
  }
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) {
    if (typeof value[0] === 'number') return value
    return value.map((v) => decode(v, special))
  }
  const tagged = value as { $v?: number[]; $box?: number[][] }
  if (tagged.$v) return new Vector3(tagged.$v[0], tagged.$v[1], tagged.$v[2])
  if (tagged.$box) return new Box3(new Vector3().fromArray(tagged.$box[0]), new Vector3().fromArray(tagged.$box[1]))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = decode(v, special)
  return out
}

/** A request to the worker, and its answer. */
export interface JobRequest {
  id: number
  name: string
  args: unknown[]
}

export type JobAnswer = { id: number; result: unknown } | { id: number; error: string; own: boolean }

/** How a job failed: an Error of our own (`own`), or an exception from inside the kernel. */
export function failureOf(id: number, error: unknown): JobAnswer {
  if (error instanceof Error) return { id, error: error.message, own: true }
  const message = (error as { message?: unknown })?.message
  return { id, error: typeof message === 'string' ? message : 'Open CASCADE exception', own: false }
}
