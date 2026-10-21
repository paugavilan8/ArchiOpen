import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { Document } from './document'

const line = (x: number) => ({ type: 'polyline' as const, points: [new Vector3(x, 0, 0), new Vector3(x + 1, 0, 0)], closed: false })

describe('selection', () => {
  it('lets go of objects that are deleted, locked or hidden, and keeps the rest', () => {
    const doc = new Document()
    const ids = [0, 1, 2, 3].map((x) => doc.add(line(x)).id)
    doc.select(ids)
    doc.remove(ids[0])
    doc.setState(ids[1], { locked: true })
    doc.setState(ids[2], { hidden: 'user' })
    expect([...doc.selection]).toEqual([ids[3]])
    doc.select([ids[3]])
    doc.updateLayer(doc.layerOf(doc.objects.get(ids[3])!).id, { locked: true })
    expect(doc.selection.size).toBe(0)
  })

  it('deletes a large selection in time proportional to its size', () => {
    const doc = new Document()
    doc.begin()
    for (let i = 0; i < 20000; i++) doc.add(line(i))
    doc.commit()
    doc.select([...doc.objects.keys()])
    const t0 = performance.now()
    doc.begin()
    for (const id of [...doc.selection]) doc.remove(id)
    doc.commit()
    // Checking the whole selection on each removal took seconds here.
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(doc.objects.size).toBe(0)
    expect(doc.selection.size).toBe(0)
    doc.undo()
    expect(doc.objects.size).toBe(20000)
  })
})
