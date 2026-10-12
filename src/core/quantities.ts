import type { Table } from './schedules'

/**
 * Quantities: how much of each kind of building element there is, by level and material: how many,
 * and their length, area and volume, as the measured quantities of a bill of quantities.
 */

export interface QuantityItem {
  /** Kind of element: Wall, Slab, Door, ... */
  element: string
  level: string
  material: string
  /** Lengths, areas and volumes in meters (0 where it does not apply). */
  length: number
  area: number
  volume: number
}

/** The volume inside a closed triangle mesh (sum of signed tetrahedra from the origin). */
export function meshVolume(vertices: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let v = 0
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i] * 3, triangles[i + 1] * 3, triangles[i + 2] * 3]
    const [ax, ay, az] = [vertices[a], vertices[a + 1], vertices[a + 2]]
    const [bx, by, bz] = [vertices[b], vertices[b + 1], vertices[b + 2]]
    const [cx, cy, cz] = [vertices[c], vertices[c + 1], vertices[c + 2]]
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(v) / 6
}

/** The area inside a closed loop in plan, as [x, y] points. */
export function planArea(points: [number, number][]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/** Elements in the order a bill of quantities lists them (others after, by name). */
const ORDER = ['Slab', 'Wall', 'Wall layer', 'Column', 'Stair', 'Roof', 'Railing', 'Door', 'Window', 'Floor finish', 'Skirting', 'Furniture']

export interface QuantityRow extends QuantityItem {
  count: number
}

/** The items summed by element, level and material, in order. */
export function sumQuantities(items: QuantityItem[], levels: readonly string[]): QuantityRow[] {
  const rows = new Map<string, QuantityRow>()
  for (const it of items) {
    const key = [it.element, it.level, it.material].join('\u0000')
    const row = rows.get(key) ?? { ...it, count: 0, length: 0, area: 0, volume: 0 }
    row.count++
    row.length += it.length
    row.area += it.area
    row.volume += it.volume
    rows.set(key, row)
  }
  const rank = (e: string) => {
    const i = ORDER.indexOf(e)
    return i < 0 ? ORDER.length : i
  }
  const level = (l: string) => {
    const i = levels.indexOf(l)
    return i < 0 ? levels.length : i
  }
  return [...rows.values()].sort((a, b) => rank(a.element) - rank(b.element) || a.element.localeCompare(b.element) || level(a.level) - level(b.level) || a.material.localeCompare(b.material))
}

const fixed = (n: number, digits: number) => (n > 0 ? n.toFixed(digits) : '')

/** The quantities table, with each element's total where it spans several rows. */
export function quantityTable(rows: QuantityRow[]): Table {
  const out: string[][] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    out.push([i > 0 && rows[i - 1].element === r.element ? '' : r.element, r.level, r.material, String(r.count), fixed(r.length, 2), fixed(r.area, 2), fixed(r.volume, 3)])
    const last = i === rows.length - 1 || rows[i + 1].element !== r.element
    const group = rows.filter((x) => x.element === r.element)
    if (last && group.length > 1) {
      const sum = (k: 'count' | 'length' | 'area' | 'volume') => group.reduce((s, x) => s + x[k], 0)
      out.push(['', `Total ${r.element.toLowerCase()}`, '', String(sum('count')), fixed(sum('length'), 2), fixed(sum('area'), 2), fixed(sum('volume'), 3)])
    }
  }
  return {
    title: 'Quantities',
    header: ['Element', 'Level', 'Material', 'No.', 'Length (m)', 'Area (m²)', 'Volume (m³)'],
    right: [false, false, false, true, true, true, true],
    rows: out,
  }
}

/** The quantities as CSV (comma separated, quoted where needed), for spreadsheets. */
export function quantitiesCsv(rows: QuantityRow[]): string {
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [['Element', 'Level', 'Material', 'Count', 'Length (m)', 'Area (m2)', 'Volume (m3)']]
  for (const r of rows) lines.push([r.element, r.level, r.material, String(r.count), r.length.toFixed(3), r.area.toFixed(3), r.volume.toFixed(4)])
  return lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'
}
