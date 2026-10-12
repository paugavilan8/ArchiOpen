/**
 * IFC export (IFC4, the STEP text form): the building as a project with a site, a building and one
 * storey per level, and each building element as its IFC entity (walls, slabs, roofs, stairs,
 * columns, railings, doors, windows, coverings, furniture, and the rest as proxies). Elements carry
 * their shape as triangulated faces (IfcTriangulatedFaceSet), which every IFC viewer and BIM tool
 * reads; rooms become spaces, extruded from their outlines through their storey, with their floor
 * area. Lengths are written in meters.
 */

export type IfcClass =
  | 'IfcWall'
  | 'IfcSlab'
  | 'IfcRoof'
  | 'IfcStair'
  | 'IfcColumn'
  | 'IfcRailing'
  | 'IfcDoor'
  | 'IfcWindow'
  | 'IfcCovering'
  | 'IfcFurniture'
  | 'IfcBuildingElementProxy'

/** Triangles: [x, y, z, ...] in model units and vertex index triples. */
export interface IfcMesh {
  vertices: number[]
  triangles: number[]
}

export interface IfcElement {
  type: IfcClass
  name: string
  /** The level it belongs to, by name. */
  level: string
  meshes: IfcMesh[]
  /** IFC predefined type (without dots), if not NOTDEFINED. */
  predefined?: string
  /** Doors and windows: overall sizes (model units) and a door's operation. */
  width?: number
  height?: number
  operation?: string
}

export interface IfcSpace {
  name: string
  level: string
  /** Outline loops in plan (the first the outside, the rest holes), as [x, y] in model units. */
  loops: [number, number][][]
  /** Floor area in square model units. */
  area: number
}

export interface IfcModel {
  project: string
  /** Meters per model unit. */
  toMeters: number
  levels: { name: string; elevation: number; height: number }[]
  elements: IfcElement[]
  spaces: IfcSpace[]
}

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

/** A new IFC GlobalId: 128 random bits in IFC's 22-character base 64. */
export function ifcGuid(random: () => number = Math.random): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256))
  // 2 bits, then 21 groups of 6 bits.
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  bits = '0000' + bits // 132 bits: 22 × 6
  let out = ''
  for (let i = 0; i < 132; i += 6) out += GUID_CHARS[parseInt(bits.slice(i, i + 6), 2)]
  // The first character only carries 2 bits.
  return out
}

