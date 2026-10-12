import { levelAt } from '../core/architecture'
import { flatten } from '../core/blocks'
import type { CadObject, Document } from '../core/document'
import { isClosed, isCurve, tessellate, type AnyCurve, type Geometry } from '../core/geometry'
import { millimetersPer } from '../core/units'
import type { IfcClass, IfcElement, IfcMesh, IfcModel, IfcSpace } from './ifc'

/**
 * The document as an IFC model: architecture objects by what made them (Wall, Slab, Roof, ...),
 * the frames, glass and leaves of each door and window together as one IfcDoor or IfcWindow, block
 * instances as furniture, other solids, surfaces and meshes as proxies, and rooms as spaces.
 */

const BY_COMMAND: Record<string, { type: IfcClass; predefined?: string; name: string }> = {
  Wall: { type: 'IfcWall', name: 'Wall' },
  Slab: { type: 'IfcSlab', predefined: 'FLOOR', name: 'Slab' },
  Roof: { type: 'IfcRoof', name: 'Roof' },
  Stair: { type: 'IfcStair', name: 'Stair' },
  Column: { type: 'IfcColumn', predefined: 'COLUMN', name: 'Column' },
  Railing: { type: 'IfcRailing', name: 'Railing' },
  Floor: { type: 'IfcCovering', predefined: 'FLOORING', name: 'Floor finish' },
  Skirting: { type: 'IfcCovering', predefined: 'SKIRTINGBOARD', name: 'Skirting' },
}

/** Layers of drawings and notes, never exported. */
const DRAWING_LAYERS = /^(Make2D|Elevations|Sections|Section Marks|Plan Symbols|Plan Cut|Dimensions|Construction|Schedules)/

/** A geometry's triangles, if it has a shape. */
function meshOf(g: Geometry): IfcMesh | null {
  if (g.type === 'brep') return g.display.triangles.length >= 3 ? { vertices: g.display.vertices, triangles: g.display.triangles } : null
  if (g.type !== 'mesh') return null
  // Faces are quads; a triangle repeats its last corner.
  const triangles: number[] = []
  for (let i = 0; i + 3 < g.faces.length; i += 4) {
    const [a, b, c, d] = g.faces.slice(i, i + 4)
    triangles.push(a, b, c)
    if (d !== c) triangles.push(a, c, d)
  }
  return triangles.length > 0 ? { vertices: g.vertices, triangles } : null
}

const lowest = (meshes: IfcMesh[]) => {
  let z = Infinity
  for (const m of meshes) for (let i = 2; i < m.vertices.length; i += 3) z = Math.min(z, m.vertices[i])
  return z
}

