import type { Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { blendSurface, edgeSurface, networkSurface, patch, pipe, surfaceFromPoints, sweep2 } from './advancedSurfaces'
import {
  boolean,
  box,
  cylinder,
  explodeShape,
  extrudeCurve,
  filletEdges,
  chamferEdges,
  joinShapes,
  loftCurves,
  loftSurface,
  meshToShape,
  planarFace,
  revolveCurve,
  sectionCurves,
  shapeOf,
  shapeToMesh,
  shellSolid,
  sphere,
  sweep,
  toBrep,
} from './brep'
import { shapeFromRhino } from './fromRhino'
import { make2DWithMeshes } from './make2d'
import { unrollShape } from './unroll'
import { checkShape, shapeArea, shapeBounds, shapeVolume } from './measure'
import { REBUILDERS } from './rebuild'
import { readStep, writeStep } from './step'
import {
  borderCurves,
  capHoles,
  curveCutter,
  edgeCurves,
  extractFaces,
  extrudeSurface,
  intersectionCurves,
  nearestPiece,
  offsetSurface,
  projectCurves,
  pullCurve,
  splitShape,
  untrim,
} from './surfaceEdit'
import { exactRhinoBrep } from './toRhino'
import { inArena } from './arena'
import { decode, encode, isShapeRef } from './wire'

/**
 * The jobs the kernel worker runs: kernel operations by name. Arguments that are kernel shapes come
 * from the app as shape references (see wire.ts) and are loaded here; shapes in a job's result go
 * back as document geometry. A few jobs chain several operations so the shapes in between never
 * have to leave the worker.
 */

/** The shapes that cut a target: curves seen along `direction` as surfaces, and surfaces and solids. */
function cuttersFor(target: AnyShape, curves: AnyCurve[], shapes: AnyShape[], direction: Vector3): AnyShape[] {
  return [...curves.map((c) => curveCutter(c, direction, [target])), ...shapes]
}

export const api = {
  box,
  cylinder,
  sphere,
  extrudeCurve,
  revolveCurve,
  loftCurves,
  loftSurface,
  sweep,
  planarFace,
  boolean,
  filletEdges,
  chamferEdges,
  shellSolid,
  joinShapes,
  explodeShape,
  /** The shape as it is, with its face data (for breps saved before faces were tracked). */
  faces: (shape: AnyShape) => shape,
  /** Section curves of a shape through each plane, loading the shape once. */
  sections: (shape: AnyShape, planes: { origin: Vector3; normal: Vector3 }[]) => planes.map((p) => sectionCurves(shape, p.origin, p.normal)),
  /** The pieces of a target cut by curves (along `direction`) and shapes, or null if nothing cuts it. */
  split: (target: AnyShape, curves: AnyCurve[], shapes: AnyShape[], direction: Vector3): AnyShape[] | null => {
    const cutters = cuttersFor(target, curves, shapes, direction)
    return cutters.length === 0 ? null : splitShape(target, cutters)
  },
  /** Like split, with the index of the piece nearest to `at` (the one a trim removes). */
  trim: (target: AnyShape, at: Vector3, curves: AnyCurve[], shapes: AnyShape[], direction: Vector3): { pieces: AnyShape[]; nearest: number } | null => {
    const cutters = cuttersFor(target, curves, shapes, direction)
    if (cutters.length === 0) return null
    const pieces = splitShape(target, cutters)
    return { pieces, nearest: pieces.length < 2 ? -1 : nearestPiece(pieces, at) }
  },
  capHoles,
  offsetSurface,
  extrudeSurface,
  projectCurves,
  pullCurve,
  intersectionCurves,
  extractFaces,
  untrim,
  borderCurves,
  edgeCurves,
  sweep2,
  networkSurface,
  patch,
  edgeSurface,
  surfaceFromPoints,
  blendSurface,
  pipe,
  shapeArea,
  shapeVolume,
  shapeBounds,
  checkShape,
  shapeToMesh,
  meshToShape,
  make2DWithMeshes,
  unrollShape,
  /** Makes again an object recorded with construction history, from its input curves. */
  rebuild: (command: string, curves: AnyCurve[], params: Record<string, unknown>) => {
    const make = REBUILDERS[command]
    if (!make) throw new Error(`No history for ${command}`)
    return make(curves, params)
  },
  shapeFromRhino,
  readStep,
  writeStep,
  /** The openNURBS bytes of each surface or solid, or null for those with no exact form. */
  exactRhinoBreps: (breps: BrepGeometry[]) => breps.map(exactRhinoBrep),
}

export type KernelApi = typeof api

/** A kernel shape, by what it can do (the classes differ for faces, shells, solids, ...). */
const isShape = (value: unknown): value is AnyShape =>
  typeof value === 'object' && value !== null && 'wrapped' in value && typeof (value as { mesh?: unknown }).mesh === 'function'

/** Runs a job on arguments as they came from the app; the result is ready to go back. */
export function runJob(name: string, args: unknown[]): Promise<unknown> {
  const job = (api as Record<string, (...a: unknown[]) => unknown>)[name]
  if (!job) return Promise.reject(new Error(`Unknown kernel job: ${name}`))
  // Everything the job makes in the kernel is freed once its result is plain data.
  return inArena(async () => {
    const input = args.map((a) => decode(a, (v) => (isShapeRef(v) ? shapeOf({ ...v.$shape } as BrepGeometry) : v)))
    const result = await job(...input)
    return encode(result, (v) => (isShape(v) ? toBrep(v) : v))
  })
}
