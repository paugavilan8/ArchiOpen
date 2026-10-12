import { findJoins, wallParams, type SavedJoin, type WallRef } from '../core/architecture'
import type { Document, HistoryRecord } from '../core/document'
import { roofParams } from '../core/buildingParts'
import { isCurve, tessellate, type AnyCurve } from '../core/geometry'

/**
 * Keeps walls joined: a wall's record lists the walls its ends meet (as extra inputs, the other
 * walls' paths, with their thickness and justification), so the kernel can mitre or trim its ends
 * and the wall is made again when one of them moves.
 */

/** A wall's record with its joins as they should be now. */
export function withJoins(doc: Document, wallId: number, record: HistoryRecord, skip?: ReadonlySet<number>): HistoryRecord {
  const own = record.inputs[0]
  const path = doc.objects.get(own)?.geometry
  if (!path || !isCurve(path)) return record
  const others: (WallRef & { pathId: number })[] = []
  for (const obj of doc.objects.values()) {
    if (obj.id === wallId || obj.history?.command !== 'Wall' || skip?.has(obj.id)) continue
    const pathId = obj.history.inputs[0]
    const g = doc.objects.get(pathId)?.geometry
    if (pathId === own || !g || !isCurve(g)) continue
    others.push({ path: g, params: wallParams(obj.history.params), pathId })
  }
  const inputs = [own]
  const joins: SavedJoin[] = findJoins({ path, params: wallParams(record.params) }, others).map((j) => {
    const other = others[j.other]
    if (!inputs.includes(other.pathId)) inputs.push(other.pathId)
    return { end: j.end, kind: j.kind, input: inputs.indexOf(other.pathId), thickness: other.params.thickness, justification: other.params.justification }
  })
  // Roofs over the wall, resting at its top: it goes up to their underside.
  const self = wallParams(record.params)
  const top = tessellate(path)[0].z + self.height
  const roofs: Record<string, unknown>[] = []
  for (const obj of doc.objects.values()) {
    if (obj.history?.command !== 'Roof' || skip?.has(obj.id)) continue
    const outlineId = obj.history.inputs[0]
    const outline = doc.objects.get(outlineId)?.geometry
    if (!outline || !isCurve(outline) || outline.type !== 'polyline' || !outline.closed) continue
    if (Math.abs(outline.points[0].z - top) > Math.max(1, self.height * 1e-4)) continue
    if (!under(path, outline, self.thickness)) continue
    if (!inputs.includes(outlineId)) inputs.push(outlineId)
    roofs.push({ input: inputs.indexOf(outlineId), ...roofParams(obj.history.params) })
  }
  const params: Record<string, unknown> = { ...record.params }
  delete params.joins
  delete params.roofs
  if (joins.length > 0) params.joins = joins
  if (roofs.length > 0) params.roofs = roofs
  return { ...record, inputs, params }
}

/** Records whose own path (their first input) is all that ties them: walls and their pieces. */
export const ownInputOnly = (record: HistoryRecord) => record.command === 'Wall' || record.command === 'OpeningPart' || record.command === 'OpeningSymbol'

/** Is a wall's path under a roof outline (inside it, or within the wall's thickness of its edge)? */
function under(path: AnyCurve, outline: AnyCurve & { type: 'polyline' }, reach: number): boolean {
  const points = tessellate(path)
  const middle = points.length % 2 === 1 ? points[(points.length - 1) / 2] : points[points.length / 2 - 1].clone().lerp(points[points.length / 2], 0.5)
  const poly = outline.points
  let inside = false
  let distance = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > middle.y !== b.y > middle.y && middle.x < ((b.x - a.x) * (middle.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((middle.x - a.x) * dx + (middle.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    distance = Math.min(distance, Math.hypot(a.x + t * dx - middle.x, a.y + t * dy - middle.y))
  }
  return inside || distance <= reach
}
