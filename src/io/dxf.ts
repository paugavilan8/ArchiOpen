import { Vector3 } from 'three'
import type { Layer } from '../core/document'
import { endPoint, Geometry, isCurve, startPoint, tessellate, wireframe } from '../core/geometry'
import { hatchTriangles } from '../core/hatch'
import { LINETYPES } from '../core/linetypes'

/**
 * Writes DXF files in the R12 (AC1009) format, the one practically every CAD and drawing program
 * reads. Lines, polylines, circles and arcs are written as such; other curves, surfaces, texts and
 * dimensions as their line work; solid hatches as filled triangles.
 */

export interface DxfObject {
  layerId: number
  geometry: Geometry
}

export interface DxfModel {
  /** Model units, e.g. 'Millimeters'. */
  units: string
  layers: Layer[]
  objects: DxfObject[]
  /** Scale applied to linetype dash lengths ($LTSCALE), e.g. 100 for a drawing printed at 1:100. */
  linetypeScale: number
  /** Millimeters in one model unit, for the linetype patterns. */
  millimetersPerUnit: number
}

/** $INSUNITS codes. */
const INSUNITS: Record<string, number> = { Inches: 1, Feet: 2, Miles: 3, Millimeters: 4, Centimeters: 5, Meters: 6, Kilometers: 7, Microns: 13, Decimeters: 14, Yards: 10 }

/** The AutoCAD color index palette: 1–9 standard colors, 10–249 hues and shades, 250–255 grays. */
const ACI: [number, [number, number, number]][] = (() => {
  const out: [number, [number, number, number]][] = [
    [1, [255, 0, 0]],
    [2, [255, 255, 0]],
    [3, [0, 255, 0]],
    [4, [0, 255, 255]],
    [5, [0, 0, 255]],
    [6, [255, 0, 255]],
    [7, [0, 0, 0]],
    [8, [128, 128, 128]],
    [9, [192, 192, 192]],
  ]
  // Each hue (every 15°) has five brightness levels, full and mixed halfway with white.
  const levels = [1, 0.8, 0.6, 0.5, 0.3]
  for (let i = 10; i < 250; i++) {
    const hue = (Math.floor((i - 10) / 10) * 15) / 60
    const k = (i - 10) % 10
    const x = 1 - Math.abs((hue % 2) - 1)
    const base = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(hue) % 6]
    const level = levels[Math.floor(k / 2)]
    out.push([i, base.map((c) => Math.round((k % 2 ? (c + 1) / 2 : c) * level * 255)) as [number, number, number]])
  }
  ;[51, 91, 132, 173, 214, 255].forEach((g, j) => out.push([250 + j, [g, g, g]]))
  return out
})()

/** The color of an AutoCAD color index; 7 (black or white) is black, as on paper. */
export function aciToHex(index: number): string {
  const entry = ACI.find(([i]) => i === Math.abs(index))
  const [r, g, b] = entry ? entry[1] : [0, 0, 0]
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** The nearest AutoCAD color index. White counts as black (index 7 shows as either). */
export function aciOf(hex: string): number {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16)
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  if (c.every((x) => x > 240)) return 7
  let best = 7
  let bestDistance = Infinity
  for (const [index, rgb] of ACI) {
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2
    if (d < bestDistance) {
      bestDistance = d
      best = index
    }
  }
  return best
}

/** R12 names allow letters, digits, $, - and _ only. */
export const dxfName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9$_-]+/g, '_')
    .toUpperCase() || 'LAYER'

class Writer {
  private readonly out: string[] = []
  pair(code: number, value: string | number): void {
    const text = typeof value === 'number' ? (Number.isInteger(value) && code >= 60 ? String(value) : fmt(value)) : value
    this.out.push(String(code), text)
  }
  point(base: number, p: Vector3): void {
    this.pair(base, p.x)
    this.pair(base + 10, p.y)
    this.pair(base + 20, p.z)
  }
  toString(): string {
    return this.out.join('\r\n') + '\r\n'
  }
}

const fmt = (v: number) => {
  const s = v.toFixed(9)
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
}

const Z = new Vector3(0, 0, 1)

