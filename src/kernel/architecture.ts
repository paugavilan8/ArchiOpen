import { Vector3 } from 'three'
import * as R from 'replicad'
import { openingBox, openingPart, wallOutline, type Opening, type OpeningPart, type ResolvedJoin, type SlabParams, type WallParams } from '../core/architecture'
import { startPoint, tessellate, type AnyCurve } from '../core/geometry'
import { offset } from '../core/offset'
import { railingPieces, type RailingParams } from '../core/railings'
import { roofPlan, stairPlan, type ColumnParams, type Plane, type RoofParams, type RoofPlan, type StairParams } from '../core/buildingParts'
import { boolean, box, extrudeCurve, planarFace } from './brep'
import { closestOn } from './surfaceEdit'
import { edgeToCurve } from './edges'
import { join, length } from '../core/curves'

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

/** The room around a point: the floor region the walls' plan outlines enclose, with its area. */
export interface RoomRegion {
  /** Its boundary loops: the outside one first, then any holes (around columns, say). */
  loops: AnyCurve[]
  area: number
}

/**
 * The room a point is in: a flat region at the point's height, bounded by wall outlines (each wall's
 * outline loops, the outer one and, for a closed wall, its inner one). Fails if the walls do not
 * enclose the point.
 */
/** A flat shape less others in its plane (2D Boolean difference). */
function cutFlat(shape: AnyShape, tools: AnyShape[]): AnyShape {
  const k = R.getOC()
  let current = shape
  for (const tool of tools) {
    const cut = new k.BRepAlgoAPI_Cut(current.wrapped, tool.wrapped)
    cut.Build()
    if (cut.HasErrors()) throw new Error('The room could not be worked out')
    current = R.cast(cut.Shape())
    cut.delete()
  }
  return current
}

export function roomRegion(walls: AnyCurve[][], point: Vector3): RoomRegion {
  const z = point.z
  const flatAt = (c: AnyCurve) => (c.type === 'polyline' ? ({ ...c, points: c.points.map((p) => new Vector3(p.x, p.y, z)) } as AnyCurve) : c)
  const faces = walls.flatMap((loops) => {
    const [outer, ...inner] = loops.map(flatAt)
    const face = planarFace(outer)
    if (!face) return []
    const holes = inner.map(planarFace).filter((f): f is R.Face => f !== null)
    return [holes.length > 0 ? cutFlat(face, holes) : face]
  })
  if (faces.length === 0) throw new Error('There are no walls to bound a room')
  // A floor larger than every wall, less the walls: its pieces are the rooms (and the outside).
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const f of faces) {
    const [[a, b], [c, d]] = f.boundingBox.bounds
    ;[x0, y0, x1, y1] = [Math.min(x0, a, point.x), Math.min(y0, b, point.y), Math.max(x1, c, point.x), Math.max(y1, d, point.y)]
  }
  const m = Math.max(x1 - x0, y1 - y0) * 0.1 + 1
  const floor = planarFace({ type: 'polyline', points: [new Vector3(x0 - m, y0 - m, z), new Vector3(x1 + m, y0 - m, z), new Vector3(x1 + m, y1 + m, z), new Vector3(x0 - m, y1 + m, z)], closed: true })!
  const pieces = cutFlat(floor, faces).faces
  const room = pieces.find((f) => (closestOn(f, point)?.distance ?? Infinity) < 1e-6 * Math.max(1, m))
  if (!room) throw new Error('That point is inside a wall')
  const [[a, b], [c, d]] = room.boundingBox.bounds
  if (a <= x0 - m + 1e-6 || b <= y0 - m + 1e-6 || c >= x1 + m - 1e-6 || d >= y1 + m - 1e-6) throw new Error('The walls do not enclose that point (the room is open)')
  const loops = room.wires.map((w) => join(w.edges.map(edgeToCurve).filter((e): e is AnyCurve => e !== null)).map((j) => j.geometry)).flat()
  // The outside loop first: the longest.
  loops.sort((p, q) => length(q) - length(p))
  return { loops, area: R.measureShapeSurfaceProperties(room as unknown as R.Shape3D).area }
}

/** A flat region: its outer loop less its holes, as a face. */
function regionFace(loops: AnyCurve[]): AnyShape {
  const [outer, ...holes] = loops
  const face = planarFace(outer)
  if (!face) throw new Error('The outline must be closed and flat')
  const cuts = holes.map(planarFace).filter((f): f is R.Face => f !== null)
  return cuts.length > 0 ? cutFlat(face, cuts) : face
}

/** A flat face swept up by a height into a solid. */
function raise(face: AnyShape, height: number): AnyShape {
  const k = R.getOC()
  const vec = new k.gp_Vec(0, 0, height)
  const prism = new k.BRepPrimAPI_MakePrism(face.wrapped, vec, false, true)
  const result = R.cast(prism.Shape())
  prism.delete()
  vec.delete()
  return result
}

/** A floor finish over a room: its outline (less holes round columns) raised by its thickness. */
export function floorShape(loops: AnyCurve[], thickness: number): AnyShape {
  if (!(thickness > 0)) throw new Error('The floor needs a thickness')
  return raise(regionFace(loops), thickness)
}

/**
 * Skirting round a room: a band of a thickness along the inside of its outline (and round its
 * holes), as high as asked, less the given boxes (door openings).
 */
export function skirtingShape(loops: AnyCurve[], height: number, thickness: number, cuts: { origin: Vector3; u: Vector3; v: Vector3; w: Vector3 }[] = []): AnyShape {
  if (!(height > 0) || !(thickness > 0)) throw new Error('The skirting needs a height and a thickness')
  const [outer, ...holes] = loops
  // The room shrunk by the thickness: the outer loop moved in, the holes grown out.
  const inside = (c: AnyCurve) => {
    const pts = tessellate(c)
    const centre = pts.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / pts.length)
    return centre
  }
  const shrunkOuter = offset(outer, thickness, inside(outer), new Vector3(0, 0, 1))
  const grown = holes.map((h) => {
    const box = tessellate(h).reduce((m, p) => m.max(p), new Vector3(-Infinity, -Infinity, -Infinity))
    return offset(h, thickness, box.clone().add(new Vector3(thickness * 100, thickness * 100, 0)), new Vector3(0, 0, 1))
  })
  if (!shrunkOuter || grown.some((g) => !g)) throw new Error('The room is too small for skirting this thick')
  const band = cutFlat(regionFace(loops), [regionFace([shrunkOuter, ...(grown as AnyCurve[])])])
  const solid = raise(band, height)
  const boxes = cuts.map((b) => box(new Vector3(b.origin.x, b.origin.y, b.origin.z), new Vector3(b.u.x, b.u.y, b.u.z), new Vector3(b.v.x, b.v.y, b.v.z), new Vector3(b.w.x, b.w.y, b.w.z)))
  return boxes.length > 0 ? boolean('difference', solid, boxes) : solid
}
