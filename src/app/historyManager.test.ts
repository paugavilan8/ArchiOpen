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
})
