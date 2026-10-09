import { Vector3 } from 'three'
import type { Brep, Curve, GeometryBase, NurbsCurve, RhinoModule } from 'rhino3dm'
import { chain } from '../core/curves'
import type { Layer } from '../core/document'
import { wireframe } from '../core/geometry'
import type { AnyCurve, BrepGeometry, Geometry, SegmentGeometry } from '../core/geometry'
import { interpolate } from '../math/nurbs'
import type { BrepFaceData, NurbsCurveData, NurbsSurfaceData, RhinoBrepData } from './rhinoBrepData'

/** Content read from a .3dm file, ready to be added to a document. */
export interface RhinoImport {
  units: string
  layers: Omit<Layer, 'id'>[]
  /** Geometry with the index of its layer in `layers`. */
  objects: { layer: number; geometry: Geometry }[]
  /** Polysurfaces, surfaces and extrusions, to be rebuilt by the geometry kernel. */
  breps: { layer: number; data: RhinoBrepData }[]
  /** The file's absolute tolerance, used when joining the faces of polysurfaces. */
  tolerance: number
  /** Objects that could not be read, counted by kind (surfaces, meshes, text, ...). */
  skipped: Map<[string, string], number>
}

/** What a document provides for export. */
export interface RhinoExport {
  units: string
  layers: Layer[]
  objects: { layerId: number; geometry: Geometry }[]
}

type Triple = number[]
const vec = (t: Triple) => new Vector3(t[0], t[1], t[2])
const triple = (v: Vector3): Triple => [v.x, v.y, v.z]

/** Name of a Rhino unit system (e.g. "Millimeters"), from its enum value. */
function unitName(rhino: RhinoModule, value: number): string {
  for (const [name, entry] of Object.entries(rhino.UnitSystem)) {
    if (entry && typeof entry === 'object' && 'value' in entry && (entry as { value: number }).value === value) return name
  }
  return 'Millimeters'
}

function hexColor(c: { r?: number; g?: number; b?: number }): string {
  const hex = (n = 0) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
}

function rgbColor(hex: string): { r: number; g: number; b: number; a: number } {
  const n = parseInt(hex.replace('#', ''), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 }
}

// --- Reading -------------------------------------------------------------------------

/** Rhino leaves out the first and last knot of a clamped knot vector; this puts them back. */
const fullKnots = (knots: number[]) => [knots[0], ...knots, knots[knots.length - 1]]

/** Rhino gives rational control points premultiplied by their weight, as (x·w, y·w, z·w, w). */
function euclidean(p: number[]): { point: number[]; weight: number } {
  const w = p[3] ?? 1
  return { point: [p[0] / w, p[1] / w, p[2] / w], weight: w }
}

function curveData(c: NurbsCurve): NurbsCurveData {
  const points: number[][] = []
  const weights: number[] = []
  for (let i = 0; i < c.points().count; i++) {
    const { point, weight } = euclidean(c.points().get(i))
    points.push(point)
    weights.push(weight)
  }
  const [t0, t1] = c.domain
  const samples: number[][] = []
  for (let i = 0; i <= 32; i++) samples.push(c.pointAt(t0 + ((t1 - t0) * i) / 32))
  return { degree: c.degree, points, weights: c.isRational ? weights : null, knots: fullKnots(c.knots().toList()), samples }
}

function surfaceData(rhino: RhinoModule, surface: InstanceType<RhinoModule['Surface']>): NurbsSurfaceData {
  const s = surface.toNurbsSurface()
  const list = s.points()
  const points: number[][][] = []
  const weights: number[][] = []
  for (let u = 0; u < list.countU; u++) {
    points.push([])
    weights.push([])
    for (let v = 0; v < list.countV; v++) {
      const { point, weight } = euclidean(list.get(u, v))
      points[u].push(point)
      weights[u].push(weight)
    }
  }
  return {
    degreeU: s.orderU - 1,
    degreeV: s.orderV - 1,
    points,
    weights: s.isRational ? weights : null,
    knotsU: fullKnots(s.knotsU().toList()),
    knotsV: fullKnots(s.knotsV().toList()),
  }
}