/** A string in STEP form: quotes doubled, anything past ASCII encoded as \X2\...\X0\. */
export function stepString(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === "'") out += "''"
    else if (ch === '\\') out += '\\\\'
    else if (code >= 0x20 && code < 0x7f) out += ch
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`
  }
  return `'${out}'`
}

/** A real number in STEP form (always with a decimal point). */
export function stepReal(n: number): string {
  if (!Number.isFinite(n)) n = 0
  const r = Math.abs(n) < 1e-12 ? 0 : n
  const s = String(Math.round(r * 1e6) / 1e6)
  return s.includes('.') || s.includes('e') ? s.replace('e', 'E') : `${s}.`
}

/** Writes a model as an IFC4 file. */
export function writeIfc(model: IfcModel, options: { random?: () => number; timestamp?: string } = {}): string {
  const lines: string[] = []
  let next = 0
  const add = (entity: string) => {
    lines.push(`#${++next}=${entity};`)
    return `#${next}`
  }
  const guid = () => stepString(ifcGuid(options.random))
  const k = model.toMeters
  const real = stepReal
  const point = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`)
  const list = (refs: string[]) => `(${refs.join(',')})`

  // Units, context and the placement everything starts from.
  const units = add(
    `IFCUNITASSIGNMENT(${list([
      add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'),
      add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
      add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
      add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
    ])})`,
  )
  const origin = point(0, 0, 0)
  const zAxis = add('IFCDIRECTION((0.,0.,1.))')
  const xAxis = add('IFCDIRECTION((1.,0.,0.))')
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`)
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`)
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$)`)
  const project = add(`IFCPROJECT(${guid()},$,${stepString(model.project)},$,$,$,$,(${context}),${units})`)

  const placement = (relativeTo: string | null, z = 0) => {
    const at = z === 0 ? origin : point(0, 0, z * k)
    return add(`IFCLOCALPLACEMENT(${relativeTo ?? '$'},${add(`IFCAXIS2PLACEMENT3D(${at},$,$)`)})`)
  }
  const sitePlacement = placement(null)
  const site = add(`IFCSITE(${guid()},$,'Site',$,$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`)
  const buildingPlacement = placement(sitePlacement)
  const building = add(`IFCBUILDING(${guid()},$,${stepString(model.project)},$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`)
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${site}))`)
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${site},(${building}))`)

  // One storey per level (at least one).
  const levels = model.levels.length > 0 ? model.levels : [{ name: 'Level 0', elevation: 0, height: 3000 }]
  const storeys = new Map<string, { ref: string; placement: string; elevation: number; height: number }>()
  for (const l of levels) {
    const p = placement(buildingPlacement, l.elevation)
    const ref = add(`IFCBUILDINGSTOREY(${guid()},$,${stepString(l.name)},$,$,${p},$,$,.ELEMENT.,${real(l.elevation * k)})`)
    storeys.set(l.name, { ref, placement: p, elevation: l.elevation, height: l.height })
  }
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},${list([...storeys.values()].map((s) => s.ref))})`)
  const storeyOf = (name: string) => storeys.get(name) ?? storeys.values().next().value!

  const contained = new Map<string, string[]>()
  for (const e of model.elements) {
    const storey = storeyOf(e.level)
    // Coordinates relative to the storey (its placement is at its elevation).
    const faces = e.meshes
      .filter((m) => m.triangles.length >= 3)
      .map((m) => {
        const coords: string[] = []
        for (let i = 0; i < m.vertices.length; i += 3) coords.push(`(${real(m.vertices[i] * k)},${real(m.vertices[i + 1] * k)},${real((m.vertices[i + 2] - storey.elevation) * k)})`)
        const points = add(`IFCCARTESIANPOINTLIST3D((${coords.join(',')}))`)
        const triangles: string[] = []
        for (let i = 0; i + 2 < m.triangles.length; i += 3) triangles.push(`(${m.triangles[i] + 1},${m.triangles[i + 1] + 1},${m.triangles[i + 2] + 1})`)
        return add(`IFCTRIANGULATEDFACESET(${points},$,$,(${triangles.join(',')}),$)`)
      })
    if (faces.length === 0) continue
    const shape = add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',${list(faces)})`)
    const product = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shape}))`)
    const p = placement(storey.placement)
    const predefined = `.${e.predefined ?? 'NOTDEFINED'}.`
    const head = `${guid()},$,${stepString(e.name)},$,$,${p},${product},$`
    const size = (v?: number) => (v === undefined ? '$' : real(v * k))
    let ref: string
    if (e.type === 'IfcDoor') ref = add(`IFCDOOR(${head},${size(e.height)},${size(e.width)},${predefined},.${e.operation ?? 'NOTDEFINED'}.,$)`)
    else if (e.type === 'IfcWindow') ref = add(`IFCWINDOW(${head},${size(e.height)},${size(e.width)},${predefined},.NOTDEFINED.,$)`)
    else ref = add(`${e.type.toUpperCase()}(${head},${predefined})`)
    const level = storeys.has(e.level) ? e.level : [...storeys.keys()][0]
    contained.set(level, [...(contained.get(level) ?? []), ref])
  }
  for (const [level, refs] of contained) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,${list(refs)},${storeyOf(level).ref})`)

  // Spaces: the room outline extruded through the storey, with its floor area.
  const spaces = new Map<string, string[]>()
  for (const s of model.spaces) {
    const storey = storeyOf(s.level)
    const loop = (pts: [number, number][]) => {
      const refs = pts.map(([x, y]) => add(`IFCCARTESIANPOINT((${real(x * k)},${real(y * k)}))`))
      return add(`IFCPOLYLINE(${list([...refs, refs[0]])})`)
    }
    const loops = s.loops.filter((l) => l.length >= 3)
    if (loops.length === 0) continue
    const [outer, ...holes] = loops.map(loop)
    const profile =
      holes.length > 0 ? add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,${stepString(s.name)},${outer},${list(holes)})`) : add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${stepString(s.name)},${outer})`)
    const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${world},${zAxis},${real(storey.height * k)})`)
    const shape = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`)
    const product = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shape}))`)
    const ref = add(`IFCSPACE(${guid()},$,${stepString(s.name)},$,$,${placement(storey.placement)},${product},$,.ELEMENT.,.INTERNAL.,$)`)
    const area = add(`IFCQUANTITYAREA('NetFloorArea',$,$,${real(s.area * k * k)},$)`)
    const quantities = add(`IFCELEMENTQUANTITY(${guid()},$,'Qto_SpaceBaseQuantities',$,$,(${area}))`)
    add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${ref}),${quantities})`)
    const level = storeys.has(s.level) ? s.level : [...storeys.keys()][0]
    spaces.set(level, [...(spaces.get(level) ?? []), ref])
  }
  for (const [level, refs] of spaces) add(`IFCRELAGGREGATES(${guid()},$,$,$,${storeyOf(level).ref},${list(refs)})`)

  const stamp = options.timestamp ?? new Date().toISOString().slice(0, 19)
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${stepString(model.project + '.ifc')},${stepString(stamp)},(''),(''),'ArchiOpen','ArchiOpen','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ]
  return [...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n')
}
