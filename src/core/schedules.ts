import { Vector3 } from 'three'
import { textShape } from '../text/strokeFont'
import type { Level, Opening } from './architecture'
import { levelAt } from './architecture'
import type { AnnotationGeometry, AnyCurve, Geometry } from './geometry'
import { tessellate } from './geometry'

/**
 * Schedules: tables drawn in the model from the building's objects, to place on sheets.
 * - Doors and windows: one row per type (same kind, size, sill and frame), marked D1, D2, ... and
 *   W1, W2, ..., with how many there are on each level.
 * - Rooms: one row per room label, with its level and floor area, and the total of each level.
 */

export interface Table {
  title: string
  header: string[]
  rows: string[][]
  /** Columns aligned right (numbers). */
  right: boolean[]
}

export interface ScheduledOpening {
  opening: Opening
  /** The level of the wall it is in, if any. */
  level: string
}

export interface OpeningType {
  mark: string
  kind: Opening['kind']
  width: number
  height: number
  sill: number
  frame: boolean
  /** How many, by level, in level order. */
  counts: Map<string, number>
}

const typeKey = (o: Opening) => [o.kind, o.width, o.height, o.sill, o.frame !== false].join('|')

/** The kinds of openings, doors first then windows, each by width then height; marked in that order. */
export function openingTypes(openings: ScheduledOpening[], levels: readonly Level[]): OpeningType[] {
  const types = new Map<string, OpeningType>()
  for (const { opening: o, level } of openings) {
    const key = typeKey(o)
    let t = types.get(key)
    if (!t) types.set(key, (t = { mark: '', kind: o.kind, width: o.width, height: o.height, sill: o.sill, frame: o.frame !== false, counts: new Map() }))
    t.counts.set(level, (t.counts.get(level) ?? 0) + 1)
  }
  const order = (l: string) => levels.findIndex((x) => x.name === l)
  const sorted = [...types.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'door' ? -1 : 1) || a.width - b.width || a.height - b.height || a.sill - b.sill || Number(b.frame) - Number(a.frame))
  const next = { door: 0, window: 0 }
  for (const t of sorted) {
    t.mark = `${t.kind === 'door' ? 'D' : 'W'}${++next[t.kind]}`
    t.counts = new Map([...t.counts].sort((a, b) => order(a[0]) - order(b[0])))
  }
  return sorted
}

/** A length as a whole number of millimeters. */
const mm = (value: number, toMm: number) => String(Math.round(value * toMm))

/** The doors and windows table. `toMm` turns model units into millimeters. */
export function openingSchedule(types: OpeningType[], toMm: number): Table {
  return {
    title: 'Doors and windows',
    header: ['Mark', 'Type', 'Width', 'Height', 'Sill', 'Levels', 'Count'],
    right: [false, false, true, true, true, false, true],
    rows: [
      ...types.map((t) => [
        t.mark,
        `${t.kind === 'door' ? 'Door' : 'Window'}${t.frame ? '' : ' (opening)'}`,
        mm(t.width, toMm),
        mm(t.height, toMm),
        mm(t.sill, toMm),
        [...t.counts].map(([level, n]) => (t.counts.size > 1 ? `${level} (${n})` : level)).join(', '),
        String([...t.counts.values()].reduce((a, b) => a + b, 0)),
      ]),
      ['', 'Total', '', '', '', '', String(types.reduce((sum, t) => sum + [...t.counts.values()].reduce((a, b) => a + b, 0), 0))],
    ],
  }
}

export interface ScheduledRoom {
  name: string
  level: string
  /** Floor area in square model units. */
  area: number
}