/** Faces, boundary loops and edges of a polysurface, as plain data. */
function brepData(rhino: RhinoModule, brep: Brep): RhinoBrepData {
  // BrepLoopType exists at runtime but is missing from the package's typings.
  const outer = (rhino as unknown as { BrepLoopType: { Outer: { value: number } } }).BrepLoopType.Outer.value
  const faces: BrepFaceData[] = []
  for (let i = 0; i < brep.faces().count; i++) {
    const face = brep.faces().get(i)
    const loops = []
    for (let l = 0; l < face.loops.count; l++) {
      const loop = face.loops.get(l)
      const trims = []
      for (let t = 0; t < loop.trimCount; t++) {
        const trim = loop.trims.get(t)
        trims.push({ edge: trim.edgeIndex, reversed: trim.isReversed })
      }
      loops.push({ outer: (loop.loopType as unknown as { value: number }).value === outer, trims })
    }
    faces.push({ surface: surfaceData(rhino, face.underlyingSurface()), reversed: face.orientationIsReversed, loops })
  }
  const edges: NurbsCurveData[] = []
  for (let i = 0; i < brep.edges().count; i++) edges.push(curveData(brep.edges().get(i).toNurbsCurve()))
  return { faces, edges, solid: brep.isSolid }
}

/** Polysurface data for breps, extrusions and single surfaces; null for anything else. */
function readBrep(rhino: RhinoModule, g: GeometryBase): RhinoBrepData | null {
  let brep: Brep | null = null
  if (g instanceof rhino.Brep) brep = g
  else if (g instanceof rhino.Extrusion) brep = g.toBrep(false)
  else if (g instanceof rhino.Surface) brep = rhino.Brep.createFromSurface(g)
  if (!brep) return null
  try {
    return brepData(rhino, brep)
  } catch (error) {
    console.warn('Could not read a polysurface', error)
    return null
  }
}

interface RhinoPlane {
  origin: Triple
  xAxis: Triple
  yAxis: Triple
}

function arcFrom(plane: RhinoPlane, radius: number, a0: number, a1: number): AnyCurve {
  const x = vec(plane.xAxis)
  const y = vec(plane.yAxis)
  const center = vec(plane.origin)
  if (a1 - a0 >= Math.PI * 2 - 1e-9) return { type: 'circle', center, xaxis: x, yaxis: y, radius }
  // Our arcs start on their x axis, so rotate the plane to the start angle.
  const xaxis = x.clone().multiplyScalar(Math.cos(a0)).addScaledVector(y, Math.sin(a0))
  const yaxis = y.clone().multiplyScalar(Math.cos(a0)).addScaledVector(x, -Math.sin(a0))
  return { type: 'arc', center, xaxis, yaxis, radius, angle: a1 - a0 }
}

function polylineFrom(points: Vector3[]): AnyCurve | null {
  if (points.length < 2) return null
  const closed = points.length > 3 && points[0].distanceTo(points[points.length - 1]) < 1e-9
  return { type: 'polyline', points: closed ? points.slice(0, -1) : points, closed }
}

/** Converts a Rhino curve, or returns null for a kind of curve that cannot be represented. */
function readCurve(rhino: RhinoModule, c: Curve): AnyCurve | null {
  if (c instanceof rhino.LineCurve) return polylineFrom([vec(c.pointAtStart), vec(c.pointAtEnd)])
  if (c instanceof rhino.PolylineCurve) {
    const pts: Vector3[] = []
    for (let i = 0; i < c.pointCount; i++) pts.push(vec(c.point(i)))
    return polylineFrom(pts)
  }
  if (c instanceof rhino.ArcCurve) {
    const arc = c.arc()
    const [a0, a1] = arc.angleDomain
    return arcFrom(arc.plane as unknown as RhinoPlane, arc.radius, a0, a1)
  }
  if (c instanceof rhino.PolyCurve) {
    const segments: SegmentGeometry[] = []
    for (let i = 0; i < c.segmentCount; i++) {
      const g = readCurve(rhino, c.segmentCurve(i))
      if (!g) return null
      if (g.type === 'polycurve') segments.push(...g.segments)
      else if (g.type === 'circle') return null
      else if (g.type === 'polyline' && g.closed) segments.push({ ...g, points: [...g.points, g.points[0].clone()], closed: false })
      else segments.push(g)
    }
    return chain(segments)
  }
  if (c instanceof rhino.NurbsCurve) {
    // Rhino stores circles and arcs as rational curves; recognize them so they stay exact.
    if (c.isCircle()) {
      const circle = c.tryGetCircle() as unknown as { plane: RhinoPlane; radius: number }
      return arcFrom(circle.plane, circle.radius, 0, Math.PI * 2)
    }
    if (c.isArc()) {
      const arc = c.tryGetArc() as unknown as { plane: RhinoPlane; radius: number; angleDomain: number[] }
      return arcFrom(arc.plane, arc.radius, arc.angleDomain[0], arc.angleDomain[1])
    }
    const count = c.points().count
    const points: Vector3[] = []
    for (let i = 0; i < count; i++) points.push(vec(c.points().get(i)))
    if (!c.isRational) {
      if (c.degree === 1) return polylineFrom(points)
      // Rhino leaves out the first and last knot of a clamped knot vector.
      const knots = c.knots().toList()
      return { type: 'curve', degree: c.degree, points, knots: [knots[0], ...knots, knots[knots.length - 1]] }
    }
    // Other rational curves (ellipses, conics) are fitted with a cubic through points on them.
    const [t0, t1] = c.domain
    const samples = Math.max(32, 16 * c.spanCount)
    const pts: Vector3[] = []
    for (let i = 0; i <= samples; i++) pts.push(vec(c.pointAt(t0 + ((t1 - t0) * i) / samples)))
    return { type: 'curve', ...interpolate(pts, 3) }
  }
  return null
}

