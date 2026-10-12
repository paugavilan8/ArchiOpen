import { describe, expect, it } from 'vitest'
import { meshVolume, planArea, quantitiesCsv, quantityTable, sumQuantities, type QuantityItem } from './quantities'

/** A box from the origin, as triangles. */
function box(x: number, y: number, z: number) {
  const vertices = [0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]
  return { vertices, triangles: quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]) }
}

const item = (element: string, level: string, material: string, length: number, area: number, volume: number): QuantityItem => ({ element, level, material, length, area, volume })

describe('quantities', () => {
  it('measures closed meshes and plan areas', () => {
    const b = box(2, 3, 4)
    expect(meshVolume(b.vertices, b.triangles)).toBeCloseTo(24, 9)
    expect(planArea([[0, 0], [4, 0], [4, 3], [0, 3]])).toBeCloseTo(12, 9)
  })

  it('sums by element, level and material, in bill order, with totals', () => {
    const rows = sumQuantities(
      [
        item('Wall', 'Level 1', 'Brick', 5, 15, 3),
        item('Window', 'Level 0', '', 0, 1.44, 0),
        item('Wall', 'Level 0', 'Brick', 8, 24, 4.8),
        item('Wall', 'Level 0', 'Brick', 4, 12, 2.4),
        item('Slab', 'Level 1', 'Concrete', 0, 40, 10),
      ],
      ['Level 0', 'Level 1'],
    )
    expect(rows.map((r) => [r.element, r.level, r.count])).toEqual([
      ['Slab', 'Level 1', 1],
      ['Wall', 'Level 0', 2],
      ['Wall', 'Level 1', 1],
      ['Window', 'Level 0', 1],
    ])
    expect(rows[1].length).toBeCloseTo(12, 9)
    const table = quantityTable(rows)
    expect(table.rows).toEqual([
      ['Slab', 'Level 1', 'Concrete', '1', '', '40.00', '10.000'],
      ['Wall', 'Level 0', 'Brick', '2', '12.00', '36.00', '7.200'],
      ['', 'Level 1', 'Brick', '1', '5.00', '15.00', '3.000'],
      ['', 'Total wall', '', '3', '17.00', '51.00', '10.200'],
      ['Window', 'Level 0', '', '1', '', '1.44', ''],
    ])
    const csv = quantitiesCsv(rows).split('\r\n')
    expect(csv[0]).toBe('Element,Level,Material,Count,Length (m),Area (m2),Volume (m3)')
    expect(csv[2]).toBe('Wall,Level 0,Brick,2,12.000,36.000,7.2000')
    expect(quantitiesCsv(sumQuantities([item('Wall', 'L', 'Brick, solid', 1, 1, 1)], []))).toContain('"Brick, solid"')
  })
})
