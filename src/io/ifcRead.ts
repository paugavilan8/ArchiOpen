import type { FlatMesh, IfcAPI } from 'web-ifc'
import type { Level } from '../core/architecture'
import type { MeshGeometry } from '../core/geometry'
import type { RhinoImport } from './rhino3dm'
import { recognize, type MeshElement, type Recognized } from '../core/ifcRecognize'

/**
 * IFC import, through web-ifc: each element's shape as a mesh, on a layer per IFC class (Wall,
 * Slab, Window, ...) colored as in the file, in millimeters; spaces on a hidden layer; and the
 * building storeys as levels.
 */

const IFCBUILDINGSTOREY = 3124254112
const IFCSIUNIT = 448429030
const IFCSPACE = 3856911033

let loading: Promise<IfcAPI> | null = null

/** Loads web-ifc the first time an IFC file is read (its WebAssembly is fetched then). */
export function loadIfc(): Promise<IfcAPI> {
  loading ??= Promise.all([import('web-ifc'), import('web-ifc/web-ifc.wasm?url')]).then(async ([module, wasm]) => {
    const api = new module.IfcAPI()
    await api.Init(() => wasm.default, true)
    return api
  })
  loading.catch(() => (loading = null))
  return loading
}

/** The class name for a layer: IFCWALLSTANDARDCASE → Wall standard case. */
export function layerName(className: string): string {
  const typeName = className.toUpperCase()
  const known: Record<string, string> = {
    IFCWALL: 'Wall',
    IFCWALLSTANDARDCASE: 'Wall',
    IFCSLAB: 'Slab',
    IFCROOF: 'Roof',
    IFCDOOR: 'Door',
    IFCWINDOW: 'Window',
    IFCSTAIR: 'Stair',
    IFCSTAIRFLIGHT: 'Stair',
    IFCRAILING: 'Railing',
    IFCCOLUMN: 'Column',
    IFCBEAM: 'Beam',
    IFCMEMBER: 'Member',
    IFCPLATE: 'Plate',
    IFCCOVERING: 'Covering',
    IFCFURNITURE: 'Furniture',
    IFCFURNISHINGELEMENT: 'Furniture',
    IFCSPACE: 'Space',
    IFCCURTAINWALL: 'Curtain wall',
    IFCFOOTING: 'Footing',
    IFCBUILDINGELEMENTPROXY: 'Other',
  }
  if (known[typeName]) return known[typeName]
  const bare = typeName.replace(/^IFC/, '').toLowerCase()
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

const hex = (c: { x: number; y: number; z: number }) =>
  '#' +
  [c.x, c.y, c.z]
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

/** Meters per unit of the file's lengths (from its SI length unit; 1 if it has none or another kind). */
function lengthUnit(api: IfcAPI, model: number): number {
  const prefixes: Record<string, number> = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 }
  const ids = api.GetLineIDsWithType(model, IFCSIUNIT)
  for (let i = 0; i < ids.size(); i++) {
    const unit = api.GetLine(model, ids.get(i))
    if (unit?.UnitType?.value === 'LENGTHUNIT' && unit?.Name?.value === 'METRE') return prefixes[unit.Prefix?.value ?? ''] ?? 1
  }
  return 1
}

export interface IfcImport extends RhinoImport {
  /** The storeys, as levels (elevations in millimeters), lowest first. */
  levels: Level[]
  /** How many elements were read as meshes, by layer. */
  counts: Map<string, number>
  /** Walls (with their doors and windows) and slabs to make as ArchiOpen's own elements. */
  native: Pick<Recognized, 'walls' | 'slabs'> & {
    /** Why walls and slabs were left as meshes: each reason with how many. */
    leftAsMeshes: Map<string, number>
  }
}

