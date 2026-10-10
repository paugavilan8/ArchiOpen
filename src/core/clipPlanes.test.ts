import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { clipCurve, clipMesh, clipPolyline, type ClipPlane } from './clipPlanes'
import { length } from './curves'
import type { CircleGeometry, MeshGeometry } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
/** Keeps x ≤ 2. */
const left: ClipPlane = { normal: v(-1, 0), constant: 2, origin: v(2, 0) }
/** Keeps y ≥ 0. */
const up: ClipPlane = { normal: v(0, 1), constant: 0, origin: v(0, 0) }

describe('clipping for drawings', () => {
  it('cuts polylines where they cross, keeping the pieces on the kept side', () => {
    const pieces = clipPolyline([v(0, 0), v(4, 0), v(4, 1), v(0, 1)], [left])
    expect(pieces.map((p) => p.map((q) => q.toArray().slice(0, 2)))).toEqual([
      [[0, 0], [2, 0]],
      [[2, 1], [0, 1]],
    ])
    expect(clipPolyline([v(3, 0), v(5, 0)], [left])).toEqual([])
  })

  it('cuts curves exactly, as curves of their own kind', () => {
    const circle: CircleGeometry = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 1 }
    const pieces = clipCurve(circle, [up])
    expect(pieces).toHaveLength(1)
    expect(pieces[0].type).toBe('arc')
    expect(length(pieces[0])).toBeCloseTo(Math.PI, 9)
    // With two planes: the quarter between them.
    const quarter = clipCurve(circle, [up, { normal: v(1, 0), constant: 0, origin: v(0, 0) }])
    expect(quarter.reduce((s, c) => s + length(c), 0)).toBeCloseTo(Math.PI / 2, 9)
  })

  it('cuts mesh faces along the plane', () => {
    // A 4 × 1 strip of one quad.
    const strip: MeshGeometry = { type: 'mesh', vertices: [0, 0, 0, 4, 0, 0, 4, 1, 0, 0, 1, 0], faces: [0, 1, 2, 3] }
    const cut = clipMesh(strip, [left])!
    const xs = cut.vertices.filter((_, i) => i % 3 === 0)
    expect(Math.max(...xs)).toBeCloseTo(2)
    expect(cut.faces).toHaveLength(4)
    expect(clipMesh(strip, [{ normal: v(-1, 0), constant: -10, origin: v(-10, 0) }])).toBeNull()
  })
})
