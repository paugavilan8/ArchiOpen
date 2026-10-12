import { Vector3 } from 'three'
import { FRAME, paramAtLength, wallParams, wallSides, type Opening, type WallParams } from './architecture'
import { pointAt, tangentAt, type AnyCurve } from './geometry'

/**
 * Plan symbols of openings, as drawn on architectural plans, at the floor of their wall: a door's
 * leaf, open square to the wall, and the arc it sweeps; a window's frame (a rectangle across the
 * wall) and its glass (a line along it).
 */

export type SymbolPart = 'swing' | 'planFrame' | 'planGlass'

export const OPENING_SYMBOLS: Record<Opening['kind'], SymbolPart[]> = { door: ['swing'], window: ['planFrame', 'planGlass'] }

const UP = new Vector3(0, 0, 1)

export function openingSymbol(path: AnyCurve, params: WallParams, opening: Opening, part: SymbolPart): AnyCurve {
  const t = paramAtLength(path, opening.at)
  const middle = pointAt(path, t)
  const along = tangentAt(path, t)
  along.z = 0
  along.normalize()
  const left = UP.clone().cross(along).normalize()
  const sides = wallSides(params)
  const centre = (sides.left - sides.right) / 2
  const profile = Math.min(FRAME.profile, opening.width / 4, opening.height / 4)
  const at = (u: number, v: number) => middle.clone().addScaledVector(along, u).addScaledVector(left, v)
  const w = opening.width / 2
  if (part === 'swing') {
    // The leaf turns about its hinge, on the face of the wall it opens to.
    const side = opening.swing === 'right' ? -1 : 1
    const face = side > 0 ? sides.left : -sides.right
    const end = opening.hinge === 'end' ? 1 : -1
    const leaf = opening.width - 2 * profile
    const hinge = at(end * (w - profile), face)
    const open = hinge.clone().addScaledVector(left, side * leaf)
    const shut = hinge.clone().addScaledVector(along, -end * leaf)
    const xaxis = open.clone().sub(hinge).normalize()
    const yaxis = shut.clone().sub(hinge).normalize()
    return {
      type: 'polycurve',
      segments: [
        { type: 'polyline', points: [hinge, open], closed: false },
        { type: 'arc', center: hinge, xaxis, yaxis, radius: leaf, angle: Math.PI / 2 },
      ],
    }
  }
  const depth = Math.min(FRAME.depth, params.thickness)
  if (part === 'planFrame') {
    return { type: 'polyline', points: [at(-w, centre - depth / 2), at(w, centre - depth / 2), at(w, centre + depth / 2), at(-w, centre + depth / 2)], closed: true }
  }
  return { type: 'polyline', points: [at(-w + profile, centre), at(w - profile, centre)], closed: false }
}

/** Builds a symbol from its history record (path as the first input). */
export function symbolFromRecord(path: AnyCurve, p: Record<string, unknown>): AnyCurve {
  return openingSymbol(path, wallParams(p), p.opening as Opening, p.part as SymbolPart)
}
