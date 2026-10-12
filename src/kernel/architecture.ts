import { Vector3 } from 'three'
import * as R from 'replicad'
import { openingBox, openingPart, wallOutline, type Opening, type OpeningPart, type ResolvedJoin, type SlabParams, type WallParams } from '../core/architecture'
import type { AnyCurve } from '../core/geometry'
import { roofPlan, stairPlan, type ColumnParams, type RoofParams, type StairParams } from '../core/buildingParts'
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

/** A pitched roof over an outline (see core/buildingParts.ts): the slopes' layer of its thickness. */
export function roofShape(outline: AnyCurve, params: RoofParams): AnyShape {
  const plan = roofPlan(outline, params)
  const k = R.getOC()
  const block = (eaves: AnyCurve, bottom: number, height: number, shift: number) => {
    const lifted = { ...eaves, points: (eaves as { points: Vector3[] }).points.map((p) => new Vector3(p.x, p.y, bottom - shift)) } as AnyCurve
    let solid = prism(lifted, height)
    // Everything above each slope cut away.
    for (const s of plan.slopes) {
      const o = s.origin.clone().addScaledVector(new Vector3(0, 0, 1), -shift)
      const n = s.normal
      const face = new k.BRepBuilderAPI_MakeFace(new k.gp_Pln(new k.gp_Pnt(o.x, o.y, o.z), new k.gp_Dir(n.x, n.y, n.z))).Face()
      const above = new k.BRepPrimAPI_MakeHalfSpace(face, new k.gp_Pnt(o.x + n.x, o.y + n.y, o.z + n.z)).Solid()
      const cut = new k.BRepAlgoAPI_Cut(solid.wrapped, above)
      cut.Build()
      if (cut.HasErrors()) throw new Error('The roof could not be made')
      solid = R.cast(cut.Shape())
      cut.delete()
    }
    return solid
  }
  const height = plan.top - plan.bottom
  const under = block(plan.eaves, plan.bottom, height, 0)
  // The same, lowered by the roof's thickness, taken out of it: a layer under the slopes.
  const lowered = block(plan.eaves, plan.bottom, height + plan.drop, plan.drop)
  return boolean('difference', under, [lowered])
}

/** A straight stair along a line: its side profile swept across its width. */
export function stairShape(line: AnyCurve, params: StairParams): AnyShape {
  const plan = stairPlan(line, params)
  return prism2(plan.profile, plan.across)
}

/** A column: its outline raised by its height. */
export function columnShape(outline: AnyCurve, params: ColumnParams): AnyShape {
  if (!(params.height > 0)) throw new Error('The column height must be positive')
  return prism(outline, params.height)
}

/** A closed flat curve swept along a vector into a solid. */
function prism2(outline: AnyCurve, along: Vector3): AnyShape {
  const shape = extrudeCurve(outline, along, true)
  if (!(shape as R.Shape3D).solids?.length) throw new Error('The profile must be closed and flat')
  return shape
}