/** Reads an IFC file's elements as meshes. */
export function readIfc(api: IfcAPI, bytes: Uint8Array, options: { native?: boolean } = {}): IfcImport {
  // IFC files are STEP files (ISO 10303-21) with an IFC schema; the reader fails obscurely on others.
  const head = new TextDecoder().decode(bytes.subarray(0, 65536))
  if (!/ISO-10303-21/.test(head) || !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head)) throw new Error('This is not a valid IFC file')
  const model = api.OpenModel(bytes)
  if (model < 0) throw new Error('This is not a valid IFC file')
  try {
    const layers: RhinoImport['layers'] = []
    const layerIndex = new Map<string, number>()
    const objects: RhinoImport['objects'] = []
    const counts = new Map<string, number>()
    const MM = 1000
    const onMesh = (mesh: FlatMesh) => {
      const typeName = api.GetNameFromTypeCode(api.GetLineType(model, mesh.expressID)).toUpperCase()
      const name = layerName(typeName)
      const vertices: number[] = []
      const faces: number[] = []
      let color = '#9a9a9a'
      const placed = mesh.geometries
      for (let g = 0; g < placed.size(); g++) {
        const p = placed.get(g)
        if (g === 0) color = hex(p.color)
        const geometry = api.GetGeometry(model, p.geometryExpressID)
        const data = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize())
        const index = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize())
        const m = p.flatTransformation
        const base = vertices.length / 3
        // Six numbers per vertex (position, normal); web-ifc works with Y up, the model with Z up.
        for (let i = 0; i + 5 < data.length; i += 6) {
          const [x, y, z] = [data[i], data[i + 1], data[i + 2]]
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
          vertices.push(wx * MM, -wz * MM, wy * MM)
        }
        for (let i = 0; i + 2 < index.length; i += 3) faces.push(base + index[i], base + index[i + 1], base + index[i + 2], base + index[i + 2])
        geometry.delete()
      }
      if (faces.length === 0) return
      elements.push({ type: typeName, vertices, faces, color })
    }
    const elements: (MeshElement & { color: string })[] = []
    api.StreamAllMeshes(model, onMesh)
    // Spaces are left out of that stream.
    api.StreamAllMeshesWithTypes(model, [IFCSPACE], onMesh)

    // Walls, slabs, doors and windows that ArchiOpen can make itself come in as its own elements.
    const native = options.native === false ? { walls: [], slabs: [], used: new Set<number>(), rejected: new Map<number, string>() } : recognize(elements)
    elements.forEach((e, i) => {
      if (native.used.has(i)) return
      const name = layerName(e.type)
      let layer = layerIndex.get(name)
      if (layer === undefined) {
        layer = layers.length
        layerIndex.set(name, layer)
        // Spaces are volumes for the rooms' areas: kept, but hidden.
        layers.push({ name, color: e.color, visible: e.type !== 'IFCSPACE', locked: false })
      }
      objects.push({ layer, geometry: { type: 'mesh', vertices: e.vertices, faces: e.faces } satisfies MeshGeometry })
      counts.set(name, (counts.get(name) ?? 0) + 1)
    })

    // Why: the reason (without its figures) and its element's kind.
    const leftAsMeshes = new Map<string, number>()
    for (const [i, why] of native.rejected) {
      const key = `${elements[i].type.startsWith('IFCSLAB') ? 'slabs' : 'walls'} ${why.replace(/ \(.*$/, '')}`
      leftAsMeshes.set(key, (leftAsMeshes.get(key) ?? 0) + 1)
    }

    // Storeys as levels, each up to the next (the last as high as the one under it).
    const unit = lengthUnit(api, model) * MM
    const storeys = api.GetLineIDsWithType(model, IFCBUILDINGSTOREY)
    const found: { name: string; elevation: number }[] = []
    for (let i = 0; i < storeys.size(); i++) {
      const s = api.GetLine(model, storeys.get(i))
      const elevation = Number(s?.Elevation?.value)
      if (Number.isFinite(elevation)) found.push({ name: String(s?.Name?.value ?? `Level ${i}`), elevation: Math.round(elevation * unit * 1000) / 1000 })
    }
    found.sort((a, b) => a.elevation - b.elevation)
    const levels: Level[] = found.map((l, i) => {
      const next = found[i + 1]?.elevation
      const below = i > 0 ? l.elevation - found[i - 1].elevation : 3000
      return { ...l, height: next !== undefined && next > l.elevation ? next - l.elevation : below > 0 ? below : 3000 }
    })
    // Names must be unique for levels.
    const seen = new Set<string>()
    for (const l of levels) {
      let name = l.name
      for (let n = 2; seen.has(name); n++) name = `${l.name} (${n})`
      seen.add((l.name = name))
    }
    return { units: 'Millimeters', layers, objects, breps: [], tolerance: 0, skipped: new Map(), levels, counts, native: { walls: native.walls, slabs: native.slabs, leftAsMeshes } }
  } finally {
    api.CloseModel(model)
  }
}
