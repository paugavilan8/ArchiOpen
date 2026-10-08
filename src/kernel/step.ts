import { Matrix4 } from 'three'
import * as R from 'replicad'
import { transform } from '../core/curves'
import type { Geometry } from '../core/geometry'
import { curveToWire, shapeOf } from './brep'

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
  const shapes = objects.map((o) => ({
    shape: inFileUnits(o.geometry, toFile, scale),
    name: o.name,
    color: o.color,
  }))
  const blob = R.exportSTEP(shapes, { unit, modelUnit: unit })
  return new Uint8Array(await blob.arrayBuffer())
}

function inFileUnits(g: Geometry, toFile: Matrix4, scale: number): R.AnyShape {
  const scaled = scale === 1 ? g : transform(g, toFile)
  return scaled.type === 'brep' ? shapeOf(scaled) : curveToWire(scaled)
}

/**
 * Reads a STEP file in the given model units. Each solid becomes its own shape; anything that is not
 * part of a solid (open surfaces, loose curves) comes as one more shape.
 */
export async function readStep(bytes: Uint8Array, units: string): Promise<R.AnyShape[]> {
  // The reader converts to this global unit, which writing a STEP file also changes.
  const { code, scale } = unitOf(units)
  R.getOC().Interface_Static.SetCVal('xstep.cascade.unit', code)
  const read = await R.importSTEP(new Blob([bytes as BlobPart]))
  const shape = scale === 1 ? read : read.scale(1 / scale, [0, 0, 0])
  const solids = (shape as R.Shape3D).solids ?? []
  if (solids.length === 0) return [shape]
  const solidFaces = solids.reduce((n, s) => n + s.faces.length, 0)
  if (solidFaces === shape.faces.length) return solids
  // Keep faces that belong to no solid, so nothing in the file is dropped.
  const loose = shape.faces.filter((f) => !solids.some((s) => s.faces.some((g) => g.isSame(f))))
  return loose.length > 0 ? [...solids, R.makeCompound(loose)] : solids
}
