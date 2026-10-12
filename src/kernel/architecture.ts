import { Vector3 } from 'three'
import * as R from 'replicad'
import { openingBox, openingPart, wallOutline, type Opening, type OpeningPart, type ResolvedJoin, type SlabParams, type WallParams } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { boolean, box, extrudeCurve } from './brep'

/** The solids of architectural objects (see core/architecture.ts). Needs the kernel. */

type AnyShape = R.AnyShape

/** A closed flat curve made into a solid by moving it up (or, negative, down) by a height. */
function prism(outline: AnyCurve, height: number): AnyShape {
  const shape = extrudeCurve(outline, new Vector3(0, 0, height), true)
  if (!(shape as R.Shape3D).solids?.length) throw new Error('The outline must be closed and flat')
  return shape
}

/** A wall: its outline raised by its height, with its openings cut out. */
export function wallShape(path: AnyCurve, params: WallParams, joins: ResolvedJoin[] = []): AnyShape {
  if (!(params.height > 0)) throw new Error('The wall height must be positive')
  const [outer, inner] = wallOutline(path, params, joins)
  let wall = prism(outer, params.height)
  // A closed path makes a ring: the inside taken out.
  if (inner) wall = boolean('difference', wall, [prism(inner, params.height)])
  const cuts = params.openings.map((o) => {
    const b = openingBox(path, params, o)
    return box(b.origin, b.u, b.v, b.w)
  })
  return cuts.length > 0 ? boolean('difference', wall, cuts) : wall
}

/** A slab: its outline taken down by its thickness, so its top is where the outline is. */
export function slabShape(outline: AnyCurve, params: SlabParams): AnyShape {
  if (!(params.thickness > 0)) throw new Error('The slab thickness must be positive')
  return prism(outline, -params.thickness)
}

/** A piece of an opening (frame, glass or door leaf). */
export function openingPartShape(path: AnyCurve, params: WallParams, opening: Opening, part: OpeningPart): AnyShape {
  const { add, cut } = openingPart(path, params, opening, part)
  const solid = box(add.origin, add.u, add.v, add.w)
  return cut ? boolean('difference', solid, [box(cut.origin, cut.u, cut.v, cut.w)]) : solid
}
