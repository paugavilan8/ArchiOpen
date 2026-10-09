import { Box3, Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { defineBlock, flatten, insertionPoint, placeInstance, usesBlock } from './blocks'
import { transform } from './curves'
import { Document } from './document'
import { AnyCurve, InstanceGeometry, snapPoints, wireframe } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const square: AnyCurve = { type: 'polyline', points: [v(0, 0), v(2, 0), v(2, 2), v(0, 2)], closed: true }
const circle: AnyCurve = { type: 'circle', center: v(1, 1), xaxis: v(1, 0), yaxis: v(0, 1), radius: 0.5 }
const bounds = (g: InstanceGeometry) => new Box3().setFromPoints(wireframe(g).flat())

describe('blocks', () => {
  // A 2 × 2 square with a circle, its base point at the square's center.
  const chair = defineBlock('Chair', [{ layerId: 1, geometry: square }, { layerId: 2, geometry: circle }], v(1, 1))

  it('places a definition with a position, scale and rotation', () => {
    const g = placeInstance(chair, v(10, 5), 2, Math.PI / 2)
    const b = bounds(g)
    expect(b.min.x).toBeCloseTo(8, 9)
    expect(b.max.x).toBeCloseTo(12, 9)
    expect(b.min.y).toBeCloseTo(3, 9)
    expect(insertionPoint(g).toArray()).toEqual([10, 5, 0])
    // The circle stays a circle, and its center snaps.
    const [, inner] = flatten(g)
    expect(inner.type).toBe('circle')
    expect(snapPoints(g).cen[0].distanceTo(v(10, 5))).toBeLessThan(1e-9)
  })

  it('moves instances by their transform and expands nested blocks', () => {
    const table = defineBlock('Table', [{ layerId: 1, geometry: placeInstance(chair, v(3, 0)) }, { layerId: 1, geometry: placeInstance(chair, v(-3, 0)) }], v(0, 0))
    const g = transform(placeInstance(table, v(0, 0)), new Matrix4().makeTranslation(0, 10, 0))
    expect(flatten(g)).toHaveLength(4)
    expect(bounds(g).min.y).toBeCloseTo(9, 9)
    expect(usesBlock(table, 'Chair')).toBe(true)
    expect(usesBlock(chair, 'Table')).toBe(false)
  })
})

describe('documents with blocks and groups', () => {
  const chair = defineBlock('Chair', [{ layerId: 1, geometry: square }], v(0, 0))

  it('saves and reloads blocks (also nested ones) and instances', () => {
    const doc = new Document()
    doc.setBlock('Chair', chair)
    const table = defineBlock('Table', [{ layerId: 1, geometry: placeInstance(chair, v(3, 0)) }], v(0, 0))
    doc.setBlock('Table', table)
    doc.add(placeInstance(table, v(0, 10)))
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    const g = [...copy.objects.values()][0].geometry as InstanceGeometry
    expect(g.definition).toBe(copy.blocks.get('Table'))
    expect(flatten(g)).toHaveLength(1)
    expect(bounds(g).min.toArray()).toEqual([3, 10, 0])
    expect(copy.blockUsage().get('Chair')).toBe(1)
  })

  it('undoes block definitions and redefinitions', () => {
    const doc = new Document()
    doc.setBlock('Chair', chair)
    const bigger = defineBlock('Chair', [{ layerId: 1, geometry: transform(square, new Matrix4().makeScale(2, 2, 2)) }], v(0, 0))
    doc.setBlock('Chair', bigger)
    expect(doc.blocks.get('Chair')).toBe(bigger)
    doc.undo()
    expect(doc.blocks.get('Chair')).toBe(chair)
    doc.undo()
    expect(doc.blocks.has('Chair')).toBe(false)
  })

  it('groups objects so that picking one picks them all, with undo', () => {
    const doc = new Document()
    const ids = [1, 2, 3].map((i) => doc.add({ type: 'polyline', points: [v(i, 0), v(i, 1)], closed: false }).id)
    doc.group(ids.slice(0, 2))
    expect(doc.withGroups([ids[0]]).sort()).toEqual([ids[0], ids[1]])
    expect(doc.withGroups([ids[2]])).toEqual([ids[2]])
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.withGroups([ids[1]]).sort()).toEqual([ids[0], ids[1]])
    // A new group after reloading does not reuse the old number.
    expect(copy.group([ids[2]])).toBe(2)
    doc.undo()
    expect(doc.withGroups([ids[0]])).toEqual([ids[0]])
  })

  it('lets only the edited block be picked during a block edit, and undo leaves the mode', () => {
    const doc = new Document()
    const other = doc.add(square)
    doc.begin()
    doc.setBlockEdit({ block: 'Chair', instanceId: other.id, matrix: new Matrix4().toArray(), startId: other.id + 1 })
    const inside = doc.add(circle)
    doc.commit()
    expect(doc.isSelectable(other)).toBe(false)
    expect(doc.isSelectable(inside)).toBe(true)
    doc.undo()
    expect(doc.blockEdit).toBeNull()
    expect(doc.isSelectable(other)).toBe(true)
  })
})

describe('hiding, locking and selection history', () => {
  const line = (i: number): AnyCurve => ({ type: 'polyline', points: [v(i, 0), v(i, 1)], closed: false })

  it('hides and locks objects with undo, and saves the state', () => {
    const doc = new Document()
    const a = doc.add(line(1))
    const b = doc.add(line(2))
    doc.select([a.id, b.id])
    doc.setState(a.id, { hidden: 'user' })
    doc.setState(b.id, { locked: true })
    expect(doc.isVisible(a)).toBe(false)
    expect(doc.isVisible(b)).toBe(true)
    expect(doc.isSelectable(b)).toBe(false)
    // Hidden and locked objects drop out of the selection.
    expect(doc.selection.size).toBe(0)
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.objects.get(a.id)!.hidden).toBe('user')
    expect(copy.objects.get(b.id)!.locked).toBe(true)
    doc.undo()
    doc.undo()
    expect(doc.isVisible(a) && doc.isSelectable(b)).toBe(true)
    expect('hidden' in doc.objects.get(a.id)!).toBe(false)
  })

  it('remembers the last objects made and the previous selection', () => {
    const doc = new Document()
    doc.begin()
    const a = doc.add(line(1))
    const b = doc.add(line(2))
    doc.commit()
    expect(doc.lastCreated).toEqual([a.id, b.id])
    doc.select([a.id])
    doc.select([b.id])
    expect(doc.previousSelection).toEqual([a.id])
    doc.clearSelection()
    expect(doc.previousSelection).toEqual([b.id])
  })
})
