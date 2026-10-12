import { Vector3 } from 'three'
import * as R from 'replicad'
import { arcThrough } from '../core/curves'
import { domain, pointAt, type AnyCurve } from '../core/geometry'
import { joinShapes, loftSurface } from './brep'
import { closestOn, intersectionCurves, nearestPiece, offsetSurface, splitShape } from './surfaceEdit'

/**
 * FilletSrf: a constant-radius fillet between two faces, as a ball of that radius rolling while it
 * touches both. The ball's centre runs along where the two faces, offset by the radius towards each
 * other, meet; at each place the fillet's section is the arc between the two points it touches.
 * The faces are extended for this, so faces that do not meet (or meet beyond their edges) can be
 * filleted too, and the fillet is then kept to where it touches both faces as they are.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()
const v3 = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z)

/** A face rebuilt on its surface over a wider parameter range, as far as the surface allows. */
function extendedFace(face: R.Face, margin: number): R.Face {
  const k = oc()
  const f = k.TopoDS.Face(face.wrapped)
  const adaptor = new k.BRepAdaptor_Surface(f, true)
  const b = k.BRepTools.UVBounds(f)
  const range = (lo: number, hi: number, first: number, last: number, periodic: boolean, period: number) => {
    const grow = Math.max((hi - lo) * 0.5, margin)
    if (periodic && hi - lo + 2 * grow >= period) return [lo, lo + period]
    return [Math.max(first, lo - grow), Math.min(last, hi + grow)]
  }
  const [u0, u1] = range(b.UMin, b.UMax, adaptor.FirstUParameter(), adaptor.LastUParameter(), adaptor.IsUPeriodic(), adaptor.IsUPeriodic() ? adaptor.UPeriod() : 0)
  const [v0, v1] = range(b.VMin, b.VMax, adaptor.FirstVParameter(), adaptor.LastVParameter(), adaptor.IsVPeriodic(), adaptor.IsVPeriodic() ? adaptor.VPeriod() : 0)
  adaptor.delete()
  const made = new k.BRepBuilderAPI_MakeFace(k.BRep_Tool.Surface(f), u0, u1, v0, v1, 1e-7).Face()
  const reversed = f.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED
  return R.cast(reversed ? made.Reversed() : made) as R.Face
}

export interface FilletResult {
  fillet: AnyShape
  /** The two shapes trimmed back to the fillet (when asked), in the order given. */
  trimmed: AnyShape[] | null
}

/**
 * Fillets face `faceA` of `a` and `faceB` of `b` with a radius. `pickA` and `pickB` are points on
 * the faces on the sides to keep: the fillet lies between them. With `trim`, the two shapes are
 * cut back to where the fillet touches them (other faces of a polysurface are kept).
 */
