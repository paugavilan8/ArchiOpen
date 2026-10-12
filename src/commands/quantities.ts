import { levelAt, slabParams, wallParams } from '../core/architecture'
import { flatten } from '../core/blocks'
import { length } from '../core/curves'
import type { CadObject } from '../core/document'
import { isCurve, tessellate, type AnyCurve, type Geometry } from '../core/geometry'
import { meshVolume, planArea, quantitiesCsv, sumQuantities, type QuantityItem } from '../core/quantities'
import { millimetersPer } from '../core/units'
import type { Command, CommandContext } from './runner'

/**
 * Quantities of the building's elements: walls (centre line length, one face's area less its
 * openings), slabs (area less openings), roofs (plan area), columns, stairs, railings (length),
 * floor finishes (area), skirting (length), doors and windows (opening area), all with their
 * volumes, by level and material. Schedule > Quantities draws them as a table; ExportQuantities
 * writes them to a CSV file for a spreadsheet.
 */

const NAMES = { Floor: 'Floor finish', Skirting: 'Skirting' }

/** The triangles of a solid or a mesh, for its volume and lowest point. */
function trianglesOf(g: Geometry): { vertices: number[]; triangles: number[] } | null {
  if (g.type === 'brep') return { vertices: g.display.vertices, triangles: g.display.triangles }
  if (g.type !== 'mesh') return null
  const triangles: number[] = []
  for (let i = 0; i + 3 < g.faces.length; i += 4) {
    const [a, b, c, d] = g.faces.slice(i, i + 4)
    triangles.push(a, b, c)
    if (d !== c) triangles.push(a, c, d)
  }
  return { vertices: g.vertices, triangles }
}

const lowest = (vertices: number[]) => {
  let z = Infinity
  for (let i = 2; i < vertices.length; i += 3) z = Math.min(z, vertices[i])
  return Number.isFinite(z) ? z : 0
}

const planLoop = (c: AnyCurve): [number, number][] => {
  const pts = tessellate(c).map((p) => [p.x, p.y] as [number, number])
  const [a, b] = [pts[0], pts[pts.length - 1]]
  return pts.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? pts.slice(0, -1) : pts
}

/** What there is to measure in the model, one item per element. */
export function quantityItems(ctx: CommandContext): QuantityItem[] {
  const { doc } = ctx
  const m = millimetersPer(doc.units) / 1000
  const [m2, m3] = [m * m, m * m * m]
  const levelOf = (z: number) => levelAt(doc.levels, z + 1e-3)?.name ?? doc.levels[0]?.name ?? ''
  const materialOf = (o: CadObject) => o.material ?? doc.layerOf(o).material ?? ''
  const curve = (id: number | undefined) => {
    const g = id === undefined ? undefined : doc.objects.get(id)?.geometry
    return g && isCurve(g) ? g : null
  }
  const items: QuantityItem[] = []
  const openings = new Set<string>()
  for (const obj of doc.objects.values()) {
    if (!doc.isVisible(obj)) continue
    const record = obj.history
    const mesh = trianglesOf(obj.geometry)
    const volume = mesh ? meshVolume(mesh.vertices, mesh.triangles) * m3 : 0
    const level = mesh ? levelOf(lowest(mesh.vertices)) : ''
    const material = materialOf(obj)
    const add = (element: string, length: number, area: number) => items.push({ element, level, material, length, area, volume })
    switch (record?.command) {
      case 'Wall': {
        const path = curve(record.inputs[0])
        const p = wallParams(record.params)
        const run = path ? length(path) : 0
        const face = Math.max(0, run * p.height - p.openings.reduce((s, o) => s + o.width * o.height, 0)) * m2
        add('Wall', run * m, face)
        // Its layers, each over the wall's face.
        for (const layer of p.layers ?? []) items.push({ element: 'Wall layer', level, material: layer.material ? `${layer.name} (${layer.material})` : layer.name, length: 0, area: face, volume: face * layer.thickness * m })
        break
      }
      case 'Slab': {
        const outline = curve(record.inputs[0])
        const p = slabParams(record.params)
        const area = outline ? planArea(planLoop(outline)) - (p.holes ?? []).reduce((s, h) => s + planArea(h.points), 0) : 0
        add('Slab', 0, area * m2)
        break
      }
      case 'Roof': {
        const outline = curve(record.inputs[0])
        add('Roof', 0, outline ? planArea(planLoop(outline)) * m2 : 0)
        break
      }
      case 'CurtainWall': {
        // Measured once, on its glass: its length along the line and its face.
        if (record.params?.part !== 'glass') break
        const line = curve(record.inputs[0])
        const run = line ? length(line) : 0
        add('Curtain wall', run * m, run * Number(record.params?.height ?? 0) * m2)
        break
      }
      case 'Column':
        add('Column', Number(record.params?.height ?? 0) * m, 0)
        break
      case 'Stair':
        add('Stair', 0, 0)
        break
      case 'Railing': {
        const line = curve(record.inputs[0])
        add('Railing', line ? length(line) * m : 0, 0)
        break
      }
      case 'Floor': {
        const t = Number(record.params?.thickness ?? 0)
        add(NAMES.Floor, 0, t > 0 ? volume / (t * m) : 0)
        break
      }
      case 'Skirting': {
        const h = Number(record.params?.height ?? 0)
        const t = Number(record.params?.thickness ?? 0)
        add(NAMES.Skirting, h > 0 && t > 0 ? volume / (h * t * m2) : 0, 0)
        break
      }
      case 'OpeningPart': {
        // Each door or window once, however many parts it has.
        const p = record.params as { wall: number; opening: { id?: number; kind: string; width: number; height: number } }
        const key = `${p.wall}:${p.opening.id ?? JSON.stringify(p.opening)}`
        if (openings.has(key)) break
        openings.add(key)
        items.push({ element: p.opening.kind === 'door' ? 'Door' : 'Window', level, material: '', length: 0, area: p.opening.width * p.opening.height * m2, volume: 0 })
        break
      }
      default:
        if (obj.geometry.type === 'instance' && /^(Furniture|Sanitary)/.test(doc.layerOf(obj).name)) {
          const lows = flatten(obj.geometry).flatMap((g) => trianglesOf(g)?.vertices ?? [])
          items.push({ element: 'Furniture', level: levelOf(lowest(lows)), material: obj.geometry.definition.name, length: 0, area: 0, volume: 0 })
        }
    }
  }
  return items
}

const exportQuantities: Command = {
  name: 'ExportQuantities',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, files, log } = ctx
    const rows = sumQuantities(quantityItems(ctx), doc.levels.map((l) => l.name))
    if (rows.length === 0) throw new Error('There are no building elements to measure (walls, slabs, roofs, stairs, ...)')
    const fileName = await files.exportFile({ name: 'CSV table', extension: 'csv', mime: 'text/csv' }, () => new TextEncoder().encode(quantitiesCsv(rows)))
    if (fileName) log(`Exported ${fileName}: ${rows.length} rows of quantities, in meters`)
  },
}

export const quantityCommands: Command[] = [exportQuantities]
