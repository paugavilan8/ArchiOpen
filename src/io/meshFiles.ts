import { Vector3 } from 'three'
import type { MeshGeometry, PolylineGeometry } from '../core/geometry'
import { makeMesh, meshTriangles, weldMesh } from '../core/mesh'

/**
 * STL and OBJ, the usual formats for 3D printing, rendering and scanning. Neither stores units:
 * numbers are read and written in the model's units.
 */

// --- STL -----------------------------------------------------------------------------------

/** Reads binary or ASCII STL. Corners shared by several triangles are welded into one vertex. */
export function readStl(bytes: Uint8Array): MeshGeometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Binary files can also start with "solid", so the size is what tells them apart.
  const binary = bytes.length >= 84 && 84 + 50 * view.getUint32(80, true) === bytes.length
  const vertices: number[] = []
  if (binary) {
    const count = view.getUint32(80, true)
    for (let i = 0; i < count; i++) {
      const at = 84 + 50 * i + 12 // Skip the facet normal.
      for (let k = 0; k < 9; k++) vertices.push(view.getFloat32(at + 4 * k, true))
    }
  } else {
    const text = new TextDecoder().decode(bytes)
    if (!/^\s*solid/i.test(text)) throw new Error('This is not an STL file')
    const number = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`
    const vertex = new RegExp(String.raw`vertex\s+${number}\s+${number}\s+${number}`, 'gi')
    for (const m of text.matchAll(vertex)) vertices.push(+m[1], +m[2], +m[3])
    vertices.length -= vertices.length % 9
  }
  if (vertices.length === 0) throw new Error('The STL file has no triangles')
  const triangles = Array.from({ length: vertices.length / 9 }, (_, i) => [3 * i, 3 * i + 1, 3 * i + 2])
  // Corners that should be one can differ in the last digits of their (single precision) numbers.
  let size = 0
  for (const x of vertices) size = Math.max(size, Math.abs(x))
  return weldMesh(makeMesh(vertices, triangles), size * 1e-7)
}

/** Binary STL with every face as triangles. */
export function writeStl(meshes: MeshGeometry[], name = 'ArchiOpen'): Uint8Array {
  const triangles = meshes.map(meshTriangles)
  const count = triangles.reduce((n, t) => n + t.length / 3, 0)
  const bytes = new Uint8Array(84 + 50 * count)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(name.slice(0, 80)))
  view.setUint32(80, count, true)
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  let at = 84
  meshes.forEach((g, m) => {
    const t = triangles[m]
    for (let i = 0; i < t.length; i += 3) {
      a.fromArray(g.vertices, 3 * t[i])
      b.fromArray(g.vertices, 3 * t[i + 1])
      c.fromArray(g.vertices, 3 * t[i + 2])
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
      for (const v of [n, a, b, c]) {
        view.setFloat32(at, v.x, true)
        view.setFloat32(at + 4, v.y, true)
        view.setFloat32(at + 8, v.z, true)
        at += 12
      }
      at += 2 // Attribute byte count, unused.
    }
  })
  return bytes
}

// --- OBJ -----------------------------------------------------------------------------------

export interface ObjContent {
  /** One mesh per object or group in the file. */
  meshes: { name: string; mesh: MeshGeometry }[]
  /** Polylines from `l` statements. */
  lines: PolylineGeometry[]
}

/** Reads the geometry of an OBJ file: vertices, faces (any size) and lines. Materials and textures are ignored. */
export function readObj(text: string): ObjContent {
  const all: number[] = []
  const meshes: ObjContent['meshes'] = []
  const lines: PolylineGeometry[] = []
  let name = 'Mesh'
  let faces: number[][] = []
  // Indices count from 1; negative ones count back from the last vertex read.
  const index = (token: string) => {
    const i = parseInt(token.split('/')[0], 10)
    return i < 0 ? all.length / 3 + i : i - 1
  }
  const finish = () => {
    if (faces.length === 0) return
    // Each mesh keeps only the vertices its faces use.
    const used = new Map<number, number>()
    const vertices: number[] = []
    const local = faces.map((f) =>
      f.map((i) => {
        let j = used.get(i)
        if (j === undefined) {
          used.set(i, (j = vertices.length / 3))
          vertices.push(all[3 * i], all[3 * i + 1], all[3 * i + 2])
        }
        return j
      }),
    )
    meshes.push({ name, mesh: makeMesh(vertices, local) })
    faces = []
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [keyword, ...rest] = line.split(/\s+/)
    switch (keyword) {
      case 'v':
        all.push(+rest[0], +rest[1], +rest[2])
        break
      case 'f': {
        const f = rest.map(index)
        if (f.length >= 3 && f.every((i) => i >= 0 && i < all.length / 3)) faces.push(f)
        break
      }
      case 'l': {
        const ids = rest.map(index).filter((i) => i >= 0 && i < all.length / 3)
        if (ids.length >= 2) lines.push({ type: 'polyline', points: ids.map((i) => new Vector3(all[3 * i], all[3 * i + 1], all[3 * i + 2])), closed: false })
        break
      }
      case 'o':
      case 'g':
        finish()
        name = rest.join(' ') || 'Mesh'
        break
    }
  }
  finish()
  if (meshes.length === 0 && lines.length === 0) throw new Error('The OBJ file has no faces or lines')
  return { meshes, lines }
}

/** Writes meshes as OBJ objects, quads kept as quads. */
export function writeObj(objects: { name: string; mesh: MeshGeometry }[]): Uint8Array {
  const out: string[] = ['# Written by ArchiOpen']
  const num = (x: number) => String(+x.toPrecision(10))
  let offset = 1
  for (const { name, mesh } of objects) {
    out.push(`o ${name.replace(/\s+/g, '_') || 'Mesh'}`)
    for (let i = 0; i < mesh.vertices.length; i += 3) out.push(`v ${num(mesh.vertices[i])} ${num(mesh.vertices[i + 1])} ${num(mesh.vertices[i + 2])}`)
    const f = mesh.faces
    for (let i = 0; i < f.length; i += 4) {
      const corners = f[i + 2] === f[i + 3] ? [f[i], f[i + 1], f[i + 2]] : [f[i], f[i + 1], f[i + 2], f[i + 3]]
      out.push(`f ${corners.map((c) => c + offset).join(' ')}`)
    }
    offset += mesh.vertices.length / 3
  }
  return new TextEncoder().encode(out.join('\n') + '\n')
}
