import { Matrix4 } from 'three'
import * as R from 'replicad'
import { join, transform } from '../core/curves'
import { flatten } from '../core/blocks'
import { wireframe } from '../core/geometry'
import type { AnyCurve, Geometry } from '../core/geometry'
import { curveToWire, meshToShape, shapeOf } from './brep'
import { edgeToCurve } from './edges'

/** STEP unit codes understood by Open CASCADE, by model unit name. */
const STEP_UNITS: Record<string, string> = {
  Microns: 'UM',
  Millimeters: 'MM',
  Centimeters: 'CM',
  Meters: 'M',
  Kilometers: 'KM',
  Inches: 'INCH',
  Feet: 'FT',
  Miles: 'MI',
}

/** Millimeters per unit, for model units that STEP has no code for (they go through millimeters). */
const MILLIMETERS: Record<string, number> = {
  Angstroms: 1e-7,
  Nanometers: 1e-6,
  Decimeters: 100,
  Dekameters: 1e4,
  Hectometers: 1e5,
  Yards: 914.4,
}

/** The STEP unit for a model unit, and the scale from the model to that unit. */
function unitOf(units: string): { code: string; scale: number } {
  if (STEP_UNITS[units]) return { code: STEP_UNITS[units], scale: 1 }
  return { code: 'MM', scale: MILLIMETERS[units] ?? 1 }
}

export interface StepObject {
  geometry: Geometry
  name: string
  /** Hex color, e.g. the layer color. */
  color: string
}

/**
 * Writes objects to a STEP file (AP242): surfaces and solids as exact B-reps, curves as wires, each
 * with a name and a color that other CAD programs show.
 */
export async function writeStep(objects: StepObject[], units: string): Promise<Uint8Array> {
  const { code, scale } = unitOf(units)
  const unit = code as R.SupportedUnit
  const toFile = new Matrix4().makeScale(scale, scale, scale)
  // Blocks go as the objects they draw.
  const shapes = objects.flatMap((o) =>
    flatten(o.geometry).map((g) => ({
      shape: inFileUnits(g, toFile, scale),
      name: o.name,
      color: o.color,
    })),
  )
  const blob = R.exportSTEP(shapes, { unit, modelUnit: unit })
  return new Uint8Array(await blob.arrayBuffer())
}

function inFileUnits(g: Geometry, toFile: Matrix4, scale: number): R.AnyShape {
  const scaled = scale === 1 ? g : transform(g, toFile)
  if (scaled.type === 'annotation') {
    // Texts and dimensions go as their line work.
    return R.makeCompound(wireframe(scaled).map((points) => curveToWire({ type: 'polyline', points, closed: false })))
  }
  // Hatches go as their boundaries.
  if (scaled.type === 'hatch') return R.makeCompound(scaled.loops.map(curveToWire))
  if (scaled.type === 'instance') return R.makeCompound([])
  // Meshes go as faces of flat polygons, sewn together.
  if (scaled.type === 'mesh') return meshToShape(scaled)
  if (scaled.type === 'point') return R.makeVertex([scaled.point.x, scaled.point.y, scaled.point.z])
  return scaled.type === 'brep' ? shapeOf(scaled) : curveToWire(scaled)
}

export interface StepContent {
  /** Each solid on its own, plus one shape for faces that belong to no solid. */
  shapes: R.AnyShape[]
  /** Edges that bound no face, joined into chains where their ends meet. */
  curves: AnyCurve[]
}

/** Reads a STEP file in the given model units. */
export async function readStep(bytes: Uint8Array, units: string): Promise<StepContent> {
  // The reader converts to this global unit, which writing a STEP file also changes.
  const { code, scale } = unitOf(units)
  R.getOC().Interface_Static.SetCVal('xstep.cascade.unit', code)
  const read = await R.importSTEP(new Blob([bytes as BlobPart]))
  const shape = scale === 1 ? read : read.scale(1 / scale, [0, 0, 0])

  const faces = shape.faces
  // Edges of faces are part of those surfaces; the others are curves in their own right. (Read them
  // before the faces go into compounds, which takes them over.)
  const faceEdges = new Map<number, R.Edge[]>()
  for (const face of faces) for (const e of face.edges) faceEdges.set(e.hashCode, [...(faceEdges.get(e.hashCode) ?? []), e])
  const free = shape.edges.filter((e) => !(faceEdges.get(e.hashCode) ?? []).some((f) => f.isSame(e)))
  const pieces = free.map(edgeToCurve).filter((c): c is AnyCurve => c !== null)

  const shapes: R.AnyShape[] = []
  if (faces.length > 0) {
    const solids = (shape as R.Shape3D).solids ?? []
    shapes.push(...solids)
    // Keep faces that belong to no solid, so nothing in the file is dropped.
    const loose = faces.filter((f) => !solids.some((s) => s.faces.some((g) => g.isSame(f))))
    if (solids.length === 0) shapes.push(R.makeCompound(faces))
    else if (loose.length > 0) shapes.push(R.makeCompound(loose))
  }

  return { shapes, curves: join(pieces).map((j) => j.geometry) }
}
