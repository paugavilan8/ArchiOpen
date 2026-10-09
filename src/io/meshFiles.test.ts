import { Vector3 } from 'three'
import type { RhinoModule } from 'rhino3dm'
import rhino3dm from 'rhino3dm/rhino3dm.module.js'
import { describe, expect, it } from 'vitest'
import type { MeshGeometry } from '../core/geometry'
import { faceCount, isClosedMesh, meshBox, meshSphere, meshVolume, unweldMesh, vertexCount } from '../core/mesh'
import { writeDxf } from './dxf'
import { readDxf } from './dxfRead'
import { readObj, readStl, writeObj, writeStl } from './meshFiles'
import { readRhinoFile, writeRhinoFile } from './rhino3dm'

const box = () => meshBox(new Vector3(1, 2, 3), new Vector3(2, 0, 0), new Vector3(0, 3, 0), new Vector3(0, 0, 4), 2, 2, 2)
const layers = [{ id: 1, name: 'Malla', color: '#336699', visible: true, locked: false }]

describe('STL', () => {
  it('writes binary STL and reads it back welded and closed', () => {
    const b = box()
    const bytes = writeStl([b, meshSphere(new Vector3(10, 0, 0), 1)])
    // Quads go as two triangles each.
    expect(bytes.length).toBe(84 + 50 * (faceCount(b) * 2 + 32 * 14 * 2 + 32 * 2))
    const back = readStl(bytes)
    expect(isClosedMesh(back)).toBe(true)
    expect(vertexCount(back)).toBe(vertexCount(b) + 32 * 15 + 2)
    expect(meshVolume(back)).toBeGreaterThan(24)
  })

  it('reads ASCII STL', () => {
    const text = `solid tri
      facet normal 0 0 1
        outer loop
          vertex 0 0 0
          vertex 1 0 0
          vertex 0 1.5e0 0
        endloop
      endfacet
      facet normal 0 0 1
        outer loop
          vertex 1 0 0
          vertex 1 1 0
          vertex 0 1.5 0
        endloop
      endfacet
    endsolid tri`
    const m = readStl(new TextEncoder().encode(text))
    expect(faceCount(m)).toBe(2)
    expect(vertexCount(m)).toBe(4)
  })

  it('refuses files that are not STL', () => {
    expect(() => readStl(new TextEncoder().encode('hello'))).toThrow()
  })
})

describe('OBJ', () => {
  it('round-trips meshes with quads, one object each', () => {
    const b = box()
    const s = meshSphere(new Vector3(), 1, undefined, undefined, 8, 4)
    const back = readObj(new TextDecoder().decode(writeObj([{ name: 'Caja uno', mesh: b }, { name: 'Bola', mesh: s }])))
    expect(back.meshes.map((m) => m.name)).toEqual(['Caja_uno', 'Bola'])
    expect(back.meshes[0].mesh).toEqual(b)
    // The sphere's vertices are renumbered in the order its faces use them; the shape is the same.
    expect(faceCount(back.meshes[1].mesh)).toBe(faceCount(s))
    expect(meshVolume(back.meshes[1].mesh)).toBeCloseTo(meshVolume(s), 9)
  })

  it('reads texture and normal indices, negative indices, polygons and lines', () => {
    const text = [
      'mtllib a.mtl',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'v 0.5 1.5 0',
      'vt 0 0',
      'vn 0 0 1',
      'g floor',
      'usemtl red',
      'f 1/1/1 2/1/1 3/1/1 4/1/1',
      'f -2//1 -3//1 -1//1',
      'o pentagon',
      'f 1 2 3 5 4',
      'l 1 2 3',
    ].join('\n')
    const { meshes, lines } = readObj(text)
    expect(meshes.map((m) => m.name)).toEqual(['floor', 'pentagon'])
    expect(faceCount(meshes[0].mesh)).toBe(2)
    expect(meshes[0].mesh.faces.slice(4)).toEqual([3, 2, 4, 4])
    // A five-sided face becomes a fan of three triangles.
    expect(faceCount(meshes[1].mesh)).toBe(3)
    expect(lines).toHaveLength(1)
    expect(lines[0].points[2].toArray()).toEqual([1, 1, 0])
  })
})

describe('meshes in other formats', () => {
  it('go to DXF as 3D faces and come back as one mesh per layer', () => {
    const b = box()
    const text = writeDxf({ units: 'Millimeters', layers, objects: [{ layerId: 1, geometry: unweldMesh(b) }], linetypeScale: 1, millimetersPerUnit: 1 })
    expect(text.split('\n').filter((l) => l.trim() === '3DFACE')).toHaveLength(faceCount(b))
    const back = readDxf(new TextEncoder().encode(text), 'Millimeters')
    expect(back.objects).toHaveLength(1)
    const m = back.objects[0].geometry as MeshGeometry
    expect(m.type).toBe('mesh')
    expect(isClosedMesh(m)).toBe(true)
    expect(meshVolume(m)).toBeCloseTo(24, 6)
  })

  it('go to .3dm as Rhino meshes and are read back', async () => {
    const rhino = (await rhino3dm()) as RhinoModule
    const b = box()
    const bytes = writeRhinoFile(rhino, { units: 'Millimeters', layers, objects: [{ layerId: 1, geometry: b }] })
    const back = readRhinoFile(rhino, bytes)
    expect(back.skipped.size).toBe(0)
    const m = back.objects[0].geometry as MeshGeometry
    expect(m.faces).toEqual(b.faces)
    expect(m.vertices.map((x) => Math.round(x * 1e5) / 1e5)).toEqual(b.vertices)
  })
})
