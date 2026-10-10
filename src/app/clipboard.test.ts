import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import { Document } from '../core/document'
import type { BlockDefinition, CircleGeometry, InstanceGeometry, PolylineGeometry } from '../core/geometry'
import { copyObjects, pasteObjects, readClipboard } from './clipboard'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const line = (a: Vector3, b: Vector3): PolylineGeometry => ({ type: 'polyline', points: [a, b], closed: false })

/** A drawing in millimeters: a wall line on its own layer, a grouped pair, and two copies of a block. */
function source(): { doc: Document; ids: number[]; chair: BlockDefinition } {
  const doc = new Document()
  const walls = doc.addLayer()
  doc.updateLayer(walls.id, { name: 'Walls', color: '#c0392b', material: 'Brick' })
  doc.setMaterials([{ name: 'Brick', color: '#a0522d', roughness: 0.9, metalness: 0, transparency: 0 }])
  const wall = doc.add(line(v(0, 0), v(4000, 0)), walls.id)
  const a = doc.add(line(v(0, 1000), v(1000, 1000)))
  const b = doc.add({ type: 'circle', center: v(500, 1500), xaxis: v(1, 0), yaxis: v(0, 1), radius: 200 } as CircleGeometry)
  doc.group([a.id, b.id])
  const leg: BlockDefinition = { name: 'Leg', objects: [{ layerId: walls.id, geometry: line(v(0, 0), v(0, 0, 450)) }] }
  const chair: BlockDefinition = {
    name: 'Chair',
    objects: [{ layerId: doc.currentLayerId, geometry: { type: 'instance', definition: leg, matrix: new Matrix4().toArray() } }],
  }
  doc.setBlock('Leg', leg)
  doc.setBlock('Chair', chair)
  const at = (x: number): InstanceGeometry => ({ type: 'instance', definition: chair, matrix: new Matrix4().makeTranslation(x, 0, 0).toArray() })
  const c1 = doc.add(at(0))
  const c2 = doc.add(at(800))
  doc.setState(c2.id, { material: 'Brick' })
  return { doc, ids: [wall.id, a.id, b.id, c1.id, c2.id], chair }
}

describe('copy and paste', () => {
  it('only reads what ArchiOpen copied', () => {
    expect(readClipboard('Line')).toBeNull()
    expect(readClipboard('{"a": 1}')).toBeNull()
    expect(readClipboard('{ broken ArchiOpen clipboard')).toBeNull()
  })

  it('carries objects, their layers, blocks, materials and groups into another file, in its units', () => {
    const { doc, ids } = source()
    const text = copyObjects(doc, ids)
    const target = new Document()
    target.setUnits('Meters')
    const pasted = pasteObjects(target, readClipboard(text)!)
    expect(pasted).toHaveLength(5)
    const objects = pasted.map((id) => target.objects.get(id)!)
    // The Walls layer comes along, with its color and material.
    const walls = target.layers.find((l) => l.name === 'Walls')!
    expect(walls.color).toBe('#c0392b')
    expect(walls.material).toBe('Brick')
    expect(objects[0].layerId).toBe(walls.id)
    expect(target.materials.map((m) => m.name)).toEqual(['Brick'])
    // Millimeters to meters.
    expect((objects[0].geometry as PolylineGeometry).points[1].x).toBeCloseTo(4)
    // The pair is a group again, of its own.
    expect(objects[1].groups).toHaveLength(1)
    expect(objects[1].groups).toEqual(objects[2].groups)
    // Both chairs use one Chair block, which holds the Leg block, scaled to meters.
    const [c1, c2] = [objects[3].geometry, objects[4].geometry] as InstanceGeometry[]
    expect(c1.definition).toBe(c2.definition)
    expect([...target.blocks.keys()].sort()).toEqual(['Chair', 'Leg'])
    expect(new Matrix4().fromArray(c2.matrix).elements[12]).toBeCloseTo(0.8)
    const leg = target.blocks.get('Leg')!
    expect((leg.objects[0].geometry as PolylineGeometry).points[1].z).toBeCloseTo(0.45)
    expect(objects[4].material).toBe('Brick')
  })

  it('pasted back into the same file, lands where it was and reuses its blocks and layers', () => {
    const { doc, ids, chair } = source()
    const layers = doc.layers.length
    const pasted = pasteObjects(doc, readClipboard(copyObjects(doc, ids))!)
    expect(doc.objects.size).toBe(10)
    expect(doc.layers).toHaveLength(layers)
    expect(doc.blocks.size).toBe(2)
    expect((doc.objects.get(pasted[3])!.geometry as InstanceGeometry).definition).toBe(chair)
    expect((doc.objects.get(pasted[0])!.geometry as PolylineGeometry).points[1].x).toBe(4000)
    // A new group, not the one copied.
    const original = doc.objects.get(ids[1])!.groups
    expect(doc.objects.get(pasted[1])!.groups).not.toEqual(original)
  })

  it('keeps a changed block apart, under a new name', () => {
    const { doc, ids } = source()
    const text = copyObjects(doc, [ids[3]])
    const other = new Document()
    other.setBlock('Chair', { name: 'Chair', objects: [{ layerId: other.currentLayerId, geometry: line(v(0, 0), v(1, 1)) }] })
    const [id] = pasteObjects(other, readClipboard(text)!)
    expect((other.objects.get(id)!.geometry as InstanceGeometry).definition.name).toBe('Chair 2')
  })
})