/** The area inside a loop in plan, with its sign. */
function loopArea(pts: [number, number][]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** `wallPieces`: walls along several segments, as one piece for each (see wallPieces in app/ifcNative). */
export function ifcModel(doc: Document, project: string, wallPieces: Map<number, IfcMesh[]> = new Map()): IfcModel {
  const levelOf = (z: number) => levelAt(doc.levels, z + 1e-3)?.name ?? doc.levels[0]?.name ?? 'Level 0'
  const elements: IfcElement[] = []
  const openings = new Map<string, { element: IfcElement; meshes: IfcMesh[] }>()
  const counts = new Map<string, number>()
  const named = (base: string) => {
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    return `${base} ${n}`
  }
  const shown = (o: CadObject) => doc.isVisible(o) && !DRAWING_LAYERS.test(doc.layerOf(o).name)

  for (const obj of doc.objects.values()) {
    if (!shown(obj)) continue
    const command = obj.history?.command
    // Doors and windows: their parts gathered by wall and opening.
    if (command === 'OpeningPart') {
      const p = obj.history!.params as { wall: number; opening: { id?: number; kind: 'door' | 'window'; width: number; height: number; hinge?: string; swing?: string } }
      const mesh = meshOf(obj.geometry)
      if (!mesh) continue
      const key = `${p.wall}:${p.opening.id ?? JSON.stringify(p.opening)}`
      let entry = openings.get(key)
      if (!entry) {
        const door = p.opening.kind === 'door'
        const element: IfcElement = {
          type: door ? 'IfcDoor' : 'IfcWindow',
          name: named(door ? 'Door' : 'Window'),
          level: '',
          meshes: [],
          predefined: door ? 'DOOR' : 'WINDOW',
          width: p.opening.width,
          height: p.opening.height,
          ...(door ? { operation: p.opening.hinge ? `SINGLE_SWING_${p.opening.hinge === 'start' ? 'LEFT' : 'RIGHT'}` : 'NOTDEFINED' } : {}),
        }
        openings.set(key, (entry = { element, meshes: element.meshes }))
        elements.push(element)
      }
      entry.meshes.push(mesh)
      continue
    }
    if (command === 'OpeningSymbol') continue
    // A curtain wall's frame and glass together, by their line.
    if (command === 'CurtainWall') {
      const mesh = meshOf(obj.geometry)
      if (!mesh) continue
      const key = `curtain:${obj.history!.inputs[0]}`
      let entry = openings.get(key)
      if (!entry) {
        const element: IfcElement = { type: 'IfcCurtainWall', name: named('Curtain wall'), level: '', meshes: [] }
        openings.set(key, (entry = { element, meshes: element.meshes }))
        elements.push(element)
      }
      entry.meshes.push(mesh)
      continue
    }
    const known = command ? BY_COMMAND[command] : undefined
    if (obj.geometry.type === 'instance') {
      const meshes = flatten(obj.geometry).flatMap((g) => meshOf(g) ?? [])
      if (meshes.length > 0) elements.push({ type: 'IfcFurniture', name: obj.geometry.definition.name, level: levelOf(lowest(meshes)), meshes, predefined: 'NOTDEFINED' })
      continue
    }
    const pieces = wallPieces.get(obj.id)
    if (pieces && known) {
      for (const piece of pieces) elements.push({ type: known.type, name: named(known.name), level: levelOf(lowest([piece])), meshes: [piece] })
      continue
    }
    const mesh = meshOf(obj.geometry)
    if (!mesh) continue
    const base = known ?? { type: 'IfcBuildingElementProxy' as const, name: doc.layerOf(obj).name || 'Object' }
    elements.push({ type: base.type, name: named(base.name), level: levelOf(lowest([mesh])), meshes: [mesh], ...(base.predefined ? { predefined: base.predefined } : {}) })
  }
  for (const { element } of openings.values()) element.level = levelOf(lowest(element.meshes))

  return { project, toMeters: millimetersPer(doc.units) / 1000, levels: doc.levels.map((l) => ({ ...l })), elements, spaces: roomSpaces(doc, levelOf) }
}

/** Rooms labelled with Room: the label's name and the outlines grouped with it. */
function roomSpaces(doc: Document, levelOf: (z: number) => string): IfcSpace[] {
  const rooms = doc.layers.find((l) => l.name === 'Rooms')
  if (!rooms) return []
  const out: IfcSpace[] = []
  for (const obj of doc.objects.values()) {
    const g = obj.geometry
    if (obj.layerId !== rooms.id || g.type !== 'annotation' || g.kind !== 'text') continue
    const group = obj.groups?.[0]
    if (group === undefined) continue
    const loops = [...doc.objects.values()]
      .filter((o) => o.groups?.includes(group) && isCurve(o.geometry) && isClosed(o.geometry as AnyCurve))
      .map((o) => {
        const pts = tessellate(o.geometry as AnyCurve).map((p) => [p.x, p.y] as [number, number])
        // Without the closing point repeated.
        const [a, b] = [pts[0], pts[pts.length - 1]]
        return pts.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? pts.slice(0, -1) : pts
      })
      .sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)))
    if (loops.length === 0) continue
    const area = Math.abs(loopArea(loops[0])) - loops.slice(1).reduce((s, l) => s + Math.abs(loopArea(l)), 0)
    out.push({ name: g.text.split('\n')[0], level: levelOf(g.points[0].z), loops, area })
  }
  return out
}

