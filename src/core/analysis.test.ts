import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { boundingBox, curveArea, hatchArea, meshAreaCentroid, meshVolumeCentroid } from './analysis'
import { length } from './curves'
import { ellipse } from './curveTools'
import type { AnyCurve, HatchGeometry } from './geometry'
import { meshBox, meshSphere } from './mesh'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const close = (p: Vector3, q: Vector3, digits = 6) => p.toArray().forEach((x, i) => expect(x).toBeCloseTo(q.getComponent(i), digits))

describe('measuring without the kernel', () => {
  it('measures the area inside closed planar curves', () => {
    const square: AnyCurve = { type: 'polyline', points: [v(1, 1), v(5, 1), v(5, 3), v(1, 3)], closed: true }
    expect(curveArea(square)!.area).toBeCloseTo(8, 12)
    close(curveArea(square)!.centroid, v(3, 2), 12)
    const e = ellipse(v(2, 3, 1), v(0, 1, 0), v(0, 0, 1), 4, 1.5)
    const ea = curveArea(e)!
    expect(ea.area).toBeCloseTo(Math.PI * 6, 6)
    close(ea.centroid, v(2, 3, 1))
    // A rounded slot: two straight sides and two half circles.
    const slot: AnyCurve = {
      type: 'polycurve',
      segments: [
        { type: 'polyline', points: [v(0, -1), v(4, -1)], closed: false },
        { type: 'arc', center: v(4, 0), xaxis: v(0, -1), yaxis: v(1, 0), radius: 1, angle: Math.PI },
        { type: 'polyline', points: [v(4, 1), v(0, 1)], closed: false },
        { type: 'arc', center: v(0, 0), xaxis: v(0, 1), yaxis: v(-1, 0), radius: 1, angle: Math.PI },
      ],
    }
    expect(curveArea(slot)!.area).toBeCloseTo(8 + Math.PI, 6)
    expect(curveArea({ type: 'polyline', points: [v(0, 0), v(1, 0), v(1, 1)], closed: false })).toBeNull()
    // Not flat.
    expect(curveArea({ type: 'polyline', points: [v(0, 0), v(1, 0), v(1, 1, 1), v(0, 1)], closed: true })).toBeNull()
  })

  it('measures curve length closely', () => {
    const [a, b] = [4, 1.5]
    // The complete elliptic integral 4a·E(1 − b²/a²), worked out to 12 digits.
    const perimeter = 18.1834313916
    expect(Math.abs(length(ellipse(v(0, 0), v(1, 0), v(0, 1), a, b)) / perimeter - 1)).toBeLessThan(1e-9)
  })

  it('measures hatches, holes left out', () => {
    const outer: AnyCurve = { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10), v(0, 10)], closed: true }
    const hole: AnyCurve = { type: 'polyline', points: [v(2, 2), v(4, 2), v(4, 4), v(2, 4)], closed: true }
    const h: HatchGeometry = { type: 'hatch', loops: [outer, hole], pattern: 'Solid', scale: 1, rotation: 0, origin: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1) }
    expect(hatchArea(h).area).toBeCloseTo(96, 9)
  })

  it('measures meshes and their centroids', () => {
    const b = meshBox(v(1, 2, 3), v(2, 0, 0), v(0, 3, 0), v(0, 0, 4), 2, 3, 4)
    expect(meshAreaCentroid(b).area).toBeCloseTo(52, 9)
    const vol = meshVolumeCentroid(b)
    expect(vol.volume).toBeCloseTo(24, 9)
    close(vol.centroid, v(2, 3.5, 5), 9)
    close(meshVolumeCentroid(meshSphere(v(5, -1, 2), 3)).centroid, v(5, -1, 2), 9)
  })

  it('finds bounding boxes in world or plane coordinates', () => {
    const b = meshBox(v(0, 0, 0), v(2, 0, 0), v(0, 3, 0), v(0, 0, 4))
    const box = boundingBox([b])
    expect(box.min.toArray()).toEqual([0, 0, 0])
    expect(box.max.toArray()).toEqual([2, 3, 4])
    // A plane turned a quarter turn: its x runs along world y.
    const local = boundingBox([b], { origin: v(0, 0, 0), xaxis: v(0, 1, 0), yaxis: v(-1, 0, 0), normal: v(0, 0, 1) })
    expect(local.max.x - local.min.x).toBeCloseTo(3, 12)
    expect(local.max.y - local.min.y).toBeCloseTo(2, 12)
  })
})

describe('curvature combs', () => {
  it('stand outside the bend, longest where it is strongest', async () => {
    const { curvatureCombs } = await import('../commands/analysisDisplay')
    const c: AnyCurve = { type: 'circle', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 2 }
    const lines = curvatureCombs([c])
    const hairs = lines.filter((l) => l.length === 2)
    // Every hair points away from the center, all the same length on a circle.
    for (const [p, tip] of hairs) {
      expect(tip.length()).toBeGreaterThan(p.length())
      expect(tip.distanceTo(p)).toBeCloseTo(hairs[0][0].distanceTo(hairs[0][1]), 3)
    }
    // Straight lines have none.
    expect(curvatureCombs([{ type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }])).toEqual([])
    // On an ellipse the hair at the end of the long axis is the longest.
    const e = ellipse(v(0, 0), v(1, 0), v(0, 1), 4, 1)
    const eh = curvatureCombs([e]).filter((l) => l.length === 2)
    const longest = eh.reduce((a, b) => (a[0].distanceTo(a[1]) > b[0].distanceTo(b[1]) ? a : b))
    expect(Math.abs(longest[0].x)).toBeCloseTo(4, 2)
  })
})
