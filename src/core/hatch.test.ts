import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { transform } from './curves'
import { AnyCurve, geometryFromJSON, geometryToJSON, HatchGeometry } from './geometry'
import { hatchLines, hatchTriangles } from './hatch'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const square = (x0: number, y0: number, size: number): AnyCurve => ({
  type: 'polyline',
  points: [v(x0, y0), v(x0 + size, y0), v(x0 + size, y0 + size), v(x0, y0 + size)],
  closed: true,
})
const hatch = (loops: AnyCurve[], pattern: string, scale = 1, rotation = 0): HatchGeometry => ({
  type: 'hatch',
  loops,
  pattern,
  scale,
  rotation,
  origin: v(0, 0),
  xaxis: v(1, 0),
  yaxis: v(0, 1),
})

const total = (lines: Vector3[][]) => lines.reduce((sum, [a, b]) => sum + a.distanceTo(b), 0)
/** Area of flat triangles in the XY plane. */
function area(flat: number[]): number {
  let sum = 0
  for (let i = 0; i < flat.length; i += 9) {
    const [ax, ay, , bx, by, , cx, cy] = flat.slice(i, i + 9)
    sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  return sum
}

describe('hatches', () => {
  it('fills a region with a hole', () => {
    const g = hatch([square(0, 0, 10), square(3, 3, 4)], 'Solid')
    expect(area(hatchTriangles(g))).toBeCloseTo(100 - 16, 6)
    expect(hatchLines(g)).toHaveLength(0)
  })

  it('clips grid lines to the region and leaves the hole empty', () => {
    // Lines every 1 in x and y across a 10 × 10 square with a 4 × 4 hole, off the pattern's grid.
    const g = hatch([square(0.5, 0.5, 10), square(3.5, 3.5, 4)], 'Grid')
    const lines = hatchLines(g)
    // 10 lines each way (1 to 10), 10 long, minus 4 for the 4 lines that cross the hole.
    expect(total(lines)).toBeCloseTo(2 * (10 * 10 - 4 * 4), 6)
    for (const [a, b] of lines) {
      const mid = a.clone().lerp(b, 0.5)
      expect(mid.x > 3.5 && mid.x < 7.5 && mid.y > 3.5 && mid.y < 7.5).toBe(false)
    }
  })

  it('scales and turns the pattern', () => {
    const g = hatch([square(0.5, 0.5, 9)], 'Lines', 2, Math.PI / 4)
    // Lines at 45° + 45° = 90°, every 2: x = 2, 4, 6, 8.
    const lines = hatchLines(g)
    expect(lines).toHaveLength(4)
    expect(total(lines)).toBeCloseTo(36, 6)
    for (const [a, b] of lines) expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9)
  })

  it('draws dashed patterns', () => {
    const bricks = hatchLines(hatch([square(0.5, 0.5, 10)], 'Brick'))
    // Rows every 1 (10 lines of 10) and, at each x = 1..10, joints of 1 in every other row.
    expect(total(bricks)).toBeCloseTo(100 + 10 * 5, 6)
  })

  it('refuses patterns too dense to draw', () => {
    expect(() => hatchLines(hatch([square(0, 0, 1000)], 'Lines', 0.001))).toThrow(/too dense/)
  })

  it('moves with transforms and round-trips through JSON', () => {
    const g = hatch([square(0, 0, 10)], 'Grid')
    const scaled = transform(g, new Matrix4().makeScale(2, 2, 2))
    expect(scaled.scale).toBeCloseTo(2, 9)
    expect(total(hatchLines(scaled))).toBeCloseTo(4 * total(hatchLines(g)) / 2, 6)
    expect(geometryFromJSON(JSON.parse(JSON.stringify(geometryToJSON(g))))).toEqual(g)
  })
})
