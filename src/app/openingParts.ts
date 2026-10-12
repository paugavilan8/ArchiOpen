import { OPENING_PARTS, wallParams, type Opening, type OpeningPart } from '../core/architecture'
import type { Document, HistoryRecord, Layer } from '../core/document'
import type { BrepGeometry } from '../core/geometry'
import { MATERIAL_PRESETS, type Material } from '../core/materials'

/**
 * The frames, glass and door leaves of a wall's openings: solids of their own (so they can have
 * their own materials), each with a history record on the wall's path, so they follow it like the
 * wall does. When the wall is made again from new parameters, they are brought in line with it:
 * made again, added for new openings, removed for openings taken out.
 */

const FRAME_MATERIAL: Material = { name: 'Window frame', color: '#3b3e42', roughness: 0.4, metalness: 0.6, transparency: 0 }
const LAYERS: Record<OpeningPart | 'doorFrame', { name: string; color: string; material: string }> = {
  frame: { name: 'Windows', color: '#3b3e42', material: FRAME_MATERIAL.name },
  glass: { name: 'Glazing', color: '#6fa8c0', material: 'Glass' },
  leaf: { name: 'Doors', color: '#8a5a35', material: 'Wood' },
  doorFrame: { name: 'Doors', color: '#8a5a35', material: 'Wood' },
}

/** Gives every opening of a wall record an id (openings made before ids had none). */
export function withOpeningIds(record: HistoryRecord): HistoryRecord {
  const openings = wallParams(record.params).openings
  let next = openings.reduce((max, o) => Math.max(max, o.id ?? 0), 0) + 1
  if (openings.every((o) => o.id !== undefined)) return record
  return { ...record, params: { ...record.params, openings: openings.map((o) => (o.id === undefined ? { ...o, id: next++ } : o)) } }
}

/** The next free opening id of a wall. */
export const nextOpeningId = (openings: Opening[]) => openings.reduce((max, o) => Math.max(max, o.id ?? 0), 0) + 1

const isPartOf = (wallId: number) => (record: HistoryRecord | undefined) => record?.command === 'OpeningPart' && record.params?.wall === wallId

/** The records the pieces of a wall's openings should have. */
function partRecords(wallId: number, wall: HistoryRecord): Map<string, HistoryRecord> {
  const p = wallParams(wall.params)
  const out = new Map<string, HistoryRecord>()
  for (const opening of p.openings) {
    if (opening.frame === false) continue
    for (const part of OPENING_PARTS[opening.kind]) {
      out.set(`${opening.id}:${part}`, {
        command: 'OpeningPart',
        inputs: [...wall.inputs],
        params: { wall: wallId, thickness: p.thickness, height: p.height, justification: p.justification, opening, part },
      })
    }
  }
  return out
}

/** The layer a piece goes on, made (with its material) if missing. */
function layerFor(doc: Document, part: OpeningPart, kind: Opening['kind']): Layer {
  const spec = LAYERS[part === 'frame' && kind === 'door' ? 'doorFrame' : part]
  const existing = doc.layers.find((l) => l.name === spec.name)
  if (existing) return existing
  const wanted = [FRAME_MATERIAL, ...MATERIAL_PRESETS].find((m) => m.name === spec.material)
  if (wanted && !doc.materials.some((m) => m.name === wanted.name)) doc.setMaterials([...doc.materials, { ...wanted }])
  const layer = doc.addLayer()
  doc.updateLayer(layer.id, { name: spec.name, color: spec.color, material: spec.material })
  return layer
}

/**
 * Works out (building what is needed) how to bring the pieces of a wall's openings in line with its
 * record; the returned function then makes the changes, all at once.
 */
export async function planOpeningParts(doc: Document, wallId: number, wall: HistoryRecord, build: (record: HistoryRecord) => Promise<BrepGeometry>): Promise<() => void> {
  const wanted = partRecords(wallId, wall)
  const existing = new Map<string, number>()
  const extra: number[] = []
  for (const obj of doc.objects.values()) {
    if (!isPartOf(wallId)(obj.history)) continue
    const p = obj.history!.params!
    const key = `${(p.opening as Opening).id}:${p.part}`
    if (wanted.has(key) && !existing.has(key)) existing.set(key, obj.id)
    else extra.push(obj.id)
  }
  const made = new Map<string, BrepGeometry>()
  for (const [key, record] of wanted) {
    const id = existing.get(key)
    const same = id !== undefined && JSON.stringify(doc.objects.get(id)!.history) === JSON.stringify(record)
    if (!same) made.set(key, await build(record))
  }
  return () => {
    for (const [key, geometry] of made) {
      const record = wanted.get(key)!
      const id = existing.get(key)
      if (id !== undefined && doc.objects.has(id)) {
        doc.setGeometry(id, geometry)
        doc.setHistory(id, record)
      } else {
        const opening = record.params!.opening as Opening
        const added = doc.add(geometry, layerFor(doc, record.params!.part as OpeningPart, opening.kind).id)
        doc.setHistory(added.id, record)
      }
    }
    for (const id of extra) if (doc.objects.has(id)) doc.remove(id)
  }
}

/** The pieces of openings whose wall is gone or no longer made from its line. */
export function orphanedParts(doc: Document, gone: Set<number>): number[] {
  const out: number[] = []
  for (const obj of doc.objects.values()) {
    if (obj.history?.command !== 'OpeningPart') continue
    const wall = Number(obj.history.params?.wall)
    if (gone.has(wall) || !doc.objects.has(wall)) out.push(obj.id)
  }
  return out
}
