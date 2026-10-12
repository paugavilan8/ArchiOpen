import type { Document } from '../core/document'
import type { AnyCurve } from '../core/geometry'
import type { Recognized } from '../core/ifcRecognize'
import { wallParams, type Opening } from '../core/architecture'
import type { IfcMesh } from '../io/ifc'
import { shapeRef } from '../kernel/wire'
import { kernelJob } from '../kernel/client'
import type { CommandContext } from '../commands/runner'

/**
 * Walls and slabs recognized in an IFC file made as ArchiOpen's own elements, with construction
 * history from their lines (on the Construction layer) as if drawn with Wall and Slab. Resolves to
 * the new walls and slabs; the walls with openings still need their frames and glass made (by
 * making them again through construction history).
 */
export async function addNativeElements(doc: Document, native: Pick<Recognized, 'walls' | 'slabs'>): Promise<{ walls: number[]; slabs: number[] }> {
  const layer = (name: string, color: string, linetype?: string) => {
    const existing = doc.layers.find((l) => l.name === name)
    if (existing) return existing.id
    const made = doc.addLayer()
    doc.updateLayer(made.id, { name, color, ...(linetype ? { linetype } : {}) })
    return made.id
  }
  const out = { walls: [] as number[], slabs: [] as number[] }
  if (native.walls.length === 0 && native.slabs.length === 0) return out
  // One step, as a command would make them: history set with the objects is not taken for an edit.
  doc.beginGroup()
  try {
    await addAll(doc, native, layer, out)
  } finally {
    doc.endGroup()
  }
  return out
}

async function addAll(doc: Document, native: Pick<Recognized, 'walls' | 'slabs'>, layer: (name: string, color: string, linetype?: string) => number, out: { walls: number[]; slabs: number[] }): Promise<void> {
  const construction = layer('Construction', '#8c8c8c', 'Dashed')
  const add = async (curve: AnyCurve, command: string, params: Record<string, unknown>, layerId: number) => {
    const geometry = await kernelJob('rebuild', command, [curve], params)
    const input = doc.add(curve, construction).id
    const id = doc.add(geometry, layerId).id
    doc.setHistory(id, { command, inputs: [input], params })
    return id
  }
  if (native.walls.length > 0) {
    const walls = layer('Walls', '#5b5b5b')
    for (const w of native.walls) {
      // Made without their openings at first: they join their neighbours, then get them (framesFor).
      const params = { thickness: round(w.thickness), height: round(w.height), justification: 'center', openings: [] }
      try {
        const id = await add({ type: 'polyline', points: w.path.map((p) => p.clone()), closed: false }, 'Wall', params, walls)
        out.walls.push(id)
        if (w.openings.length > 0) pendingOpenings.set(id, w.openings.map((o) => ({ ...o, at: round(o.at), width: round(o.width), height: round(o.height), sill: round(o.sill) })))
      } catch (error) {
        console.warn('Could not make a wall from the IFC file', error)
      }
    }
  }
  if (native.slabs.length > 0) {
    const slabs = layer('Slabs', '#7a7a7a')
    for (const s of native.slabs) {
      const params = { thickness: round(s.thickness), ...(s.holes.length > 0 ? { holes: s.holes } : {}) }
      try {
        out.slabs.push(await add({ type: 'polyline', points: s.outline.map((p) => p.clone()), closed: true }, 'Slab', params, slabs))
      } catch (error) {
        console.warn('Could not make a slab from the IFC file', error)
      }
    }
  }
}

/** Lengths from a mesh kept to a tenth of a millimeter. */
const round = (v: number) => Math.round(v * 10) / 10

/** The doors and windows of walls just made from an IFC file, to give them once they have joined. */
const pendingOpenings = new Map<number, Opening[]>()

/**
 * Makes walls from an IFC file again through construction history: first as they are, so that they
 * join where they meet, then with their doors and windows, which get their frames and glass.
 */
export async function framesFor(ctx: Pick<CommandContext, 'doc' | 'history' | 'files'>, walls: number[]): Promise<void> {
  const { doc, history } = ctx
  // Each in a step of its own, as when one wall is edited: the walls it joins follow it there.
  for (const id of walls) {
    const record = doc.objects.get(id)?.history
    if (record?.command === 'Wall' && history) await history.remakeStep(id, record)
  }
  for (const id of walls) {
    const openings = pendingOpenings.get(id)
    pendingOpenings.delete(id)
    const record = doc.objects.get(id)?.history
    if (!openings || record?.command !== 'Wall') continue
    const next = { ...record, params: { ...record.params, openings } }
    if (history) await history.remakeStep(id, next)
    else doc.setHistory(id, next)
  }
  ctx.files.nativeWalls = []
}

/**
 * For IFC: each wall drawn along several segments (a ring made with Close, or a polyline) cut into
 * one piece for each segment, as triangles, by wall id. BIM tools expect each wall straight.
 */
export async function wallPieces(doc: Document): Promise<Map<number, IfcMesh[]>> {
  const out = new Map<number, IfcMesh[]>()
  for (const obj of doc.objects.values()) {
    if (obj.history?.command !== 'Wall' || obj.geometry.type !== 'brep' || !doc.isVisible(obj)) continue
    const path = doc.objects.get(obj.history.inputs[0])?.geometry
    if (!path || path.type !== 'polyline' || path.points.length < 3) continue
    try {
      const pieces = await kernelJob('wallSegments', shapeRef(obj.geometry), path, wallParams(obj.history.params).thickness)
      if (pieces.length > 1) out.set(obj.id, pieces.map((g) => ({ vertices: g.display.vertices, triangles: g.display.triangles })))
    } catch {
      // Left whole.
    }
  }
  return out
}