/** Singular and plural names of the kinds of objects that are not read yet. */
const KIND_NAMES: Record<string, [string, string]> = {
  Brep: ['polysurface', 'polysurfaces'],
  Extrusion: ['extrusion', 'extrusions'],
  Surface: ['surface', 'surfaces'],
  NurbsSurface: ['surface', 'surfaces'],
  PlaneSurface: ['surface', 'surfaces'],
  RevSurface: ['surface', 'surfaces'],
  SubD: ['SubD object', 'SubD objects'],
  Mesh: ['mesh', 'meshes'],
  Point: ['point', 'points'],
  PointCloud: ['point cloud', 'point clouds'],
  TextDot: ['text dot', 'text dots'],
  InstanceReference: ['block instance', 'block instances'],
  Hatch: ['hatch', 'hatches'],
}
const UNSUPPORTED_CURVE: [string, string] = ['unsupported curve', 'unsupported curves']
const OTHER: [string, string] = ['other object', 'other objects']

export function readRhinoFile(rhino: RhinoModule, bytes: Uint8Array): RhinoImport {
  const file = rhino.File3dm.fromByteArray(bytes)
  if (!file) throw new Error('This is not a valid .3dm file')
  try {
    const units = unitName(rhino, (file.settings().modelUnitSystem as unknown as { value: number }).value)
    const layerTable = file.layers()
    const layers: RhinoImport['layers'] = []
    for (let i = 0; i < layerTable.count; i++) {
      const layer = layerTable.get(i)
      layers.push({
        // Sublayers keep their full path ("Parent::Child") since layers are not nested here.
        name: layer.fullPath || layer.name || `Layer ${i + 1}`,
        color: hexColor(layer.color as { r: number; g: number; b: number }),
        visible: layer.visible,
        locked: layer.locked,
      })
    }

    const objects: RhinoImport['objects'] = []
    const breps: RhinoImport['breps'] = []
    const skipped = new Map<[string, string], number>()
    const skip = (kind: [string, string]) => skipped.set(kind, (skipped.get(kind) ?? 0) + 1)
    const table = file.objects()
    for (let i = 0; i < table.count; i++) {
      const obj = table.get(i)
      const attributes = obj.attributes()
      // Geometry inside block definitions is not placed in the model by itself.
      if (attributes.isInstanceDefinitionObject) continue
      const geometry = obj.geometry()
      const layer = Math.min(Math.max(0, attributes.layerIndex), Math.max(0, layers.length - 1))
      const converted = geometry instanceof rhino.Curve ? readCurve(rhino, geometry) : null
      const brep = converted ? null : readBrep(rhino, geometry)
      if (converted) objects.push({ layer, geometry: converted })
      else if (brep) breps.push({ layer, data: brep })
      else {
        const name = geometry?.constructor?.name ?? 'Unknown'
        skip(geometry instanceof rhino.Curve ? UNSUPPORTED_CURVE : (KIND_NAMES[name] ?? OTHER))
      }
    }
    if (layers.length === 0) layers.push({ name: 'Default', color: '#000000', visible: true, locked: false })
    const tolerance = file.settings().modelAbsoluteTolerance || 0.001
    return { units, layers, objects, breps, tolerance, skipped }
  } finally {
    file.destroy()
  }
}

// --- Writing -------------------------------------------------------------------------

function withPlane<T extends { plane: unknown }>(shape: T, center: Vector3, xaxis: Vector3, yaxis: Vector3): T {
  const plane = shape.plane as RhinoPlane & { zAxis: Triple }
  plane.origin = triple(center)
  plane.xAxis = triple(xaxis)
  plane.yAxis = triple(yaxis)
  plane.zAxis = triple(xaxis.clone().cross(yaxis).normalize())
  shape.plane = plane
  return shape
}

