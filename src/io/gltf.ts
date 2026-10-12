import type { Material } from '../core/materials'

/**
 * glTF 2.0 binary (.glb): the model's surfaces, solids and meshes as triangles with their render
 * materials (base color, roughness, metalness and transparency), for web viewers, Blender, Unreal,
 * Unity, Twinmotion and AR. glTF is in meters with Y up, so the model is scaled and turned to it.
 */

export interface GltfObject {
  name: string
  /** x, y, z of each vertex, in model units with Z up. */
  positions: number[]
  /** A normal for each vertex; without them viewers shade every triangle flat. */
  normals?: number[]
  /** Three vertex indices for each triangle, counterclockwise seen from outside. */
  indices: number[]
  material: Material
}

const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963
const FLOAT = 5126
const UNSIGNED_INT = 5125

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** A material's color as glTF's linear RGBA. */
function baseColor(m: Material): [number, number, number, number] {
  const hex = /^#?([0-9a-f]{6})$/i.exec(m.color)?.[1] ?? '808080'
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255))
  return [r, g, b, 1 - Math.min(Math.max(m.transparency, 0), 1)]
}

/** The objects as a .glb file; `toMeters` scales model units to meters. */
export function writeGlb(objects: GltfObject[], toMeters: number): Uint8Array {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const bufferViews: object[] = []
  const accessors: object[] = []
  const add = (data: Float32Array | Uint32Array, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target })
    chunks.push(bytes)
    byteLength += bytes.byteLength
    return bufferViews.length - 1
  }

  const materials: object[] = []
  const materialIndex = new Map<string, number>()
  const materialFor = (m: Material) => {
    const key = JSON.stringify([m.name, m.color, m.roughness, m.metalness, m.transparency])
    let i = materialIndex.get(key)
    if (i === undefined) {
      const color = baseColor(m)
      materials.push({
        name: m.name,
        pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: m.metalness, roughnessFactor: m.roughness },
        ...(color[3] < 1 ? { alphaMode: 'BLEND' } : {}),
        doubleSided: true,
      })
      materialIndex.set(key, (i = materials.length - 1))
    }
    return i
  }

  const meshes: object[] = []
  const nodes: object[] = []
  for (const o of objects) {
    if (o.indices.length === 0) continue
    const count = o.positions.length / 3
    // Z up in model units to Y up in meters: (x, y, z) -> (x, z, -y).
    const positions = new Float32Array(count * 3)
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) {
      const p = [o.positions[3 * i] * toMeters, o.positions[3 * i + 2] * toMeters, -o.positions[3 * i + 1] * toMeters]
      for (let c = 0; c < 3; c++) {
        positions[3 * i + c] = p[c]
        min[c] = Math.min(min[c], Math.fround(p[c]))
        max[c] = Math.max(max[c], Math.fround(p[c]))
      }
    }
    const attributes: Record<string, number> = {}
    accessors.push({ bufferView: add(positions, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3', min, max })
    attributes.POSITION = accessors.length - 1
    if (o.normals && o.normals.length === o.positions.length) {
      const normals = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const [x, y, z] = [o.normals[3 * i], o.normals[3 * i + 2], -o.normals[3 * i + 1]]
        const l = Math.hypot(x, y, z) || 1
        normals.set([x / l, y / l, z / l], 3 * i)
      }
      accessors.push({ bufferView: add(normals, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' })
      attributes.NORMAL = accessors.length - 1
    }
    accessors.push({ bufferView: add(new Uint32Array(o.indices), ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: o.indices.length, type: 'SCALAR' })
    meshes.push({ name: o.name, primitives: [{ attributes, indices: accessors.length - 1, material: materialFor(o.material) }] })
    nodes.push({ name: o.name, mesh: meshes.length - 1 })
  }

  const json = {
    asset: { version: '2.0', generator: 'ArchiOpen' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  }
  // Chunks are padded to 4 bytes: the JSON with spaces, the binary with zeros.
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const binLength = Math.ceil(byteLength / 4) * 4
  const total = 12 + 8 + jsonLength + 8 + binLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // glTF
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // JSON
  out.fill(0x20, 20, 20 + jsonLength)
  out.set(jsonBytes, 20)
  const bin = 20 + jsonLength
  view.setUint32(bin, binLength, true)
  view.setUint32(bin + 4, 0x004e4942, true) // BIN
  let at = bin + 8
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}
