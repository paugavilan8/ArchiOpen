import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import { clippingCorners, clippingNormal, geometryFromJSON, geometryToJSON, snapPoints, wireframe, type ClippingGeometry } from './geometry'
import { transform } from './curves'
import { clippingFromCorners, flipClipping } from '../commands/clipping'
import { clippingPlane, isClipped } from '../view/clipping'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const top = { xaxis: v(1, 0), yaxis: v(0, 1) }

/** A clipping plane drawn in the Top view at height 1500, as the ClippingPlane command makes it. */
const plan = () => clippingFromCorners(v(0, 0, 1500), v(4000, 3000, 1500), top)!

describe('clipping planes', () => {
  it('are drawn in the view facing away from the viewer, so they keep what is behind', () => {
    const g = plan()
    expect(g.width).toBe(4000)
    expect(g.height).toBe(3000)
    expect(g.center.toArray()).toEqual([2000, 1500, 1500])
    // Drawn in Top: the arrow points down, and what is below stays.
    expect(clippingNormal(g).toArray()).toEqual([0, 0, -1])
    const plane = clippingPlane(g)
    expect(isClipped([plane], v(10, 10, 2000))).toBe(true)
    expect(isClipped([plane], v(10, 10, 1000))).toBe(false)
    // What lies on the plane, the rectangle itself included, stays.
    for (const corner of clippingCorners(g)) expect(isClipped([plane], corner)).toBe(false)
  })

  it('cut without limit, beyond their rectangle', () => {
    expect(isClipped([clippingPlane(plan())], v(1e5, -1e5, 1600))).toBe(true)
  })

  it('need a width and a height', () => {
    expect(clippingFromCorners(v(0, 0), v(10, 0), top)).toBeNull()
  })

  it('keep the other side when flipped, in the same place', () => {
    const g = flipClipping(plan())
    expect(clippingNormal(g).toArray()).toEqual([0, 0, 1])
    expect(clippingCorners(g).map((c) => c.toArray()).sort()).toEqual(clippingCorners(plan()).map((c) => c.toArray()).sort())
    expect(isClipped([clippingPlane(g)], v(10, 10, 1000))).toBe(true)
  })

  it('cut where both keep, together', () => {
    const below = clippingPlane(plan())
    // A vertical plane keeping x > 1000.
    const side = clippingPlane({ type: 'clipping', center: v(1000, 0), xaxis: v(0, 1), yaxis: v(0, 0, 1), width: 10, height: 10, views: [] })
    expect(isClipped([below, side], v(2000, 0, 1000))).toBe(false)
    expect(isClipped([below, side], v(500, 0, 1000))).toBe(true)
    expect(isClipped([below, side], v(2000, 0, 2000))).toBe(true)
  })

  it('move, turn and scale with their rectangle, and mirror the side they keep', () => {
    const g = plan()
    const moved = transform(g, new Matrix4().makeTranslation(0, 0, 500))
    expect(moved.center.z).toBe(2000)
    const scaled = transform(g, new Matrix4().makeScale(2, 1, 1))
    expect(scaled.width).toBeCloseTo(8000)
    expect(scaled.height).toBeCloseTo(3000)
    // Turned on its side about the X axis: it now keeps the side towards +Y.
    const turned = transform(g, new Matrix4().makeRotationX(Math.PI / 2))
    expect(clippingNormal(turned).y).toBeCloseTo(1)
    // Mirrored through the XY plane: the kept side (below) becomes above.
    const mirrored = transform(g, new Matrix4().makeScale(1, 1, -1))
    expect(clippingNormal(mirrored).z).toBeCloseTo(1)
    expect(mirrored.center.z).toBe(-1500)
  })

  it('are saved and read back, with the views they cut', () => {
    const g: ClippingGeometry = { ...plan(), views: ['Top', 'Perspective'] }
    const json = JSON.parse(JSON.stringify(geometryToJSON(g)))
    const back = geometryFromJSON(json) as ClippingGeometry
    expect(back.type).toBe('clipping')
    expect(back.views).toEqual(['Top', 'Perspective'])
    expect(JSON.parse(JSON.stringify(geometryToJSON(back)))).toEqual(json)
  })

  it('draw their rectangle and an arrow, and snap at their corners and center', () => {
    const g = plan()
    const lines = wireframe(g)
    expect(lines[0]).toHaveLength(5)
    // The arrow leaves the center towards the kept side.
    expect(lines[1][0].toArray()).toEqual(g.center.toArray())
    expect(lines[1][1].z).toBeLessThan(1500)
    expect(snapPoints(g).end).toHaveLength(4)
    expect(snapPoints(g).cen[0].toArray()).toEqual([2000, 1500, 1500])
  })
})