export function writeDxf(model: DxfModel): string {
  const w = new Writer()
  const layerName = new Map<number, string>()
  const used = new Set<string>()
  for (const layer of model.layers) {
    let name = dxfName(layer.name)
    for (let n = 2; used.has(name); n++) name = `${dxfName(layer.name)}_${n}`
    used.add(name)
    layerName.set(layer.id, name)
  }

  w.pair(0, 'SECTION')
  w.pair(2, 'HEADER')
  w.pair(9, '$ACADVER')
  w.pair(1, 'AC1009')
  w.pair(9, '$INSUNITS')
  w.pair(70, INSUNITS[model.units] ?? 0)
  w.pair(9, '$LTSCALE')
  w.pair(40, model.linetypeScale)
  w.pair(0, 'ENDSEC')

  w.pair(0, 'SECTION')
  w.pair(2, 'TABLES')
  const linetypes = Object.entries(LINETYPES)
  w.pair(0, 'TABLE')
  w.pair(2, 'LTYPE')
  w.pair(70, linetypes.length)
  for (const [name, dashes] of linetypes) {
    w.pair(0, 'LTYPE')
    w.pair(2, name.toUpperCase())
    w.pair(70, 0)
    w.pair(3, name)
    w.pair(72, 65)
    w.pair(73, dashes.length)
    // Pattern lengths in model units, as printed at 1:1; $LTSCALE scales them for the drawing.
    const lengths = dashes.map((d) => d / model.millimetersPerUnit)
    w.pair(40, lengths.reduce((sum, d) => sum + Math.abs(d), 0))
    for (const d of lengths) w.pair(49, d)
  }
  w.pair(0, 'ENDTAB')

  w.pair(0, 'TABLE')
  w.pair(2, 'LAYER')
  w.pair(70, model.layers.length)
  for (const layer of model.layers) {
    w.pair(0, 'LAYER')
    w.pair(2, layerName.get(layer.id)!)
    // Frozen is 1 and locked 4; hidden layers get a negative color.
    w.pair(70, layer.locked ? 4 : 0)
    w.pair(62, (layer.visible ? 1 : -1) * aciOf(layer.color))
    w.pair(6, (layer.linetype ?? 'Continuous').toUpperCase())
  }
  w.pair(0, 'ENDTAB')
  w.pair(0, 'ENDSEC')

  w.pair(0, 'SECTION')
  w.pair(2, 'ENTITIES')
  for (const obj of model.objects) writeEntity(w, layerName.get(obj.layerId) ?? '0', obj.geometry)
  w.pair(0, 'ENDSEC')
  w.pair(0, 'EOF')
  return w.toString()
}

function polyline(w: Writer, layer: string, points: Vector3[], closed: boolean): void {
  if (points.length === 2 && !closed) {
    w.pair(0, 'LINE')
    w.pair(8, layer)
    w.point(10, points[0])
    w.point(11, points[1])
    return
  }
  if (closed && points.length > 2 && points[0].distanceTo(points[points.length - 1]) < 1e-12) points = points.slice(0, -1)
  // Flat polylines in the XY plane stay 2D, which other programs edit more easily.
  const flat = points.every((p) => Math.abs(p.z - points[0].z) < 1e-12)
  w.pair(0, 'POLYLINE')
  w.pair(8, layer)
  w.pair(66, 1)
  w.point(10, new Vector3(0, 0, flat ? points[0].z : 0))
  w.pair(70, (closed ? 1 : 0) | (flat ? 0 : 8))
  for (const p of points) {
    w.pair(0, 'VERTEX')
    w.pair(8, layer)
    w.point(10, p)
    w.pair(70, flat ? 0 : 32)
  }
  w.pair(0, 'SEQEND')
  w.pair(8, layer)
}

function writeEntity(w: Writer, layer: string, g: Geometry): void {
  if (g.type === 'polyline') return polyline(w, layer, g.points, g.closed)
  if ((g.type === 'circle' || g.type === 'arc') && Math.abs(g.xaxis.clone().cross(g.yaxis).dot(Z)) > 1 - 1e-9) {
    const up = g.xaxis.clone().cross(g.yaxis).dot(Z) > 0
    w.pair(0, g.type === 'circle' ? 'CIRCLE' : 'ARC')
    w.pair(8, layer)
    w.point(10, g.center)
    w.pair(40, g.radius)
    if (g.type === 'arc') {
      // DXF arcs run counterclockwise seen from +Z.
      const angle = (p: Vector3) => (Math.atan2(p.y - g.center.y, p.x - g.center.x) * 180) / Math.PI
      const [from, to] = up ? [startPoint(g), endPoint(g)] : [endPoint(g), startPoint(g)]
      w.pair(50, angle(from))
      w.pair(51, angle(to))
    }
    return
  }
  if (isCurve(g)) {
    if (g.type === 'polycurve') {
      for (const segment of g.segments) writeEntity(w, layer, segment)
      return
    }
    return polyline(w, layer, tessellate(g), false)
  }
  if (g.type === 'hatch' && g.pattern === 'Solid') {
    const t = hatchTriangles(g)
    for (let i = 0; i < t.length; i += 9) {
      const [a, b, c] = [0, 3, 6].map((o) => new Vector3(t[i + o], t[i + o + 1], t[i + o + 2]))
      w.pair(0, 'SOLID')
      w.pair(8, layer)
      w.point(10, a)
      w.point(11, b)
      w.point(12, c)
      w.point(13, c)
    }
    return
  }
  // Surfaces, solids, texts, dimensions and patterned hatches as their line work.
  for (const line of wireframe(g)) polyline(w, layer, line, false)
}
