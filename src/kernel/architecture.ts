import { Vector3 } from 'three'
import * as R from 'replicad'
import { openingBox, openingPart, wallOutline, type Opening, type OpeningPart, type ResolvedJoin, type SlabParams, type WallParams } from '../core/architecture'
import { startPoint, type AnyCurve } from '../core/geometry'
import { railingPieces, type RailingParams } from '../core/railings'
import { roofPlan, stairPlan, type ColumnParams, type Plane, type RoofParams, type RoofPlan, type StairParams } from '../core/buildingParts'
import { boolean, box, extrudeCurve } from './brep'

/** The solids of architectural objects (see core/architecture.ts). Needs the kernel. */

type AnyShape = R.AnyShape

/** A closed flat curve made into a solid by moving it up (or, negative, down) by a height. */
function prism(outline: AnyCurve, height: number): AnyShape {
  const shape = extrudeCurve(outline, new Vector3(0, 0, height), true)
  if (!(shape as R.Shape3D).solids?.length) throw new Error('The outline must be closed and flat')
  return shape
}

/** A roof a wall reaches up to: its outline and parameters. */
export interface RoofOver {
  outline: AnyCurve
  params: RoofParams
}

/** A wall: its outline raised by its height (or to the roofs over it), with its openings cut out. */
export function wallShape(path: AnyCurve, params: WallParams, joins: ResolvedJoin[] = [], roofs: RoofOver[] = []): AnyShape {
  if (!(params.height > 0)) throw new Error('The wall height must be positive')
  const outline = wallOutline(path, params, joins)
  const [outer, inner] = outline
  let wall = prism(outer, params.height)
  // A closed path makes a ring: the inside taken out.
  if (inner) wall = boolean('difference', wall, [prism(inner, params.height)])
  // Up to the underside of the roofs over it, where that is higher (gables, inner walls).
  const base = startPoint(path).z
  for (const roof of roofs) wall = boolean('union', wall, [raisedTo(outline, base, roofPlan(roof.outline, roof.params))])
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

/**
 * What lies over a closed flat outline, from one height to another, and under every slope (raised
 * by `raise`): the slopes' planes cut the top.
 */
function underSlopes(outline: AnyCurve, bottom: number, top: number, slopes: readonly Plane[], raise: number): AnyShape {
  const k = R.getOC()
  const pts = (outline as { points: Vector3[] }).points
  const lifted = outline.type === 'polyline' ? ({ ...outline, points: pts.map((p) => new Vector3(p.x, p.y, bottom)) } as AnyCurve) : outline
  let solid = prism(lifted, top - bottom)
  for (const s of slopes) {
    const o = s.origin.clone().addScaledVector(new Vector3(0, 0, 1), raise)
    const n = s.normal
    const face = new k.BRepBuilderAPI_MakeFace(new k.gp_Pln(new k.gp_Pnt(o.x, o.y, o.z), new k.gp_Dir(n.x, n.y, n.z))).Face()
    const above = new k.BRepPrimAPI_MakeHalfSpace(face, new k.gp_Pnt(o.x + n.x, o.y + n.y, o.z + n.z)).Solid()
    const cut = new k.BRepAlgoAPI_Cut(solid.wrapped, above)
    cut.Build()
    if (cut.HasErrors()) throw new Error('The cut under the roof failed')
    solid = R.cast(cut.Shape())
    cut.delete()
  }
  return solid
}

/**
 * A pitched roof over an outline (see core/buildingParts.ts): a layer of its thickness whose
 * underside is the slopes, so it rests on walls whose tops are at the outline.
 */
export function roofShape(outline: AnyCurve, params: RoofParams): AnyShape {
  const plan = roofPlan(outline, params)
  // Over (and under) the union of the parts' slopes: where parts overlap, the higher one wins.
  const fused = (raise: number, bottom: number) => {
    const parts = plan.pieces.map((p) => underSlopes(p.eaves, bottom, plan.top, p.slopes, raise))
    return parts.length === 1 ? parts[0] : boolean('union', parts[0], parts.slice(1))
  }
  return boolean('difference', fused(plan.drop, plan.bottom), [fused(0, plan.bottom - 1)])
}

/** A wall raised to the underside of a roof over it (where that is higher than the wall). */
function raisedTo(outline: AnyCurve[], base: number, roof: RoofPlan): AnyShape {
  const [outer, inner] = outline
  const lifted = (c: AnyCurve, z: number) => (c.type === 'polyline' ? ({ ...c, points: c.points.map((p) => new Vector3(p.x, p.y, z)) } as AnyCurve) : c)
  const parts = roof.pieces.map((piece) => {
    let raised = underSlopes(lifted(outer, base), base, roof.top, piece.slopes, 0)
    // Only under this part of the roof (a gable part does not slope at its ends).
    raised = boolean('intersection', raised, [underSlopes(piece.eaves, base - 1, roof.top + 1, [], 0)])
    return raised
  })
  let raised = parts.length === 1 ? parts[0] : boolean('union', parts[0], parts.slice(1))
  if (inner) raised = boolean('difference', raised, [underSlopes(lifted(inner, base - 1), base - 1, roof.top + 1, [], 0)])
  return raised
}

/** A stair: its flights' profiles swept across its width, and its landings. */
export function stairShape(line: AnyCurve, params: StairParams): AnyShape {
  const plan = stairPlan(line, params)
  const parts = [...plan.flights.map((f) => prism2(f.profile, f.across)), ...plan.landings.map((l) => box(l.origin, l.u, l.v, l.w))]
  return parts.length === 1 ? parts[0] : boolean('union', parts[0], parts.slice(1))
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

/** A railing: its pieces along each of its lines, kept together. */
export function railingShape(lines: Vector3[][], params: RailingParams): AnyShape {
  const solids = lines.flatMap((l) => railingPieces(l, params)).map((b) => box(b.origin, b.u, b.v, b.w) as R.Shape3D)
  if (solids.length === 0) throw new Error('The railing has no length')
  return R.makeCompound(solids)
}
