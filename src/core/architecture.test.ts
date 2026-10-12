import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { checkOpening, lengthAtPoint, levelAt, openingBox, paramAtLength, pathLength, wallOutline, wallParams, wallSides } from './architecture'
import { length } from './curves'
import { Document } from './document'
import { pointAt, tessellate, type AnyCurve } from './geometry'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })
const area = (g: AnyCurve) => {
  const p = tessellate(g)
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return Math.abs(a) / 2
}

describe('wall outlines', () => {
  it('puts a centred wall half each side of its path', () => {
    const [outline] = wallOutline(line(v(0, 0), v(5000, 0)), { thickness: 200, justification: 'center' })
    expect(area(outline)).toBeCloseTo(5000 * 200, 3)
    const ys = tessellate(outline).map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-100, 6)
    expect(Math.max(...ys)).toBeCloseTo(100, 6)
  })

  it('puts a left or right wall all on one side', () => {
    const left = tessellate(wallOutline(line(v(0, 0), v(5000, 0)), { thickness: 200, justification: 'left' })[0]).map((p) => p.y)
    expect(Math.min(...left)).toBeCloseTo(0, 6)
    expect(Math.max(...left)).toBeCloseTo(200, 6)
    const right = tessellate(wallOutline(line(v(0, 0), v(5000, 0)), { thickness: 200, justification: 'right' })[0]).map((p) => p.y)
    expect(Math.min(...right)).toBeCloseTo(-200, 6)
  })

  it('mitres the corners of a bent path', () => {
    const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4000, 0), v(4000, 3000)], closed: false }
    const [outline] = wallOutline(path, { thickness: 200, justification: 'center' })
    expect(area(outline)).toBeCloseTo((4000 + 3000) * 200, 1)
  })

  it('makes a ring around a closed path (a room)', () => {
    const room: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4000, 0), v(4000, 3000), v(0, 3000)], closed: true }
    const [outer, inner] = wallOutline(room, { thickness: 200, justification: 'center' })
    expect(area(outer) - area(inner)).toBeCloseTo(2 * (4000 + 3000) * 200, 1)
    expect(area(outer)).toBeCloseTo(4200 * 3200, 1)
  })

  it('follows curved paths', () => {
    const arc: AnyCurve = { type: 'arc', center: v(0, 0), xaxis: v(1, 0), yaxis: v(0, 1), radius: 3000, angle: Math.PI / 2 }
    const [outline] = wallOutline(arc, { thickness: 200, justification: 'center' })
    expect(area(outline) / ((Math.PI / 4) * (3100 ** 2 - 2900 ** 2))).toBeCloseTo(1, 2)
  })

  it('knows how far each side reaches', () => {
    expect(wallSides({ thickness: 300, justification: 'center' })).toEqual({ left: 150, right: 150 })
  })
})

describe('openings', () => {
  const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(4000, 0), v(4000, 3000)], closed: false }
  const params = wallParams({ thickness: 200, height: 3000 })

  it('goes between distances along a path and points on it', () => {
    expect(pathLength(path)).toBeCloseTo(7000, 9)
    expect(pointAt(path, paramAtLength(path, 5000)).distanceTo(v(4000, 1000))).toBeLessThan(1e-9)
    expect(lengthAtPoint(path, v(4100, 2000, 1500))).toBeCloseTo(6000, 6)
    expect(length(path)).toBeCloseTo(7000, 9)
  })

  it('cuts a box through the wall, centred on its place', () => {
    const box = openingBox(path, params, { kind: 'window', at: 2000, width: 1200, height: 1200, sill: 900 })
    const centre = box.origin.clone().addScaledVector(box.u, 0.5).addScaledVector(box.v, 0.5).addScaledVector(box.w, 0.5)
    expect(centre.distanceTo(v(2000, 0, 1500))).toBeLessThan(1e-9)
    expect(box.u.length()).toBeCloseTo(1200, 9)
    expect(box.v.length()).toBeGreaterThan(200)
    expect(box.w.length()).toBeCloseTo(1200, 9)
  })

  it('checks openings fit', () => {
    expect(checkOpening(path, params, { kind: 'door', at: 300, width: 900, height: 2100, sill: 0 })).toMatch(/along/)
    expect(checkOpening(path, params, { kind: 'window', at: 2000, width: 1200, height: 2500, sill: 900 })).toMatch(/top/)
    expect(checkOpening(path, params, { kind: 'door', at: 2000, width: 900, height: 2100, sill: 0 })).toBeNull()
  })
})

describe('levels', () => {
  it('finds the level a height is on', () => {
    const levels = [
      { name: 'Ground', elevation: 0, height: 3000 },
      { name: 'First', elevation: 3000, height: 3000 },
    ]
    expect(levelAt(levels, 0)?.name).toBe('Ground')
    expect(levelAt(levels, 3000)?.name).toBe('First')
    expect(levelAt(levels, 4500)?.name).toBe('First')
    expect(levelAt(levels, -10)).toBeNull()
  })

  it('keeps the levels with the document', () => {
    const doc = new Document()
    expect(doc.level.name).toBe('Level 0')
    doc.setLevels([...doc.levels, { name: 'Roof', elevation: 6000, height: 1000 }, { name: 'Level 1', elevation: 3000, height: 3000 }], 'Level 1')
    expect(doc.levels.map((l) => l.name)).toEqual(['Level 0', 'Level 1', 'Roof'])
    const copy = new Document()
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(copy.levels).toEqual(doc.levels)
    expect(copy.level.elevation).toBe(3000)
    copy.load({})
    expect(copy.levels).toHaveLength(1)
  })
})
