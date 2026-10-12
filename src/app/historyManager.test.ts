import { Matrix4, Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { transform } from '../core/curves'
import { Document } from '../core/document'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { Settings } from '../core/settings'
import { loftCurves, shapeOf, toBrep } from '../kernel/brep'
import { shapeBounds } from '../kernel/measure'
import { HistoryManager } from './historyManager'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const circle = (z: number, r: number): AnyCurve => ({ type: 'circle', center: v(0, 0, z), xaxis: v(1, 0), yaxis: v(0, 1), radius: r })
const top = (doc: Document, id: number) => shapeBounds(shapeOf(doc.objects.get(id)!.geometry as BrepGeometry)).max

/** A document with two circles and a loft made from them, with history. */
function lofted() {
  const doc = new Document()
  const settings = new Settings()
  const log = vi.fn()
  const history = new HistoryManager(doc, settings, log)
  const a = doc.add(circle(0, 2)).id
  const b = doc.add(circle(5, 1)).id
  doc.begin()
  const loft = doc.add(toBrep(loftCurves([circle(0, 2), circle(5, 1)]))).id
  history.record(loft, 'Loft', [a, b])
  doc.commit()
  return { doc, settings, history, log, a, b, loft }
}

describe('construction history', () => {
  it('rebuilds a loft when one of its curves moves, in the same undo step', async () => {
    const { doc, history, a, b, loft } = lofted()
    expect(top(doc, loft).z).toBeCloseTo(5, 6)
    doc.begin()
    doc.setGeometry(b, transform(doc.objects.get(b)!.geometry, new Matrix4().makeTranslation(0, 0, 3)))
    doc.commit()
    await history.settled
    expect(top(doc, loft).z).toBeCloseTo(8, 6)
    expect(doc.objects.get(loft)!.history).toEqual({ command: 'Loft', inputs: [a, b] })
    // One undo puts the curve and the loft back together.
    doc.undo()
    expect(top(doc, loft).z).toBeCloseTo(5, 6)
    doc.redo()
    expect(top(doc, loft).z).toBeCloseTo(8, 6)
  })

  it('also follows single edits outside a transaction', async () => {
    const { doc, history, a, loft } = lofted()
    doc.setGeometry(a, circle(0, 4))
    await history.settled
    expect(top(doc, loft).x).toBeCloseTo(4, 6)
  })

  it('breaks when the result is edited by hand or an input is deleted', async () => {
    const one = lofted()
    one.doc.setGeometry(one.loft, transform(one.doc.objects.get(one.loft)!.geometry, new Matrix4().makeTranslation(10, 0, 0)))
    await one.history.settled
    expect(one.doc.objects.get(one.loft)!.history).toBeUndefined()
    // Moving the curve now leaves the loft alone.
    one.doc.setGeometry(one.b, circle(9, 1))
    await one.history.settled
    expect(top(one.doc, one.loft).z).toBeCloseTo(5, 6)

    const two = lofted()
    two.doc.remove(two.a)
    await two.history.settled
    expect(two.doc.objects.get(two.loft)!.history).toBeUndefined()
    // Undoing the delete brings the history back too.
    two.doc.undo()
    expect(two.doc.objects.get(two.loft)!.history?.command).toBe('Loft')
  })

  it('records nothing when history is off, and saves records with the model', async () => {
    const { doc, settings, history, a, b, loft } = lofted()
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.objects.get(loft)!.history).toEqual({ command: 'Loft', inputs: [a, b] })
    settings.toggle('history')
    const other = doc.add(toBrep(loftCurves([circle(0, 1), circle(1, 1)]))).id
    history.record(other, 'Loft', [a, b])
    expect(doc.objects.get(other)!.history).toBeUndefined()
  })

  it('reports curves that no longer make the object, and keeps it', async () => {
    const { doc, history, log, a, loft } = lofted()
    const before = doc.objects.get(loft)!.geometry
    // A loft between a circle and a single point-like line fails.
    doc.setGeometry(a, { type: 'polyline', points: [v(0, 0), v(0, 0)], closed: false })
    await history.settled
    expect(doc.objects.get(loft)!.geometry).toBe(before)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not update'))
  })

  it('makes a wall again from new parameters, keeping its history, as one undo step', async () => {
    const doc = new Document()
    const history = new HistoryManager(doc, new Settings(), vi.fn())
    const path = doc.add({ type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }).id
    const wall = doc.add({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }).id
    doc.begin()
    await history.remake(wall, { command: 'Wall', inputs: [path], params: { thickness: 200, height: 3000 } })
    doc.commit()
    await history.settled
    const width = () => {
      const b = shapeBounds(shapeOf(doc.objects.get(wall)!.geometry as BrepGeometry))
      return b.max.y - b.min.y
    }
    expect(width()).toBeCloseTo(200, 6)
    await history.remakeStep(wall, { command: 'Wall', inputs: [path], params: { thickness: 300, height: 3000 } })
    await history.settled
    expect(width()).toBeCloseTo(300, 6)
    expect(doc.objects.get(wall)!.history?.params?.thickness).toBe(300)
    // Still following its path, with the new thickness.
    doc.setGeometry(path, { type: 'polyline', points: [v(0, 0), v(5000, 1000)], closed: false })
    await history.settled
    expect(doc.objects.get(wall)!.history).toBeDefined()
    doc.undo()
    await history.settled
    doc.undo()
    await history.settled
    expect(width()).toBeCloseTo(200, 6)
    expect(doc.objects.get(wall)!.history?.params?.thickness).toBe(200)
  })

  it('keeps the frames and glass of a wall in line with it', async () => {
    const doc = new Document()
    const history = new HistoryManager(doc, new Settings(), vi.fn())
    const path = doc.add({ type: 'polyline', points: [v(0, 0), v(5000, 0)], closed: false }).id
    const wall = doc.add({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }).id
    const window = { id: 1, kind: 'window', at: 1500, width: 1200, height: 1200, sill: 900 }
    const door = { id: 2, kind: 'door', at: 3500, width: 900, height: 2100, sill: 0 }
    const parts = () =>
      [...doc.objects.values()]
        .filter((o) => o.history?.command === 'OpeningPart')
        .map((o) => `${(o.history!.params!.opening as { id: number }).id}:${o.history!.params!.part}@${doc.layerOf(o).name}`)
        .sort()
    doc.begin()
    await history.remake(wall, { command: 'Wall', inputs: [path], params: { thickness: 200, height: 3000, openings: [window, door] } })
    doc.commit()
    await history.settled
    expect(parts()).toEqual(['1:frame@Windows', '1:glass@Glazing', '2:frame@Doors', '2:leaf@Doors'])
    expect(doc.materials.map((m) => m.name).sort()).toEqual(['Glass', 'Window frame', 'Wood'])
    const glassOf = () => [...doc.objects.values()].find((o) => o.history?.params?.part === 'glass')!
    const glassY = () => {
      const b = shapeBounds(shapeOf(glassOf().geometry as BrepGeometry))
      return (b.min.y + b.max.y) / 2
    }
    expect(glassY()).toBeCloseTo(0, 6)
    // New parameters: the pieces move to the middle of the new wall; the door taken out goes.
    await history.remakeStep(wall, { command: 'Wall', inputs: [path], params: { thickness: 200, height: 3000, justification: 'left', openings: [window] } })
    await history.settled
    expect(parts()).toEqual(['1:frame@Windows', '1:glass@Glazing'])
    expect(glassY()).toBeCloseTo(100, 6)
    // Moving the line moves them all.
    doc.setGeometry(path, { type: 'polyline', points: [v(0, 1000), v(5000, 1000)], closed: false })
    await history.settled
    expect(glassY()).toBeCloseTo(1100, 6)
    // One undo brings the door back.
    doc.undo()
    await history.settled
    doc.undo()
    await history.settled
    expect(parts()).toHaveLength(4)
    // Deleting the wall leaves its pieces as plain solids.
    doc.remove(wall)
    await history.settled
    expect(parts()).toHaveLength(0)
    expect([...doc.objects.values()].filter((o) => o.geometry.type === 'brep')).toHaveLength(4)
  })

  it('joins walls that meet, and keeps them joined as they change', async () => {
    const doc = new Document()
    const history = new HistoryManager(doc, new Settings(), vi.fn())
    const line = (a: Vector3, b: Vector3) => ({ type: 'polyline' as const, points: [a, b], closed: false })
    const makeWall = async (a: Vector3, b: Vector3) => {
      doc.begin()
      const path = doc.add(line(a, b)).id
      const wall = doc.add(line(v(0, 0), v(1, 0))).id
      await history.remake(wall, { command: 'Wall', inputs: [path], params: { thickness: 200, height: 3000 } })
      doc.commit()
      await history.settled
      return { path, wall }
    }
    const bounds = (id: number) => shapeBounds(shapeOf(doc.objects.get(id)!.geometry as BrepGeometry))
    const a = await makeWall(v(0, 0), v(4000, 0))
    expect(bounds(a.wall).max.x).toBeCloseTo(4000, 6)
    // A second wall from a's end: both are mitred, so a now reaches the corner's far side.
    const b = await makeWall(v(4000, 0), v(4000, 3000))
    expect(bounds(a.wall).max.x).toBeCloseTo(4100, 6)
    expect(bounds(b.wall).min.y).toBeCloseTo(-100, 6)
    expect((doc.objects.get(a.wall)!.history!.params!.joins as unknown[]).length).toBe(1)
    // b made thicker: a's mitre follows.
    await history.remakeStep(b.wall, { ...doc.objects.get(b.wall)!.history!, params: { ...doc.objects.get(b.wall)!.history!.params, thickness: 400 } })
    await history.settled
    expect(bounds(a.wall).max.x).toBeCloseTo(4200, 6)
    // A wall meeting a's side stops at its face.
    const c = await makeWall(v(2000, 0), v(2000, -2000))
    expect(bounds(c.wall).max.y).toBeCloseTo(-100, 6)
    // b's line moved away: a's end is square again.
    doc.setGeometry(b.path, line(v(6000, 0), v(6000, 3000)))
    await history.settled
    expect(bounds(a.wall).max.x).toBeCloseTo(4000, 6)
    expect(doc.objects.get(a.wall)!.history!.params!.joins).toBeUndefined()
    // c deleted: a keeps its history.
    doc.remove(c.wall)
    await history.settled
    expect(doc.objects.get(a.wall)!.history).toBeDefined()
  })

  it('raises walls to a roof resting on them, and follows the roof', async () => {
    const doc = new Document()
    const history = new HistoryManager(doc, new Settings(), vi.fn())
    const room = (z: number) => ({ type: 'polyline' as const, points: [v(0, 0, z), v(8000, 0, z), v(8000, 6000, z), v(0, 6000, z)], closed: true })
    doc.begin()
    const path = doc.add(room(0)).id
    const wall = doc.add(room(0)).id
    await history.remake(wall, { command: 'Wall', inputs: [path], params: { thickness: 200, height: 3000 } })
    doc.commit()
    await history.settled
    const top = (id: number) => shapeBounds(shapeOf(doc.objects.get(id)!.geometry as BrepGeometry)).max.z
    expect(top(wall)).toBeCloseTo(3000, 6)
    // A gable roof over it, resting at its top: the gable walls go up to the ridge.
    doc.begin()
    const outline = doc.add(room(3000)).id
    const roof = doc.add(room(0)).id
    await history.remake(roof, { command: 'Roof', inputs: [outline], params: { type: 'gable', pitch: 30, overhang: 500, thickness: 250 } })
    doc.commit()
    await history.settled
    const tan = (deg: number) => Math.tan((deg * Math.PI) / 180)
    expect(doc.objects.get(wall)!.history!.params!.roofs).toHaveLength(1)
    expect(top(wall)).toBeCloseTo(3000 + 3000 * tan(30), 3)
    // Steeper roof: the walls follow.
    await history.remakeStep(roof, { ...doc.objects.get(roof)!.history!, params: { ...doc.objects.get(roof)!.history!.params, pitch: 40 } })
    await history.settled
    expect(top(wall)).toBeCloseTo(3000 + 3000 * tan(40), 3)
    // Roof deleted: back to their own height.
    doc.remove(roof)
    await history.settled
    expect(top(wall)).toBeCloseTo(3000, 6)
    expect(doc.objects.get(wall)!.history!.params!.roofs).toBeUndefined()
  })

  it('keeps railings on a stair in line with it', async () => {
    const doc = new Document()
    const history = new HistoryManager(doc, new Settings(), vi.fn())
    doc.begin()
    const line = doc.add({ type: 'polyline', points: [v(0, 0), v(0, 4000)], closed: false }).id
    const stair = doc.add({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }).id
    await history.remake(stair, { command: 'Stair', inputs: [line], params: { width: 1000, height: 2800, risers: 16 } })
    const railing = doc.add({ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }).id
    await history.remake(railing, { command: 'Railing', inputs: [line], params: { height: 1000, sides: 'both', stair, stairParams: doc.objects.get(stair)!.history!.params } })
    doc.commit()
    await history.settled
    const width = () => {
      const b = shapeBounds(shapeOf(doc.objects.get(railing)!.geometry as BrepGeometry))
      return b.max.x - b.min.x
    }
    expect(width()).toBeCloseTo(1000 - 2 * 40 + 50, 6)
    // A wider stair: the railings move out with its sides.
    await history.remakeStep(stair, { ...doc.objects.get(stair)!.history!, params: { ...doc.objects.get(stair)!.history!.params, width: 1400 } })
    await history.settled
    expect(width()).toBeCloseTo(1400 - 2 * 40 + 50, 6)
    // A longer line: both follow it.
    doc.setGeometry(line, { type: 'polyline', points: [v(0, 0), v(0, 5000)], closed: false })
    await history.settled
    expect(shapeBounds(shapeOf(doc.objects.get(railing)!.geometry as BrepGeometry)).max.y).toBeCloseTo(5000 + 25, 0)
  })
})
