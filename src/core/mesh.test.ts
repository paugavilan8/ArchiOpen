import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { geometryFromJSON, geometryToJSON, wireframe } from './geometry'
import { transform } from './curves'
import {
  faceCount,
  fillHoles,
  flipMesh,
  isClosedMesh,
  joinMeshes,
  meshArea,
  meshBox,
  meshCylinder,
  meshPieces,
  meshPlane,
  meshSphere,
  meshVolume,
  nakedEdges,
  unifyNormals,
  unweldMesh,
  vertexCount,
  weldMesh,
} from './mesh'

const box = () => meshBox(new Vector3(), new Vector3(2, 0, 0), new Vector3(0, 3, 0), new Vector3(0, 0, 4), 2, 3, 4)

describe('meshes', () => {
  it('builds closed primitives that face outwards', () => {
    const b = box()
    expect(isClosedMesh(b)).toBe(true)
    expect(meshVolume(b)).toBeCloseTo(24)
    expect(meshArea(b)).toBeCloseTo(2 * (6 + 8 + 12))
    expect(faceCount(b)).toBe(2 * (2 * 3 + 2 * 4 + 3 * 4))
    // Each corner once after welding: (n+1)^3 grid points minus the inside.
    expect(vertexCount(b)).toBe(3 * 4 * 5 - 1 * 2 * 3)

    const s = meshSphere(new Vector3(1, 1, 1), 2, undefined, undefined, 64, 32)
    expect(isClosedMesh(s)).toBe(true)
    expect(meshVolume(s)).toBeGreaterThan(0.97 * (4 / 3) * Math.PI * 8)
    expect(meshVolume(s)).toBeLessThan((4 / 3) * Math.PI * 8)

    const c = meshCylinder(new Vector3(), 1, -5, undefined, undefined, 48, 2)
    expect(isClosedMesh(c)).toBe(true)
    expect(meshVolume(c)).toBeGreaterThan(0.99 * Math.PI * 5)

    const p = meshPlane(new Vector3(), new Vector3(4, 0, 0), new Vector3(0, 2, 0), 4, 2)
    expect(isClosedMesh(p)).toBe(false)
    expect(nakedEdges(p)).toHaveLength(2 * (4 + 2))
    expect(meshArea(p)).toBeCloseTo(8)
  })

  it('draws each shared edge once, also when the faces do not share vertices', () => {
    const b = box()
    const edges = wireframe(b).length
    expect(wireframe(unweldMesh(b)).length).toBe(edges)
    // Quads: 2 per row and column of each side, shared along the box edges.
    expect(edges).toBe(faceCount(b) * 2)
  })

  it('welds, unwelds and keeps volume', () => {
    const loose = unweldMesh(box())
    expect(vertexCount(loose)).toBe(faceCount(loose) * 4)
    expect(isClosedMesh(loose)).toBe(true)
    const welded = weldMesh(loose)
    expect(vertexCount(welded)).toBe(vertexCount(box()))
    expect(meshVolume(welded)).toBeCloseTo(24)
  })

  it('flips, mirrors and unifies normals', () => {
    const b = box()
    expect(meshVolume(flipMesh(b))).toBeCloseTo(-24)
    const mirrored = transform(b, new Matrix4().makeScale(-1, 1, 1))
    expect(mirrored.type).toBe('mesh')
    expect(meshVolume(mirrored as typeof b)).toBeCloseTo(24)
    // Flip a few faces (on sides away from the origin, so the volume shows it), and unify brings them back facing outwards.
    const faces = [...b.faces]
    for (const i of [6, 9, 22, 45]) [faces[4 * i + 1], faces[4 * i + 3]] = [faces[4 * i + 3], faces[4 * i + 1]]
    const messy = { ...b, faces }
    expect(meshVolume(messy)).not.toBeCloseTo(24)
    const { mesh, flipped } = unifyNormals(messy)
    expect(flipped).toBe(4)
    expect(meshVolume(mesh)).toBeCloseTo(24)
    // A wholly inside-out mesh is turned outwards.
    expect(meshVolume(unifyNormals(flipMesh(b)).mesh)).toBeCloseTo(24)
  })

  it('joins and splits into pieces', () => {
    const a = box()
    const b = meshSphere(new Vector3(10, 0, 0), 1)
    const joined = joinMeshes([a, b])
    expect(faceCount(joined)).toBe(faceCount(a) + faceCount(b))
    const pieces = meshPieces(joined)
    expect(pieces).toHaveLength(2)
    expect(pieces.map(faceCount).sort((x, y) => x - y)).toEqual([faceCount(a), faceCount(b)].sort((x, y) => x - y))
    // STL-style loose faces still hang together by position.
    expect(meshPieces(unweldMesh(joined))).toHaveLength(2)
  })

  it('fills holes', () => {
    const b = box()
    // Take out two faces of the top and one of the bottom: two holes.
    const faces = b.faces.filter((_, i) => ![0, 6, 7].includes(Math.floor(i / 4)))
    const holed = { ...b, faces }
    expect(isClosedMesh(holed)).toBe(false)
    const { mesh, holes } = fillHoles(holed)
    expect(holes).toBe(2)
    expect(isClosedMesh(mesh)).toBe(true)
    expect(meshVolume(mesh)).toBeCloseTo(24)
    expect(fillHoles(b).holes).toBe(0)
  })

  it('saves and loads', () => {
    const b = box()
    expect(geometryFromJSON(JSON.parse(JSON.stringify(geometryToJSON(b))))).toEqual(b)
  })
})
