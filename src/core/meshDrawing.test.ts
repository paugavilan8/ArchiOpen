import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { drawMeshes } from './meshDrawing'
import { meshBox, meshPlane, meshSphere } from './mesh'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const total = (lines: Vector3[][]) => lines.reduce((s, l) => s + l[0].distanceTo(l[l.length - 1]), 0)
const top = { direction: v(0, 0, 1), xaxis: v(1, 0) }

describe('Make2D of meshes', () => {
  it('draws a box from above as its outline, without the grid of its faces', () => {
    const b = meshBox(v(0, 0, 0), v(4, 0, 0), v(0, 3, 0), v(0, 0, 2), 4, 3, 2)
    const { visible, hidden } = drawMeshes([b], top, [], true)
    // Only the top's four edges show; the bottom ones lie right under them, so even as hidden lines
    // they are left out.
    expect(total(visible)).toBeCloseTo(14, 6)
    expect(visible.length).toBe(4)
    expect(hidden).toHaveLength(0)
  })

  it('draws a sphere as its silhouette, a circle', () => {
    const s = meshSphere(v(0, 0, 0), 2, undefined, undefined, 48, 24)
    const front = { direction: v(0, -1, 0), xaxis: v(1, 0) }
    const { visible } = drawMeshes([s], front)
    for (const line of visible) for (const p of line) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(1.95)
    expect(total(visible)).toBeGreaterThan(2 * Math.PI * 2 * 0.98)
  })

  it('hides what is behind other meshes and surfaces', () => {
    const low = meshPlane(v(0, 0, 0), v(10, 0, 0), v(0, 10, 0), 1, 1)
    const cover = meshPlane(v(-1, -1, 5), v(6, 0, 0), v(0, 12, 0), 1, 1)
    const { visible, hidden } = drawMeshes([low, cover], top, [], true)
    // Of the low square's 40 of border, the part under the cover (x from 0 to 5) is hidden.
    expect(total(hidden)).toBeCloseTo(5 + 5 + 10, 6)
    expect(total(visible)).toBeCloseTo(5 + 5 + 10 + (6 + 6 + 12 + 12), 6)
    // Triangles of a surface hide it too.
    const occluder = [-1, -1, 5, 30, -1, 5, -1, 30, 5]
    expect(drawMeshes([low], top, [occluder]).visible).toHaveLength(0)
  })
})
