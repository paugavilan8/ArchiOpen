import { findJoins, wallParams, type SavedJoin, type WallRef } from '../core/architecture'
import type { Document, HistoryRecord } from '../core/document'
import { isCurve } from '../core/geometry'

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
  const params: Record<string, unknown> = { ...record.params }
  delete params.joins
  if (joins.length > 0) params.joins = joins
  return { ...record, inputs, params }
}

/** Records whose own path (their first input) is all that ties them: walls and their pieces. */
export const ownInputOnly = (record: HistoryRecord) => record.command === 'Wall' || record.command === 'OpeningPart'
