import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { Document } from './document'
import { layerMaterial, MATERIAL_PRESETS, materialFromJSON, renderSettingsFromJSON } from './materials'

const line = () => ({ type: 'polyline' as const, points: [new Vector3(), new Vector3(1, 0, 0)], closed: false })

describe('render materials', () => {
  it('resolve from the object, then the layer, then the layer color', () => {
    const doc = new Document()
    const id = doc.add(line()).id
    const obj = doc.objects.get(id)!
    // Without a material: clay in the layer color, lightened (a black layer renders light gray).
    expect(doc.layerOf(obj).color).toBe('#000000')
    expect(doc.materialOf(obj)).toMatchObject({ color: layerMaterial('#000000').color, metalness: 0 })
    expect(layerMaterial('#000000').color).toBe('#999794')
    expect(layerMaterial('#ff0000').color).toBe('#f39794')
    doc.setMaterials([MATERIAL_PRESETS.find((m) => m.name === 'Gold')!, MATERIAL_PRESETS.find((m) => m.name === 'Glass')!])
    doc.updateLayer(obj.layerId, { material: 'Glass' })
    expect(doc.materialOf(obj).name).toBe('Glass')
    doc.begin()
    doc.setState(id, { material: 'Gold' })
    doc.commit()
    expect(doc.materialOf(doc.objects.get(id)!).name).toBe('Gold')
    doc.undo()
    expect(doc.objects.get(id)!.material).toBeUndefined()
    doc.redo()
    expect(doc.objects.get(id)!.material).toBe('Gold')
  })

  it('save and load with the model, sun included', () => {
    const doc = new Document()
    const id = doc.add(line()).id
    doc.setMaterials([{ name: 'Brass', color: '#c9a44c', roughness: 0.3, metalness: 1, transparency: 0 }])
    doc.setState(id, { material: 'Brass' })
    doc.setRenderSettings({ sunAzimuth: 90, background: 'Sky' })
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.materials).toEqual(doc.materials)
    expect(copy.objects.get(id)!.material).toBe('Brass')
    expect(copy.renderSettings).toMatchObject({ sunAzimuth: 90, background: 'Sky', groundShadows: true })
  })

  it('keep textures, and drop broken ones', () => {
    const brick = MATERIAL_PRESETS.find((m) => m.name === 'Brick')!
    expect(brick.texture).toMatchObject({ kind: 'Brick', size: 0.5 })
    expect(materialFromJSON(JSON.parse(JSON.stringify(brick)))).toEqual(brick)
    const picture = { kind: 'Image', image: 'data:image/jpeg;base64,AAAA', size: 2, rotation: 90, bump: 0.5 }
    expect(materialFromJSON({ name: 'P', texture: picture } as never)!.texture).toEqual(picture)
    // A picture without its image, or an unknown pattern, is left out; odd numbers get defaults.
    expect(materialFromJSON({ name: 'P', texture: { kind: 'Image', size: 1 } } as never)!.texture).toBeUndefined()
    expect(materialFromJSON({ name: 'P', texture: { kind: 'Plaid' } } as never)!.texture).toBeUndefined()
    expect(materialFromJSON({ name: 'P', texture: { kind: 'Wood', size: -3, bump: 7 } } as never)!.texture).toEqual({ kind: 'Wood', size: 1, rotation: 0, bump: 1 })
  })

  it('read damaged values sensibly', () => {
    expect(materialFromJSON({ name: '' })).toBeNull()
    expect(materialFromJSON({ name: 'X', color: 'red', roughness: 7, metalness: -1 })).toEqual({ name: 'X', color: '#cccccc', roughness: 1, metalness: 0, transparency: 0 })
    expect(renderSettingsFromJSON({ sunAltitude: 200, background: 'Neon' as never })).toMatchObject({ sunAltitude: 90, background: 'Studio' })
  })
})
