import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Level, Opening } from './architecture'
import { areaInside, levelName, openingSchedule, openingTypes, roomSchedule, tableGeometry } from './schedules'

const levels: Level[] = [
  { name: 'Ground', elevation: 0, height: 3000 },
  { name: 'First', elevation: 3000, height: 3000 },
]
const door = (width: number): Opening => ({ kind: 'door', at: 0, width, height: 2100, sill: 0 })
const window = (width: number, sill = 900): Opening => ({ kind: 'window', at: 0, width, height: 1200, sill })

describe('schedules', () => {
  it('groups openings by type, doors first, marked in order, counted by level', () => {
    const types = openingTypes(
      [
        { opening: window(1200), level: 'First' },
        { opening: door(900), level: 'Ground' },
        { opening: window(1200), level: 'Ground' },
        { opening: door(800), level: 'Ground' },
        { opening: window(1200), level: 'Ground' },
        { opening: { ...door(900), frame: false }, level: 'First' },
      ],
      levels,
    )
    expect(types.map((t) => t.mark)).toEqual(['D1', 'D2', 'D3', 'W1'])
    expect(types.map((t) => t.width)).toEqual([800, 900, 900, 1200])
    // The framed door before the bare opening of the same size.
    expect(types[1].frame).toBe(true)
    expect([...types[3].counts]).toEqual([
      ['Ground', 2],
      ['First', 1],
    ])
    const table = openingSchedule(types, 1)
    expect(table.header).toEqual(['Mark', 'Type', 'Width', 'Height', 'Sill', 'Levels', 'Count'])
    expect(table.rows[2]).toEqual(['D3', 'Door (opening)', '900', '2100', '0', 'First', '1'])
    expect(table.rows[3]).toEqual(['W1', 'Window', '1200', '1200', '900', 'Ground (2), First (1)', '3'])
    expect(table.rows[4]).toEqual(['', 'Total', '', '', '', '', '6'])
    // In meters, sizes still read in millimeters.
    expect(openingSchedule(openingTypes([{ opening: { ...door(0.9), height: 2.1 }, level: 'Ground' }], levels), 1000).rows[0].slice(2, 4)).toEqual(['900', '2100'])
  })

  it('lists rooms by level with each level total and the overall total', () => {
    const table = roomSchedule(
      [
        { name: 'Kitchen', level: 'Ground', area: 12e6 },
        { name: 'Bedroom 2', level: 'First', area: 10.5e6 },
        { name: 'Living', level: 'Ground', area: 25.25e6 },
        { name: 'Bedroom 10', level: 'First', area: 9e6 },
      ],
      levels,
      1e-6,
      'm²',
    )
    expect(table.header).toEqual(['Room', 'Level', 'Area (m²)'])
    expect(table.rows).toEqual([
      ['Kitchen', 'Ground', '12.00'],
      ['Living', 'Ground', '25.25'],
      ['', 'Total Ground', '37.25'],
      ['Bedroom 2', 'First', '10.50'],
      ['Bedroom 10', 'First', '9.00'],
      ['', 'Total First', '19.50'],
      ['', 'Total', '56.75'],
    ])
    // One level: just the total.
    expect(roomSchedule([{ name: 'A', level: 'Ground', area: 1e6 }], levels, 1e-6, 'm²').rows).toEqual([
      ['A', 'Ground', '1.00'],
      ['', 'Total', '1.00'],
    ])
  })

  it('measures a room inside its outline, less the holes round columns', () => {
    const square = (x: number, y: number, s: number) => ({ type: 'polyline' as const, points: [new Vector3(x, y), new Vector3(x + s, y), new Vector3(x + s, y + s), new Vector3(x, y + s)], closed: true })
    expect(areaInside([square(0, 0, 4000), square(1000, 1000, 300)])).toBeCloseTo(16e6 - 9e4, 3)
    expect(levelName(levels, 3000)).toBe('First')
    expect(levelName(levels, -500)).toBe('')
  })

  it('draws a ruled table with its title, numbers aligned right', () => {
    const table = { title: 'T', header: ['Name', 'N'], right: [false, true], rows: [['abc', '1'], ['d', '1000']] }
    const geometry = tableGeometry(table, new Vector3(0, 0, 0), 100)
    const texts = geometry.filter((g) => g.type === 'annotation')
    expect(texts.map((t) => (t.type === 'annotation' ? t.text : ''))).toEqual(['T', 'Name', 'abc', 'd', 'N', '1', '1000'])
    const frame = geometry.find((g) => g.type === 'polyline' && g.closed)!
    const xs = frame.type === 'polyline' ? frame.points.map((p) => p.x) : []
    const right = Math.max(...xs)
    // Three rows of 200 high under the top.
    expect(frame.type === 'polyline' && Math.min(...frame.points.map((p) => p.y))).toBeCloseTo(-600, 6)
    // The numbers end at the same distance from the right edge.
    const ends = texts.filter((t) => t.type === 'annotation' && ['1', '1000'].includes(t.text)).map((t) => (t.type === 'annotation' ? t.points[0].x : 0))
    expect(ends[0]).toBeGreaterThan(ends[1])
    expect(ends[0]).toBeLessThan(right)
  })
})