function writeCurve(rhino: RhinoModule, g: AnyCurve): Curve {
  switch (g.type) {
    case 'polyline': {
      if (g.points.length === 2 && !g.closed) return new rhino.LineCurve(triple(g.points[0]), triple(g.points[1]))
      const pts = g.points.map(triple)
      if (g.closed) pts.push(triple(g.points[0]))
      return new rhino.PolylineCurve(pts)
    }
    case 'circle':
      return rhino.ArcCurve.createFromCircle(withPlane(new rhino.Circle(triple(g.center), g.radius), g.center, g.xaxis, g.yaxis))
    case 'arc': {
      const circle = withPlane(new rhino.Circle(triple(g.center), g.radius), g.center, g.xaxis, g.yaxis)
      return rhino.ArcCurve.createFromArc(new rhino.Arc(circle, g.angle))
    }
    case 'curve': {
      const n = g.points.length
      const curve = new rhino.NurbsCurve(3, false, g.degree + 1, n)
      g.knots.slice(1, -1).forEach((k, i) => curve.knots().set(i, k))
      g.points.forEach((p, i) => curve.points().set(i, [p.x, p.y, p.z, 1]))
      return curve
    }
    case 'polycurve': {
      const poly = new rhino.PolyCurve()
      for (const s of g.segments) poly.appendSegment(writeCurve(rhino, s))
      return poly
    }
  }
}

/** A surface or solid as a Rhino mesh of its display triangles (exact breps cannot be written yet). */
function writeMesh(rhino: RhinoModule, g: BrepGeometry): GeometryBase {
  const mesh = new rhino.Mesh()
  const { vertices, triangles } = g.display
  for (let i = 0; i < vertices.length; i += 3) mesh.vertices().add(vertices[i], vertices[i + 1], vertices[i + 2])
  for (let i = 0; i < triangles.length; i += 3) mesh.faces().addTriFace(triangles[i], triangles[i + 1], triangles[i + 2])
  mesh.normals().computeNormals()
  mesh.compact()
  return mesh
}

export function writeRhinoFile(rhino: RhinoModule, model: RhinoExport): Uint8Array {
  const file = new rhino.File3dm()
  try {
    file.applicationName = 'ArchiOpen'
    file.applicationUrl = 'https://github.com/paugavilan8/ArchiOpen'
    const unit = (rhino.UnitSystem as unknown as Record<string, unknown>)[model.units] ?? rhino.UnitSystem.Millimeters
    file.settings().modelUnitSystem = unit as typeof rhino.UnitSystem.Millimeters

    // Names like "Walls::Doors" become nested layers again, so a round trip keeps Rhino's tree.
    const table = file.layers()
    const byPath = new Map<string, number>()
    const addLayer = (path: string, source?: Layer): number => {
      const parts = path.split('::')
      const name = parts.pop()!
      const parentPath = parts.join('::')
      const l = new rhino.Layer()
      l.name = name
      if (parentPath) l.parentLayerId = table.get(byPath.get(parentPath) ?? addLayer(parentPath)).id
      if (source) {
        l.color = rgbColor(source.color)
        l.visible = source.visible
        l.locked = source.locked
      }
      const index = table.add(l)
      byPath.set(path, index)
      return index
    }
    const indexOf = new Map<number, number>()
    // Parents first, so an existing parent layer is used instead of a placeholder.
    const byDepth = [...model.layers].sort((a, b) => a.name.split('::').length - b.name.split('::').length)
    for (const layer of byDepth) indexOf.set(layer.id, byPath.get(layer.name) ?? addLayer(layer.name, layer))
    for (const obj of model.objects) {
      const attributes = new rhino.ObjectAttributes()
      attributes.layerIndex = indexOf.get(obj.layerId) ?? 0
      const g = obj.geometry
      if (g.type === 'annotation') {
        // Texts and dimensions go as their line work.
        for (const points of wireframe(g)) file.objects().add(writeCurve(rhino, { type: 'polyline', points, closed: false }), attributes)
      } else {
        file.objects().add(g.type === 'brep' ? writeMesh(rhino, g) : writeCurve(rhino, g), attributes)
      }
    }
    return file.toByteArray()
  } finally {
    file.destroy()
  }
}

/** Short description of what was skipped, e.g. "3 polysurfaces, 1 mesh". */
export function describeSkipped(skipped: Map<[string, string], number>): string {
  return [...skipped].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(', ')
}
