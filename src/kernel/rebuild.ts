import { Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import type { AnyCurve } from '../core/geometry'
import { edgeSurface, networkSurface, patch, pipe, sweep2 } from './advancedSurfaces'
import { extrudeCurve, loftCurves, planarFace, revolveCurve, sweep } from './brep'
import { slabParams, wallParams, type Opening, type OpeningPart, type SavedJoin } from '../core/architecture'
import { columnShape, openingPartShape, roofShape, slabShape, stairShape, wallShape } from './architecture'
import { columnParams, roofParams, stairParams } from '../core/buildingParts'

/**
 * How each command that records history builds its result again from its input curves and
 * parameters. Needs the kernel loaded.
 */

type Params = Record<string, unknown>
const vec = (v: unknown) => new Vector3(...(v as [number, number, number]))
const num = (v: unknown) => Number(v)

export const REBUILDERS: Record<string, (curves: AnyCurve[], p: Params) => AnyShape> = {
  ExtrudeCrv: ([c], p) => extrudeCurve(c, vec(p.direction), !!p.cap),
  Revolve: ([c], p) => revolveCurve(c, vec(p.origin), vec(p.axis), num(p.angle)),
  Loft: (curves) => loftCurves(curves),
  Sweep1: ([profile, rail]) => sweep(profile, rail),
  Sweep2: ([rail1, rail2, ...profiles]) => sweep2(rail1, rail2, profiles),
  Pipe: ([rail], p) => pipe(rail, num(p.start), num(p.end), !!p.cap),
  PlanarSrf: ([c]) => {
    const face = planarFace(c)
    if (!face) throw new Error('The curve is no longer closed and flat')
    return face
  },
  EdgeSrf: (curves) => edgeSurface(curves),
  NetworkSrf: (curves) => networkSurface(curves),
  Patch: (curves) => patch(curves),
  Wall: ([path, ...others], p) => {
    const joins = Array.isArray(p.joins) ? (p.joins as SavedJoin[]) : []
    const resolved = joins
      .filter((j) => others[j.input - 1])
      .map((j) => ({ end: j.end, kind: j.kind, other: { path: others[j.input - 1], params: { thickness: j.thickness, justification: j.justification } } }))
    const roofs = (Array.isArray(p.roofs) ? (p.roofs as (Record<string, unknown> & { input: number })[]) : [])
      .filter((r) => others[r.input - 1])
      .map((r) => ({ outline: others[r.input - 1], params: roofParams(r) }))
    return wallShape(path, wallParams(p), resolved, roofs)
  },
  Slab: ([outline], p) => slabShape(outline, slabParams(p)),
  Roof: ([outline], p) => roofShape(outline, roofParams(p)),
  Stair: ([line], p) => stairShape(line, stairParams(p)),
  Column: ([outline], p) => columnShape(outline, columnParams(p)),
  OpeningPart: ([path], p) => openingPartShape(path, wallParams(p), p.opening as Opening, p.part as OpeningPart),
}

export const triple = (v: Vector3): [number, number, number] => [v.x, v.y, v.z]