export function filletSurfaces(a: AnyShape, faceA: number, pickA: Vector3, b: AnyShape, faceB: number, pickB: Vector3, radius: number, trim: boolean): FilletResult {
  const fa = a.faces[faceA]
  const fb = b.faces[faceB]
  if (!fa || !fb) throw new Error('There is no such face')
  if (!(radius > 0)) throw new Error('The radius must be positive')
  const pa = closestOn(fa, pickA)?.point ?? pickA
  const pb = closestOn(fb, pickB)?.point ?? pickB
  const na = v3(fa.normalAt(pa.toArray() as [number, number, number]))
  const nb = v3(fb.normalAt(pb.toArray() as [number, number, number]))
  // Each face is offset towards the other's kept side.
  const sa = Math.sign(na.dot(pb.clone().sub(pa))) || 1
  const sb = Math.sign(nb.dot(pa.clone().sub(pb))) || 1
  const size = Math.max(pa.distanceTo(pb), radius) * 4
  const ea = extendedFace(fa, size)
  const eb = extendedFace(fb, size)
  const spines = intersectionCurves(offsetSurface(ea, sa * radius, false), offsetSurface(eb, sb * radius, false))
  if (spines.length === 0) throw new Error('No fillet of that radius fits between the surfaces')
  // The centre line nearest the picked places.
  const middle = pa.clone().add(pb).multiplyScalar(0.5)
  const nearness = (c: AnyCurve) => {
    const [t0, t1] = domain(c)
    let best = Infinity
    for (let i = 0; i <= 32; i++) best = Math.min(best, pointAt(c, t0 + ((t1 - t0) * i) / 32).distanceTo(middle))
    return best
  }
  const spine = spines.reduce((best, c) => (nearness(c) < nearness(best) ? c : best))

  // Where the ball touches both faces as they are (not only their extensions).
  const tolerance = Math.max(radius, size) * 1e-6
  const touches = (t: number) => {
    const c = pointAt(spine, t)
    return [fa, fb].every((f) => {
      const hit = closestOn(f, c)
      return !!hit && Math.abs(hit.distance - radius) < Math.max(tolerance, radius * 1e-4)
    })
  }
  const [t0, t1] = domain(spine)
  const steps = 160
  const at = (i: number) => t0 + ((t1 - t0) * i) / steps
  let first = -1
  let last = -1
  for (let i = 0; i <= steps; i++) {
    if (!touches(at(i))) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) throw new Error('No fillet of that radius fits between the surfaces')
  // The ends refined to where the touching stops.
  const edge = (inside: number, outside: number) => {
    let [lo, hi] = [inside, outside]
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (touches(mid)) lo = mid
      else hi = mid
    }
    return lo
  }
  const start = first > 0 ? edge(at(first), at(first - 1)) : t0
  const end = last < steps ? edge(at(last), at(last + 1)) : t1
  if (end - start < 1e-9) throw new Error('No fillet of that radius fits between the surfaces')

  const count = 24
  const arcs: AnyCurve[] = []
  const contactsA: Vector3[] = []
  const contactsB: Vector3[] = []
  const centres: Vector3[] = []
  for (let i = 0; i <= count; i++) {
    const c = pointAt(spine, start + ((end - start) * i) / count)
    const p = closestOn(ea, c)!.point
    const q = closestOn(eb, c)!.point
    const through = p.clone().sub(c).add(q.clone().sub(c))
    if (through.length() < 1e-9) throw new Error('The surfaces are parallel there')
    const arc = arcThrough(p, c.clone().addScaledVector(through.normalize(), radius), q)
    if (!arc) throw new Error('The surfaces are tangent there')
    arcs.push(arc)
    contactsA.push(p)
    contactsB.push(q)
    centres.push(c)
  }
  const fillet = loftSurface(arcs)
  if (!trim) return { fillet, trimmed: null }

  // Each face is cut along where the fillet touches it, by the surface swept from the ball's centre
  // through the contact and beyond (across the face), and the part on the picked side kept.
  const cutBack = (shape: AnyShape, face: R.Face, index: number, contacts: Vector3[], pick: Vector3) => {
    const cutter = loftSurface(
      contacts.map((p, i) => ({ type: 'polyline', points: [centres[i].clone(), centres[i].clone().add(p.clone().sub(centres[i]).multiplyScalar(2))], closed: false })),
    )
    // Past the ends of the fillet the cutter goes on along the contact line, so it cuts across
    // (a fillet all the way round, as at the foot of a column, has no ends).
    const closed = contacts[0].distanceTo(contacts[contacts.length - 1]) < tolerance * 10
    const pieces = splitShape(face, [closed ? cutter : extendCutter(cutter, contacts, centres, size)])
    const kept = pieces.length > 1 ? pieces[nearestPiece(pieces, pick)] : face
    const faces = shape.faces
    if (faces.length === 1) return kept
    return joinShapes(faces.map((f, i) => (i === index ? kept : f)))
  }
  return { fillet, trimmed: [cutBack(a, fa, faceA, contactsA, pa), cutBack(b, fb, faceB, contactsB, pb)] }
}

/**
 * The cutter for one face lengthened at both ends, along the contact curve's end directions, so that
 * it reaches across the face's edges there.
 */
function extendCutter(cutter: AnyShape, contacts: Vector3[], centres: Vector3[], reach: number): AnyShape {
  const n = contacts.length - 1
  const section = (c: Vector3, p: Vector3): AnyCurve => ({ type: 'polyline', points: [c.clone(), c.clone().add(p.clone().sub(c).multiplyScalar(2))], closed: false })
  const beyond = (i: number, j: number) => {
    const d = contacts[i].clone().sub(contacts[j]).normalize().multiplyScalar(reach)
    return section(centres[i].clone().add(d), contacts[i].clone().add(d))
  }
  const ends = [loftSurface([beyond(0, 1), section(centres[0], contacts[0])]), loftSurface([section(centres[n], contacts[n]), beyond(n, n - 1)])]
  return joinShapes([cutter, ...ends])
}