/** The rooms table, by level then name, with each level's total. `factor` and `unit` give the area units. */
export function roomSchedule(rooms: ScheduledRoom[], levels: readonly Level[], factor: number, unit: string): Table {
  const order = (l: string) => {
    const i = levels.findIndex((x) => x.name === l)
    return i < 0 ? levels.length : i
  }
  const sorted = [...rooms].sort((a, b) => order(a.level) - order(b.level) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  const rows: string[][] = []
  const area = (a: number) => (a * factor).toFixed(2)
  let total = 0
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    rows.push([r.name, r.level, area(r.area)])
    total += r.area
    const last = i === sorted.length - 1 || sorted[i + 1].level !== r.level
    const levelCount = new Set(sorted.map((x) => x.level)).size
    if (last && levelCount > 1) rows.push(['', `Total ${r.level}`, area(sorted.filter((x) => x.level === r.level).reduce((s, x) => s + x.area, 0))])
  }
  rows.push(['', 'Total', area(total)])
  return { title: 'Rooms', header: ['Room', 'Level', `Area (${unit})`], right: [false, false, true], rows }
}

/** The area of a closed curve (in plan), with its sign. */
function signedArea(curve: AnyCurve): number {
  const pts = tessellate(curve)
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** The floor area inside room outlines: the largest loop less the others (holes round columns). */
export function areaInside(loops: AnyCurve[]): number {
  const areas = loops.map((l) => Math.abs(signedArea(l))).sort((a, b) => b - a)
  return areas.length === 0 ? 0 : areas[0] - areas.slice(1).reduce((s, a) => s + a, 0)
}

/** The level a height is on, by name ('' if below every level). */
export const levelName = (levels: readonly Level[], z: number) => levelAt(levels, z)?.name ?? ''

/**
 * A table as lines and texts in the XY plane, its top left corner at `at`: a title over a ruled grid
 * with a header row.
 */
export function tableGeometry(table: Table, at: Vector3, height: number): Geometry[] {
  const pad = height * 0.6
  const rowHeight = height * 2
  const width = (text: string) => (text ? Math.max(...textShape(text).widths) * height : 0)
  const columns = table.header.map((h, c) => Math.max(width(h), ...table.rows.map((r) => width(r[c] ?? ''))) + 2 * pad)
  const total = columns.reduce((a, b) => a + b, 0)
  const lines = table.rows.length + 1
  const bottom = at.y - lines * rowHeight
  const out: Geometry[] = []
  const line = (a: Vector3, b: Vector3): AnyCurve => ({ type: 'polyline', points: [a, b], closed: false })
  const text = (t: string, x: number, y: number, h = height): AnnotationGeometry => ({
    type: 'annotation',
    kind: 'text',
    points: [new Vector3(x, y, at.z)],
    xaxis: new Vector3(1, 0, 0),
    yaxis: new Vector3(0, 1, 0),
    text: t,
    height: h,
    arrow: 'arrow',
    precision: 0,
  })
  // The title, larger, over the table.
  out.push(text(table.title, at.x, at.y + height * 0.6, height * 1.4))
  // Rules: the frame, a heavier line under the header (doubled), and between rows.
  out.push({ type: 'polyline', points: [at.clone(), new Vector3(at.x + total, at.y, at.z), new Vector3(at.x + total, bottom, at.z), new Vector3(at.x, bottom, at.z)], closed: true })
  for (let r = 1; r < lines; r++) {
    const y = at.y - r * rowHeight
    out.push(line(new Vector3(at.x, y, at.z), new Vector3(at.x + total, y, at.z)))
    if (r === 1) out.push(line(new Vector3(at.x, y + height * 0.15, at.z), new Vector3(at.x + total, y + height * 0.15, at.z)))
  }
  let x = at.x
  for (let c = 0; c < columns.length; c++) {
    if (c > 0) out.push(line(new Vector3(x, at.y, at.z), new Vector3(x, bottom, at.z)))
    const cells = [table.header[c], ...table.rows.map((r) => r[c] ?? '')]
    cells.forEach((cell, r) => {
      if (!cell) return
      // Texts sit on their baseline, centred in the row's height.
      const y = at.y - (r + 1) * rowHeight + (rowHeight - height) / 2
      const left = table.right[c] && r > 0 ? x + columns[c] - pad - width(cell) : x + pad
      out.push(text(cell, left, y))
    })
    x += columns[c]
  }
  return out
}
