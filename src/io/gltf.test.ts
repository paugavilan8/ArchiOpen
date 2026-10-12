import { describe, expect, it } from 'vitest'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Mesh, MeshStandardMaterial } from 'three'
import { writeGlb } from './gltf'
import { layerMaterial } from '../core/materials'

describe('writeGlb', () => {
  const square = {
    name: 'Floor',
    positions: [0, 0, 0, 1000, 0, 0, 1000, 2000, 0, 0, 2000, 500],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
    material: { ...layerMaterial('#ff0000'), roughness: 0.3, metalness: 0.5, transparency: 0.25 },
  }

  it('writes a binary glTF that three.js reads back, in meters with Y up', async () => {
    const bytes = writeGlb([square], 0.001)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('glTF')
    expect(bytes.length % 4).toBe(0)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const gltf = await new Promise<{ scene: { children: Mesh[] } }>((resolve, reject) => new GLTFLoader().parse(buffer as ArrayBuffer, '', resolve as never, reject))
    const mesh = gltf.scene.children[0]
    expect(mesh.name).toBe('Floor')
    const pos = mesh.geometry.getAttribute('position')
    expect(pos.count).toBe(4)
    // (1000, 2000, 0) mm is (1, 0, -2) m with Y up; the raised corner (0, 2000, 500) is 0.5 up.
    expect([pos.getX(2), pos.getY(2), pos.getZ(2)].map((x) => +x.toFixed(6))).toEqual([1, 0, -2])
    expect(+pos.getY(3).toFixed(6)).toBe(0.5)
    expect(mesh.geometry.index!.count).toBe(6)
    const m = mesh.material as MeshStandardMaterial
    expect(m.roughness).toBeCloseTo(0.3)
    expect(m.metalness).toBeCloseTo(0.5)
    expect(m.opacity).toBeCloseTo(0.75)
    expect(m.transparent).toBe(true)
  })

  it('shares one material between objects that use it', () => {
    const bytes = writeGlb([square, { ...square, name: 'Other' }], 1)
    const length = new DataView(bytes.buffer).getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + length)))
    expect(json.materials).toHaveLength(1)
    expect(json.meshes).toHaveLength(2)
  })
})
