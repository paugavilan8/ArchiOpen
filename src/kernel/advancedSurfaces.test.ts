import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnyCurve } from '../core/geometry'
import { interpolate } from '../math/nurbs'
import { blendSurface, edgeSurface, gridSurface, networkSurface, patch, pipe, surfaceFromPoints, sweep2 } from './advancedSurfaces'
import { toBrep } from './brep'
import { checkShape, shapeArea, shapeBounds, shapeVolume } from './measure'
import { closestOn } from './surfaceEdit'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })
const through = (...pts: Vector3[]): AnyCurve => ({ type: 'curve', ...interpolate(pts, 3) })
const onShape = (shape: R.AnyShape, p: Vector3) => closestOn(shape, p)!.distance

describe('advanced surfaces', () => {
  it('fits a surface through a grid of points', () => {
    const grid = [0, 1, 2, 3].map((i) => [0, 1, 2].map((j) => v(i, j, Math.sin(i) * Math.cos(j))))
    const face = gridSurface(grid)
    for (const row of grid) for (const p of row) expect(onShape(face, p)).toBeLessThan(1e-6)
  })

  it('sweeps a profile along two rails, scaling it to their spacing', () => {
    // Rails spread from 2 apart to 4 apart; a half circle profile stands across them at the start.
    const rail1 = line(v(0, 0), v(0, 10))
    const rail2 = line(v(2, 0), v(4, 10))
    const profile: AnyCurve = { type: 'arc', center: v(1, 0), xaxis: v(-1, 0), yaxis: v(0, 0, 1), radius: 1, angle: Math.PI }
    const face = sweep2(rail1, rail2, [profile])
    // It follows both rails and, at the far end, is a half circle of radius 2.
    for (const p of [v(0, 5), v(3, 5), v(2, 10, 2), v(0, 10), v(4, 10)]) expect(onShape(face, p)).toBeLessThan(1e-3)
    const top = shapeBounds(face).max.z
    expect(top).toBeCloseTo(2, 2)
  })

  it('blends two profiles along the rails', () => {
    const rail1 = line(v(0, 0), v(0, 10))
    const rail2 = line(v(4, 0), v(4, 10))
    const low = through(v(0, 0), v(2, 0, 1), v(4, 0))
    const high = through(v(0, 10), v(2, 10, 3), v(4, 10))
    const face = sweep2(rail1, rail2, [low, high])
    expect(onShape(face, v(2, 0, 1))).toBeLessThan(1e-3)
    expect(onShape(face, v(2, 10, 3))).toBeLessThan(1e-3)
    // Halfway, halfway up.
    expect(onShape(face, v(2, 5, 2))).toBeLessThan(0.02)
  })

  it('patches a closed boundary through an inner curve', () => {
    const square = [line(v(0, 0), v(4, 0)), line(v(4, 0), v(4, 4)), line(v(4, 4), v(0, 4)), line(v(0, 4), v(0, 0))]
    const flat = patch(square)
    expect(shapeArea(flat).value).toBeCloseTo(16, 2)
    const dome = patch([...square, through(v(1, 2, 0.5), v(2, 2, 1), v(3, 2, 0.5))])
    expect(onShape(dome, v(2, 2, 1))).toBeLessThan(1e-2)
    expect(() => patch([line(v(0, 0), v(1, 0))])).toThrow()
    // A closed boundary with a curve inside that touches it where it starts.
    const ring: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 4 }
    const hump = patch([ring, through(v(4, 0), v(0, 0, 2), v(-4, 0))])
    expect(onShape(hump, v(0, 0, 2))).toBeLessThan(1e-2)
  })

  it('makes edge surfaces from two, three or four curves', () => {
    const ruled = edgeSurface([line(v(0, 0), v(4, 0)), line(v(4, 2, 1), v(0, 2, 1))])
    expect(shapeArea(ruled).value).toBeCloseTo(4 * Math.sqrt(5), 4)
    const tri = edgeSurface([line(v(0, 0), v(4, 0)), line(v(4, 0), v(0, 3)), line(v(0, 3), v(0, 0))])
    expect(shapeArea(tri).value).toBeCloseTo(6, 2)
    const saddle = edgeSurface([line(v(0, 0, 0), v(4, 0, 1)), line(v(4, 0, 1), v(4, 4, 0)), line(v(4, 4, 0), v(0, 4, 1)), line(v(0, 4, 1), v(0, 0, 0))])
    expect(checkShape(saddle).nakedEdges).toBe(4)
    expect(() => edgeSurface([line(v(0, 0), v(1, 0)), line(v(5, 5), v(6, 5)), line(v(9, 9), v(9, 8))])).toThrow()
  })

  it('builds a network surface from crossing curves', () => {
    // Curves taken from one dome, z = 2·sin(πx/4)·sin(πy/4) over a 4 × 4 square, so they really cross.
    const z = (x: number, y: number) => 2 * Math.sin((Math.PI * x) / 4) * Math.sin((Math.PI * y) / 4)
    const steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
    const u = [0, 2, 4].map((y) => through(...steps.map((x) => v(x, y, z(x, y)))))
    const w = [0, 2, 4].map((x) => through(...steps.map((y) => v(x, y, z(x, y)))))
    const face = networkSurface([...w, ...u])
    expect(onShape(face, v(2, 2, 2))).toBeLessThan(0.01)
    expect(onShape(face, v(2, 1, z(2, 1)))).toBeLessThan(0.01)
    // Curves of one direction alone do not make a network.
    expect(() => networkSurface(u)).toThrow()
  })

  it('makes surfaces from corner points', () => {
    expect(shapeArea(surfaceFromPoints([v(0, 0), v(2, 0), v(0, 2)])).value).toBeCloseTo(2, 9)
    expect(shapeArea(surfaceFromPoints([v(0, 0), v(2, 0), v(2, 3), v(0, 3)])).value).toBeCloseTo(6, 9)
    const twisted = surfaceFromPoints([v(0, 0, 0), v(2, 0, 1), v(2, 2, 0), v(0, 2, 1)])
    expect(onShape(twisted, v(1, 1, 0.5))).toBeLessThan(1e-6)
  })

  it('makes pipes, capped or open, straight or tapered', () => {
    const rail = line(v(0, 0), v(0, 0, 10))
    const solid = pipe(rail, 1, 1, true)
    expect(toBrep(solid).kind).toBe('solid')
    expect(shapeVolume(solid).value).toBeCloseTo(Math.PI * 10, 3)
    const open = pipe(rail, 1, 1, false)
    expect(checkShape(open).nakedEdges).toBeGreaterThan(0)
    const cone = pipe(rail, 2, 1, true)
    // A frustum: π h (R² + Rr + r²) / 3.
    expect(shapeVolume(cone).value).toBeCloseTo((Math.PI * 10 * (4 + 2 + 1)) / 3, 1)
    const curved = pipe(through(v(0, 0), v(5, 3), v(10, 0)), 0.5, 0.5, true)
    expect(toBrep(curved).kind).toBe('solid')
  })

  it('blends between edges of two surfaces, leaving each along its surface', () => {
    // Two flat strips at different heights, facing each other across a gap.
    const left = R.makePolygon([
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
      [0, 4, 0],
    ])
    const right = R.makePolygon([
      [8, 0, 3],
      [12, 0, 3],
      [12, 4, 3],
      [8, 4, 3],
    ])
    const edgeIndex = (shape: R.AnyShape, x: number) => shape.edges.findIndex((e) => Math.abs(e.pointAt(0.5).x - x) < 1e-9)
    const blend = blendSurface(left, edgeIndex(left, 4), right, edgeIndex(right, 8))
    // It starts and ends on the edges, and leaves the first surface flat (along x).
    expect(onShape(blend, v(4, 2, 0))).toBeLessThan(1e-6)
    expect(onShape(blend, v(8, 2, 3))).toBeLessThan(1e-6)
    // Tangent: just past each edge it has barely left the surface's plane.
    expect(onShape(blend, v(4.05, 2, 0))).toBeLessThan(1.5e-3)
    expect(onShape(blend, v(7.95, 2, 3))).toBeLessThan(1.5e-3)
  })
})
