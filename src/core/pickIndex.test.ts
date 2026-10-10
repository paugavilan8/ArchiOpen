import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Geometry } from './geometry'
import { wireframe } from './geometry'
import { PickIndex, type Projector } from './pickIndex'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/** A seeded random number in [0, 1). */
function random(seed: number) {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

/** Looking down: screen x = world x, screen y = -world y, everything in depth range. */
const topView: Projector = (p, out) => {
  out.x = p.x
  out.y = -p.y
  return true
}

/** Lots of polylines, circles and loose segments (like a mesh's edges), at random. */
function model(count: number, seed = 1): { id: number; geometry: Geometry }[] {
  const r = random(seed)
  const out: { id: number; geometry: Geometry }[] = []
  for (let id = 1; id <= count; id++) {
    const x = r() * 1000
    const y = r() * 1000
    const kind = id % 3
    const geometry: Geometry =
      kind === 0
        ? { type: 'polyline', points: Array.from({ length: 2 + Math.floor(r() * 60) }, (_, i) => v(x + i * r() * 5, y + r() * 20)), closed: false }
        : kind === 1
          ? { type: 'circle', center: v(x, y), xaxis: v(1, 0), yaxis: v(0, 1), radius: 1 + r() * 30 }
          : { type: 'point', point: v(x, y) }
    out.push({ id, geometry })
  }
  return out
}

describe('pick index', () => {
  it('finds every line and snap point near a screen position, as checking them all would', () => {
    const objects = model(600)
    const index = new PickIndex(objects)
    const r = random(9)
    for (let q = 0; q < 200; q++) {
      const [x, y, size] = [r() * 1000, -r() * 1000, 2 + r() * 40]
      const rect = { minX: x - size, maxX: x + size, minY: y - size, maxY: y + size }
      const seen = new Set<string>()
      index.query(topView, rect, (id, item, inside) => {
        for (const range of item.ranges) {
          for (let k = range.from; k <= range.to; k++) {
            const p = range.points[k]
            const inRect = p.x >= rect.minX && p.x <= rect.maxX && -p.y >= rect.minY && -p.y <= rect.maxY
            // "Inside" is only said of items that are.
            if (inside) expect(inRect).toBe(true)
            if (inRect) seen.add(`${id}:${item.kind}:${p.x},${p.y}`)
          }
        }
      })
      // Every drawn point in the rectangle was offered.
      for (const { id, geometry } of objects) {
        for (const line of wireframe(geometry)) {
          for (const p of line) {
            if (p.x >= rect.minX && p.x <= rect.maxX && -p.y >= rect.minY && -p.y <= rect.maxY) expect(seen.has(`${id}:line:${p.x},${p.y}`)).toBe(true)
          }
        }
      }
    }
  })

  it('hands over whole objects that a window holds', () => {
    const objects = model(300, 3)
    const index = new PickIndex(objects)
    const rect = { minX: 200, maxX: 700, minY: -800, maxY: -300 }
    const whole = new Set<number>()
    index.query(
      topView,
      rect,
      () => {},
      (id) => whole.add(id),
    )
    for (const { id, geometry } of objects) {
      const all = wireframe(geometry).flat()
      const held = all.every((p) => p.x >= rect.minX && p.x <= rect.maxX && -p.y >= rect.minY && -p.y <= rect.maxY)
      // Whole objects are held; held objects not given whole get their items one by one instead.
      if (whole.has(id)) expect(held).toBe(true)
    }
    expect(whole.size).toBeGreaterThan(10)
  })

  it('keeps each geometry’s tree, so a changed model indexes again quickly', () => {
    const objects = model(3000, 5)
    let t0 = performance.now()
    new PickIndex(objects)
    const first = performance.now() - t0
    t0 = performance.now()
    new PickIndex([...objects, { id: 99999, geometry: { type: 'point', point: v(1, 1) } }])
    const again = performance.now() - t0
    expect(again).toBeLessThan(first)
  })

  it('settles ties by the order of the model, then of the object', () => {
    const square = { type: 'polyline', points: [v(0, 0), v(10, 0), v(10, 10), v(0, 10)], closed: true } as Geometry
    const index = new PickIndex([
      { id: 7, geometry: square },
      { id: 3, geometry: { ...square } },
    ])
    const items: { id: number; seq: number; item: Parameters<PickIndex['before']>[1] }[] = []
    index.query(topView, { minX: -1, maxX: 11, minY: -11, maxY: 1 }, (id, item) => items.push({ id, seq: item.seq, item }))
    const a = items.find((i) => i.id === 7 && i.item.kind === 'line')!
    const b = items.find((i) => i.id === 3 && i.item.kind === 'line')!
    // 7 was added first, though its id is higher.
    expect(index.before(7, a.item, 3, b.item)).toBe(true)
    expect(index.before(3, b.item, 7, a.item)).toBe(false)
  })
})
