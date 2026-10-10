import type { Document, Layer } from '../core/document'
import { type BlockDefinition, type Geometry, geometryFromJSON, geometryToJSON } from '../core/geometry'
import { type Material, materialFromJSON } from '../core/materials'
import type { RhinoImport } from '../io/rhino3dm'
import { mergeRhinoImport } from './rhinoModel'

/**
 * Copy and paste of objects, between files and windows of ArchiOpen, through the system clipboard
 * as text: a small model (what was copied, the layers and blocks it uses, its materials and
 * groups) in JSON. Pasting merges it as Import does: layers by name, blocks by name (the same block
 * is reused), and geometry scaled into the document's units. Objects land where they were copied.
 */

const FORMAT = 'ArchiOpen clipboard'

interface ClipboardObject {
  /** Index into `layers`. */
  layer: number
  geometry: unknown
  material?: string
  /** Objects copied from one group share a number, and are pasted as a group of their own. */
  group?: number
}

export interface ClipboardData {
  format: typeof FORMAT
  version: 1
  units: string
  layers: Omit<Layer, 'id'>[]
  /** Definitions of the blocks used, nested ones first; their objects' layers index `layers`. */
  blocks: { name: string; objects: { layer: number; geometry: unknown }[] }[]
  objects: ClipboardObject[]
  /** The render materials the objects (or their layers) use. */
  materials: Material[]
}

/** The blocks some geometry uses, those they hold first. */
function blocksUsed(geometries: Geometry[], out: BlockDefinition[] = []): BlockDefinition[] {
  for (const g of geometries) {
    if (g.type !== 'instance' || out.includes(g.definition)) continue
    blocksUsed(
      g.definition.objects.map((o) => o.geometry),
      out,
    )
    out.push(g.definition)
  }
  return out
}

/** The clipboard text for some objects of a document. */
export function copyObjects(doc: Document, ids: Iterable<number>): string {
  const objects = [...ids].map((id) => doc.objects.get(id)).filter((o) => o !== undefined)
  const layerIndex = new Map<number, number>()
  const layers: ClipboardData['layers'] = []
  const layerOf = (id: number) => {
    let index = layerIndex.get(id)
    if (index === undefined) {
      const { id: _, ...layer } = doc.layers.find((l) => l.id === id) ?? doc.currentLayer
      layerIndex.set(id, (index = layers.length))
      layers.push(layer)
    }
    return index
  }
  // Group numbers as they come, so pasted groups do not depend on the source's numbering.
  const groupIndex = new Map<number, number>()
  const blocks = blocksUsed(objects.map((o) => o.geometry))
  const data: ClipboardData = {
    format: FORMAT,
    version: 1,
    units: doc.units,
    layers,
    blocks: blocks.map((b) => ({ name: b.name, objects: b.objects.map((o) => ({ layer: layerOf(o.layerId), geometry: geometryToJSON(o.geometry) })) })),
    objects: objects.map((o) => {
      const group = o.groups?.[0]
      if (group !== undefined && !groupIndex.has(group)) groupIndex.set(group, groupIndex.size)
      return {
        layer: layerOf(o.layerId),
        geometry: geometryToJSON(o.geometry),
        ...(o.material ? { material: o.material } : {}),
        ...(group !== undefined ? { group: groupIndex.get(group) } : {}),
      }
    }),
    materials: [],
  }
  const materialNames = new Set([...data.objects.map((o) => o.material), ...layers.map((l) => l.material)].filter((m): m is string => !!m))
  data.materials = doc.materials.filter((m) => materialNames.has(m.name))
  return JSON.stringify(data)
}

/** The clipboard's content if it is objects copied from ArchiOpen, else null (text from elsewhere). */
export function readClipboard(text: string): ClipboardData | null {
  if (!text.startsWith('{') || !text.includes(FORMAT)) return null
  try {
    const data = JSON.parse(text) as ClipboardData
    return data.format === FORMAT && Array.isArray(data.objects) && Array.isArray(data.layers) ? data : null
  } catch {
    return null
  }
}

/**
 * Adds what was copied to the document and returns the new objects' ids. Missing layers and
 * materials are added; those with the same name are used as they are here.
 */
export function pasteObjects(doc: Document, data: ClipboardData): number[] {
  const definitions = new Map<string, BlockDefinition>()
  for (const b of data.blocks ?? []) {
    definitions.set(b.name, {
      name: b.name,
      objects: b.objects.map((o) => ({ layerId: o.layer, geometry: geometryFromJSON(o.geometry, (name) => definitions.get(name)) })),
    })
  }
  const model: RhinoImport = {
    units: data.units,
    layers: data.layers,
    objects: data.objects.map((o) => ({ layer: o.layer, geometry: geometryFromJSON(o.geometry, (name) => definitions.get(name)) })),
    breps: [],
    tolerance: 0,
    skipped: new Map(),
  }
  for (const m of data.materials ?? []) {
    const material = materialFromJSON(m)
    if (material && !doc.materials.some((existing) => existing.name === material.name)) doc.setMaterials([...doc.materials, material])
  }
  const { ids } = mergeRhinoImport(doc, model)
  const groups = new Map<number, number[]>()
  data.objects.forEach((o, i) => {
    if (o.material) doc.setState(ids[i], { material: o.material })
    if (o.group !== undefined) groups.set(o.group, [...(groups.get(o.group) ?? []), ids[i]])
  })
  for (const members of groups.values()) if (members.length > 1) doc.group(members)
  return ids
}

/**
 * What was last copied, for when the system clipboard cannot be read (a browser that asks for
 * permission, or refuses).
 */
let lastCopied = ''

/** Puts text on the system clipboard if allowed, and keeps it here in any case. */
export async function writeClipboardText(text: string): Promise<void> {
  lastCopied = text
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // Kept here only.
  }
}

/** The system clipboard's text, or what was last copied here if it cannot be read. */
export async function readClipboardText(): Promise<string> {
  try {
    const text = await navigator.clipboard?.readText()
    if (text) return text
  } catch {
    // Not allowed: what was copied here.
  }
  return lastCopied
}

/** Notes text copied through a copy event (Ctrl+C), for the fallback above. */
export function rememberCopied(text: string): void {
  lastCopied = text
}
