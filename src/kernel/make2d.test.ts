import { Box3, Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { length } from '../core/curves'
import { AnyCurve, tessellate } from '../core/geometry'
import type { ClipPlane } from '../core/clipPlanes'
import { box, cylinder, sphere } from './brep'
import { make2D, make2DWithMeshes } from './make2d'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const total = (curves: AnyCurve[]) => curves.reduce((sum, c) => sum + length(c), 0)
const bounds = (curves: AnyCurve[]) => new Box3().setFromPoints(curves.flatMap((c) => tessellate(c)))
const front = { direction: v(0, -1, 0), xaxis: v(1, 0, 0) }

describe('Make2D', () => {
  it('draws a unit cube seen from a corner with nine visible and three hidden edges', () => {
    const cube = box(v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1))
    const { visible, hidden } = make2D([cube], [], { direction: v(1, -1, 1), xaxis: v(1, 1, 0) }, true)
    const edge = Math.sqrt(2 / 3)
    expect(total(visible)).toBeCloseTo(9 * edge, 6)
    expect(total(hidden)).toBeCloseTo(3 * edge, 6)
    // The drawing lies flat in the XY plane.
    const b = bounds([...visible, ...hidden])
    expect(b.min.z).toBeCloseTo(0, 9)
    expect(b.max.z).toBeCloseTo(0, 9)
  })

  it('maps the front view to X right and Z up', () => {
    const block = box(v(2, 0), v(4, 0), v(0, 4), v(0, 0, 3))
    const { visible } = make2D([block], [], front, false)
    const b = bounds(visible)
    expect(b.min.x).toBeCloseTo(2, 6)
    expect(b.max.x).toBeCloseTo(6, 6)
    expect(b.min.y).toBeCloseTo(0, 6)
    expect(b.max.y).toBeCloseTo(3, 6)
    expect(total(visible)).toBeCloseTo(14, 6)
  })

  it('hides objects behind others, curves included', () => {
    const wall = box(v(0, 0), v(4, 0), v(0, 1), v(0, 0, 3))
    const behind = box(v(1, 4), v(2, 0), v(0, 2), v(0, 0, 1))
    const line: AnyCurve = { type: 'polyline', points: [v(-2, 6, 2), v(6, 6, 2)], closed: false }
    const { visible, hidden } = make2D([wall, behind], [line], front, true)
    // Only the wall and the ends of the line beyond it show.
    expect(total(visible)).toBeCloseTo(14 + 4, 6)
    // Hidden: the middle of the line and the small box, except its bottom edge, which falls on the
    // wall's (and the back edges that fall behind front edges are left out too).
    expect(total(hidden)).toBeCloseTo(4 + 6 - 2, 6)
  })

  it('draws the silhouette of a curved surface', () => {
    const { visible } = make2D([sphere(v(0, 0), 2)], [], front, false)
    expect(total(visible)).toBeCloseTo(Math.PI * 4, 3)
  })
})

describe('Make2D with clipping planes', () => {
  // A 10 × 10 × 10 box and a cylinder beside it, cut at height 4 keeping what is below (a plan).
  const below: ClipPlane = { normal: v(0, 0, -1), constant: 4, origin: v(0, 0, 4) }
  const top = { direction: v(0, 0, 1), xaxis: v(1, 0, 0) }
  const shapes = () => [box(v(0, 0), v(10, 0), v(0, 10), v(0, 0, 10)), cylinder(v(20, 5), 2, 10, v(0, 0, 1))]

  it('draws a plan: the cut outlines as section lines, nothing above the cut', () => {
    const drawing = make2DWithMeshes(shapes(), [], [], [], top, false, [below])
    // The square and the circle where the plane cuts.
    expect(total(drawing.section!)).toBeCloseTo(40 + 2 * Math.PI * 2, 4)
    // Seen from above, the cut hides everything below it.
    expect(total(drawing.visible)).toBeCloseTo(0, 6)
  })

  it('draws a cut elevation: the solids up to the cut, and the cut edge as a section line', () => {
    const drawing = make2DWithMeshes(shapes(), [], [], [], front, false, [below])
    const all = [...drawing.visible, ...drawing.section!]
    expect(bounds(all).max.y).toBeCloseTo(4, 6)
    expect(bounds(all).min.y).toBeCloseTo(0, 6)
    // Along the cut: the box's top edge (10) and the cylinder's (4) — seen edge on.
    expect(total(drawing.section!)).toBeCloseTo(14, 4)
  })

  it('leaves out a solid wholly cut away, and trims curves', () => {
    const high = box(v(0, 0, 6), v(1, 0), v(0, 1), v(0, 0, 1))
    const post: AnyCurve = { type: 'polyline', points: [v(30, 0, 0), v(30, 0, 10)], closed: false }
    const drawing = make2DWithMeshes([high], [], [post], [], front, false, [below])
    expect(drawing.section ?? []).toHaveLength(0)
    expect(total(drawing.visible)).toBeCloseTo(4, 6)
  })

  it('is the plain drawing without planes', () => {
    const drawing = make2DWithMeshes(shapes(), [], [], [], top, false)
    expect(drawing.section).toBeUndefined()
    expect(total(drawing.visible)).toBeCloseTo(40 + 2 * Math.PI * 2, 4)
  })
})
