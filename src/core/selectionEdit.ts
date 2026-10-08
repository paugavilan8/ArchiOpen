import { Box3, Matrix4, Vector3 } from 'three'
import { controlPoints, transform, withControlPoints } from './curves'
import type { Document } from './document'
import { expandBox, Geometry } from './geometry'

/**
 * What direct editing (dragging, the gumball) acts on: the selected control points if there are
 * any, otherwise the selected objects.
 */
export function editingPoints(doc: Document): boolean {
  return doc.selectedPointCount > 0
}

/** Ids of the objects that an edit of the current selection changes. */
export function editedIds(doc: Document): number[] {
  return editingPoints(doc) ? [...doc.pointSelection.keys()] : [...doc.selection]
}

/** Bounding box of what is being edited, or an empty box. */
export function editBox(doc: Document): Box3 {
  const box = new Box3()
  if (editingPoints(doc)) {
    for (const [id, indices] of doc.pointSelection) {
      const pts = controlPoints(doc.objects.get(id)!.geometry)!
      for (const i of indices) box.expandByPoint(pts[i])
    }
  } else {
    for (const id of doc.selection) {
      const obj = doc.objects.get(id)
      if (obj) expandBox(box, obj.geometry)
    }
  }
  return box
}

/** New geometry for every edited object after applying m to the selection. */
export function transformedSelection(doc: Document, m: Matrix4): Map<number, Geometry> {
  const result = new Map<number, Geometry>()
  if (editingPoints(doc)) {
    for (const [id, indices] of doc.pointSelection) {
      const g = doc.objects.get(id)!.geometry
      const pts = controlPoints(g)!.map((p, i) => (indices.has(i) ? p.clone().applyMatrix4(m) : p))
      result.set(id, withControlPoints(g, pts))
    }
  } else {
    for (const id of doc.selection) {
      const obj = doc.objects.get(id)
      if (obj) result.set(id, transform(obj.geometry, m))
    }
  }
  return result
}

/** Applies m to the selection as one undo step. */
export function transformSelection(doc: Document, m: Matrix4): void {
  const changed = transformedSelection(doc, m)
  doc.begin()
  for (const [id, g] of changed) doc.setGeometry(id, g)
  doc.commit()
}

export function translation(delta: Vector3): Matrix4 {
  return new Matrix4().makeTranslation(delta.x, delta.y, delta.z)
}
