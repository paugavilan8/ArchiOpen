import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { meshVolume } from './quantities'
import { delaunay, insidePolygon, resample, terrainMesh } from './terrain'

const triangles = (faces: number[]) => {
  const out: number[] = []
  for (let i = 0; i < faces.length; i += 4) {
    const [a, b, c, d] = faces.slice(i, i + 4)
    out.push(a, b, c)
    if (d !== c) out.push(a, c, d)
  }
  return out
}

describe('terrain', () => {
  it('triangulates points in plan: a grid gives two triangles a cell, all counter-clockwise, none overlapping', () => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 3; j++) pts.push([i * 10 + (j % 2) * 0.01, j * 10])
    const tris = delaunay(pts)
    expect(tris).toHaveLength(4 * 3 * 2)
    let area = 0
    for (const [a, b, c] of tris) {
      const cross = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])
      expect(cross).toBeGreaterThan(0)
      area += cross / 2
    }
    // They cover the hull exactly.
    expect(area).toBeCloseTo(40 * 30, 1)
    // Repeated points are left out; fewer than three give nothing.
    expect(delaunay([[0, 0], [0, 0], [1, 0], [0, 1]])).toHaveLength(1)
    expect(delaunay([[0, 0], [1, 1]])).toEqual([])
  })

  it('makes a surface through the points, cut to a boundary, and a closed solid with a base', () => {
    const pts: Vector3[] = []
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) pts.push(new Vector3(i * 1000, j * 1000, 100 * i))
    const surface = terrainMesh(pts)
    expect(surface.faces.length / 4).toBe(200)
    // A plane sloping 0.1 over 10 x 10 m, with a 2 m base under its lowest point: the volume is
    // that of the block under the slope.
    const solid = terrainMesh(pts, { base: 2000 })
    const volume = meshVolume(solid.vertices, triangles(solid.faces))
    expect(volume).toBeCloseTo(10000 * 10000 * 2000 + (10000 * 10000 * 1000) / 2, -3)
    // Cut to a square in the middle: only the triangles inside it.
    const cut = terrainMesh(pts, { boundary: [[2000, 2000], [6000, 2000], [6000, 6000], [2000, 6000]] })
    expect(cut.faces.length / 4).toBe(32)
    expect(() => terrainMesh([new Vector3(0, 0, 0), new Vector3(1, 1, 0), new Vector3(2, 2, 0)])).toThrow()
  })

  it('samples contour lines and tells inside from outside', () => {
    const line = resample([new Vector3(0, 0, 5), new Vector3(10, 0, 5)], 3)
    expect(line).toHaveLength(5)
    expect(line.every((p) => p.z === 5)).toBe(true)
    expect(insidePolygon(1, 1, [[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(true)
    expect(insidePolygon(3, 1, [[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(false)
  })
})
