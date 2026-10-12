import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import { placeInstance, redefineBlock } from '../core/blocks'
import type { BlockDefinition } from '../core/geometry'
import { adoptModel, archiAsImport } from './rhinoModel'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/** A small model saved as .archi: a line on a "Walls" layer, a block and a copy of it, and a hidden line. */
function archiFile(units = 'Meters') {
  const other = new Document()
  other.setUnits(units)
  const walls = other.addLayer()
  other.updateLayer(walls.id, { name: 'Walls' })
  other.begin()
  other.add({ type: 'polyline', points: [v(0, 0), v(2, 0)], closed: false }, walls.id)
  const column: BlockDefinition = { name: 'Column', objects: [{ layerId: walls.id, geometry: { type: 'polyline', points: [v(0, 0), v(0, 0, 3)], closed: false } }] }
  other.setBlock('Column', column)
  other.add(placeInstance(column, v(1, 1)), walls.id)
  const hidden = other.add({ type: 'polyline', points: [v(5, 5), v(6, 6)], closed: false }, walls.id)
  other.commit()
  hidden.hidden = 'user'
  return JSON.parse(JSON.stringify(other.toJSON()))
}

describe('linked files', () => {
  it('reads an .archi model as content to link: its visible objects, layers and blocks', () => {
    const model = archiAsImport(archiFile())
    expect(model.units).toBe('Meters')
    expect(model.objects).toHaveLength(2)
    expect(model.layers[model.objects[0].layer].name).toBe('Walls')
    const instance = model.objects.find((o) => o.geometry.type === 'instance')!.geometry
    expect(instance.type === 'instance' && instance.definition.objects).toHaveLength(1)
  })

  it('brings it into a model in its units, on its own layers, and keeps the link when saved and opened', () => {
    const doc = new Document()
    doc.begin()
    const { objects, scaledFrom } = adoptModel(doc, archiAsImport(archiFile()), (layer) => `house: ${layer}`)
    expect(scaledFrom).toBe('Meters')
    const line = objects.find((o) => o.geometry.type === 'polyline')!.geometry
    expect(line.type === 'polyline' && line.points[1].x).toBeCloseTo(2000)
    expect(doc.layers.some((l) => l.name === 'house: Walls')).toBe(true)
    const definition: BlockDefinition = { name: 'house', objects, link: { source: '/projects/house.archi', fileName: 'house.archi' } }
    doc.setBlock('house', definition)
    doc.add(placeInstance(definition, v(0, 0)), doc.currentLayerId)
    doc.commit()

    // Read again (UpdateLinks): the link stays, and so do the instances' ties.
    redefineBlock(doc, { ...definition, objects: objects.slice(0, 1) })
    expect(doc.blocks.get('house')!.link?.source).toBe('/projects/house.archi')

    const reopened = new Document()
    reopened.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(reopened.blocks.get('house')!.link).toEqual({ source: '/projects/house.archi', fileName: 'house.archi' })
    expect(reopened.blocks.get('house')!.objects).toHaveLength(1)
  })
})
