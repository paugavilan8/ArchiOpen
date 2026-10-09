import { Vector3 } from 'three'
import * as R from 'replicad'
import { join, length, reverse } from '../core/curves'
import { alongCurve } from '../core/curveTools'
import { AnyCurve, endPoint, isClosed, startPoint, TOLERANCE } from '../core/geometry'
import { intersect } from '../core/intersect'
import { curveToEdges, curveToWire } from './brep'
import { closestOn } from './surfaceEdit'

/**
 * Surfaces from networks of curves: two-rail sweeps, patches, edge surfaces, blends and pipes.
 * Everything here needs the kernel loaded.
 */

type AnyShape = R.AnyShape
const oc = () => R.getOC()
const v3 = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z)

/** A B-spline surface passing through a grid of points (rows × columns), as a face. */
export function gridSurface(grid: Vector3[][]): R.Face {
  const k = oc()
  const rows = grid.length
  const cols = grid[0].length
  const points = new k.NCollection_Array2_gp_Pnt(1, rows, 1, cols)
  grid.forEach((row, i) =>
    row.forEach((p, j) => {
      const q = new k.gp_Pnt(p.x, p.y, p.z)
      points.SetValue(i + 1, j + 1, q)
      q.delete()
    }),
  )
  const fit = new k.GeomAPI_PointsToBSplineSurface()
  try {
    fit.Interpolate(points, false)
    if (!fit.IsDone()) throw new Error('Could not fit a surface through the points')
    const maker = new k.BRepBuilderAPI_MakeFace(fit.Surface(), 1e-7)
    const face = new R.Face(maker.Face())
    maker.delete()
    return face
  } finally {
    fit.delete()
    points.delete()
  }
}

/** Size of a set of curves, for tolerances. */
function sizeOf(curves: AnyCurve[]): number {
  let size = 0
  for (const c of curves) {
    const a = startPoint(c)
    for (const other of curves) size = Math.max(size, a.distanceTo(startPoint(other)), a.distanceTo(endPoint(other)))
  }
  return Math.max(size, 1e-6)
}

// --- Sweep along two rails ------------------------------------------------------------------

/** The frame a profile hangs in between the rails: x from rail 1 to rail 2, z along the rails. */
function railFrame(a: Vector3, b: Vector3, ta: Vector3, tb: Vector3) {
  const width = a.distanceTo(b)
  const x = b.clone().sub(a).normalize()
  const along = ta.clone().add(tb)
  const z = along.addScaledVector(x, -along.dot(x)).normalize()
  const y = z.clone().cross(x)
  return { origin: a, width, x, y, z }
}

/**
 * Sweeps profiles along two rails: each profile is moved, turned and scaled so its ends follow the
 * rails, and between profiles their shapes are blended. Profiles must run from one rail to the other.
 */
export function sweep2(rail1: AnyCurve, rail2In: AnyCurve, profiles: AnyCurve[], stations = 40, samplesPerProfile = 24): R.Face {
  if (profiles.length === 0) throw new Error('Select at least one profile')
  // The rails must run the same way.
  const s1 = startPoint(rail1)
  const e1 = endPoint(rail1)
  const rail2 =
    s1.distanceTo(endPoint(rail2In)) + e1.distanceTo(startPoint(rail2In)) < s1.distanceTo(startPoint(rail2In)) + e1.distanceTo(endPoint(rail2In)) ? reverse(rail2In) : rail2In
  const dense = 400
  const r1 = alongCurve(rail1, dense)
  const r2 = alongCurve(rail2, dense)
  const frameAt = (i: number) => railFrame(r1.points[i], r2.points[i], r1.tangents[i], r2.tangents[i])

  // Each profile in its own rail frame, at the fraction of the rails where it stands.
  const placed = profiles.map((profile) => {
    let p = profile
    // Run from rail 1 to rail 2.
    const nearest = (q: Vector3, pts: Vector3[]) => pts.reduce((best, x, i) => (x.distanceTo(q) < pts[best].distanceTo(q) ? i : best), 0)
    const startOn1 = r1.points[nearest(startPoint(p), r1.points)].distanceTo(startPoint(p))
    const endOn1 = r1.points[nearest(endPoint(p), r1.points)].distanceTo(endPoint(p))
    if (endOn1 < startOn1) p = reverse(p)
    const station = nearest(startPoint(p), r1.points)
    const frame = frameAt(station)
    if (frame.width < 1e-9) throw new Error('The rails touch where a profile stands')
    const local = alongCurve(p, samplesPerProfile).points.map((q) => {
      const d = q.clone().sub(frame.origin).divideScalar(frame.width)
      return new Vector3(d.dot(frame.x), d.dot(frame.y), d.dot(frame.z))
    })
    return { fraction: station / (dense - 1), local }
  })
  placed.sort((a, b) => a.fraction - b.fraction)

  const grid: Vector3[][] = []
  for (let s = 0; s < stations; s++) {
    const fraction = s / (stations - 1)
    const frame = frameAt(Math.round(fraction * (dense - 1)))
    // Blend the two profiles either side (or use the nearest one past the ends).
    let k = placed.findIndex((p) => p.fraction > fraction)
    if (k === -1) k = placed.length
    const before = placed[Math.max(0, k - 1)]
    const after = placed[Math.min(placed.length - 1, k)]
    const f = after === before || after.fraction === before.fraction ? 0 : Math.min(1, Math.max(0, (fraction - before.fraction) / (after.fraction - before.fraction)))
    grid.push(
      before.local.map((l, j) => {
        const m = l.clone().lerp(after.local[j], f)
        return frame.origin
          .clone()
          .addScaledVector(frame.x, m.x * frame.width)
          .addScaledVector(frame.y, m.y * frame.width)
          .addScaledVector(frame.z, m.z * frame.width)
      }),
    )
  }
  return gridSurface(grid)
}

// --- Patches from curves ----------------------------------------------------------------------

/**
 * A smooth surface fitted to boundary curves (which must close a loop) and, optionally, curves it
 * should pass through inside.
 */
export function fillSurface(boundary: AnyCurve[], inside: AnyCurve[] = []): AnyShape {
  const k = oc()
  const size = sizeOf([...boundary, ...inside])
  const maker = new k.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, size * 1e-5, 0.01, 0.1, 8, 9)
  try {
    for (const curve of boundary) for (const edge of curveToEdges(curve)) maker.Add(edge.wrapped, k.GeomAbs_Shape.GeomAbs_C0, true)
    for (const curve of inside) for (const edge of curveToEdges(curve)) maker.Add(edge.wrapped, k.GeomAbs_Shape.GeomAbs_C0, false)
    maker.Build()
    if (!maker.IsDone()) throw new Error('Could not fit a surface to these curves')
    return R.cast(maker.Shape())
  } finally {
    maker.delete()
  }
}

/** The curves that close a loop (the longest such loop), and the rest. */
export function splitBoundary(curves: AnyCurve[]): { boundary: AnyCurve[]; inside: AnyCurve[] } | null {
  // A curve closed by itself is the boundary (curves inside may touch it, which would chain them).
  const closed = curves.map((c, i) => ({ c, i, size: length(c) })).filter(({ c }) => isClosed(c))
  if (closed.length > 0) {
    const outer = closed.reduce((a, b) => (a.size >= b.size ? a : b))
    return { boundary: [outer.c], inside: curves.filter((_, i) => i !== outer.i) }
  }
  const chains = join(curves).filter((c) => isClosed(c.geometry))
  if (chains.length === 0) return null
  const loop = chains.reduce((a, b) => (a.used.length >= b.used.length ? a : b))
  return { boundary: loop.used.map((i) => curves[i]), inside: curves.filter((_, i) => !loop.used.includes(i)) }
}

/** Patch: a surface over a closed boundary that also follows any curves inside it. */
export function patch(curves: AnyCurve[]): AnyShape {
  const split = splitBoundary(curves)
  if (!split) throw new Error('The curves must close a boundary')
  return fillSurface(split.boundary, split.inside)
}

/** A surface from two, three or four edge curves. Two curves are joined by straight lines. */
export function edgeSurface(curves: AnyCurve[]): AnyShape {
  if (curves.length < 2 || curves.length > 4) throw new Error('Select two, three or four curves')
  if (curves.length === 2) {
    const [a, b0] = curves
    // Same direction, so the rulings do not cross.
    const b =
      startPoint(a).distanceTo(endPoint(b0)) + endPoint(a).distanceTo(startPoint(b0)) < startPoint(a).distanceTo(startPoint(b0)) + endPoint(a).distanceTo(endPoint(b0))
        ? reverse(b0)
        : b0
    return R.loft([curveToWire(a), curveToWire(b)], { ruled: true })
  }
  if (!splitBoundary(curves) || splitBoundary(curves)!.inside.length > 0) throw new Error('The curves must meet end to end and close a loop')
  return fillSurface(curves)
}

/**
 * NetworkSrf: curves in two directions, each crossing the other direction's. The outermost curve of
 * each side bounds the surface; the others shape it.
 */
export function networkSurface(curves: AnyCurve[]): AnyShape {
  if (curves.length < 4) throw new Error('Select at least two curves in each direction')
  // Curves that cross go in opposite directions.
  const crosses = curves.map((a, i) => curves.map((b, j) => i !== j && intersect(a, b).length > 0))
  const family = new Array<number>(curves.length).fill(-1)
  for (let start = 0; start < curves.length; start++) {
    if (family[start] !== -1) continue
    family[start] = 0
    const queue = [start]
    while (queue.length) {
      const i = queue.pop()!
      for (let j = 0; j < curves.length; j++) {
        if (!crosses[i][j]) continue
        if (family[j] === -1) {
          family[j] = 1 - family[i]
          queue.push(j)
        } else if (family[j] === family[i]) throw new Error('Curves of the same direction must not cross each other')
      }
    }
  }
  const u = curves.filter((_, i) => family[i] === 0)
  const v = curves.filter((_, i) => family[i] === 1)
  if (u.length < 2 || v.length < 2) throw new Error('Each direction needs at least two curves that cross the other direction')
  // Order each family by where it crosses one curve of the other.
  const order = (fam: AnyCurve[], across: AnyCurve) =>
    fam
      .map((c) => ({ c, t: intersect(across, c)[0]?.ta ?? Infinity }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.c)
  const us = order(u, v[0])
  const vs = order(v, u[0])
  const boundary = [us[0], us[us.length - 1], vs[0], vs[vs.length - 1]]
  try {
    return fillSurface(boundary, [...us.slice(1, -1), ...vs.slice(1, -1)])
  } catch {
    throw new Error('Could not build the surface: the outermost curves must meet at their ends')
  }
}

/** A surface through three or four corner points: flat when they are, else a bilinear patch. */
export function surfaceFromPoints(points: Vector3[]): AnyShape {
  if (points.length === 3) return R.makePolygon(points.map((p) => [p.x, p.y, p.z]))
  const [a, b, c, d] = points
  const n = b.clone().sub(a).cross(c.clone().sub(a))
  const size = Math.max(a.distanceTo(c), b.distanceTo(d))
  if (Math.abs(d.clone().sub(a).dot(n.normalize())) < size * 1e-9) return R.makePolygon(points.map((p) => [p.x, p.y, p.z]))
  return gridSurface([
    [a, b],
    [d, c],
  ])
}

// --- Pipes ------------------------------------------------------------------------------------

/** Circle of radius r around p, square to the direction t. */
function ringAt(p: Vector3, t: Vector3, r: number): AnyCurve {
  const helper = Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)
  const x = helper.clone().cross(t).normalize()
  const y = t.clone().cross(x).normalize()
  return { type: 'circle', center: p.clone(), xaxis: x, yaxis: y, radius: r }
}

/**
 * A round pipe along a curve, from `startRadius` to `endRadius`; capped ends make it a solid. The
 * radius changes linearly along the curve.
 */
export function pipe(rail: AnyCurve, startRadius: number, endRadius: number, cap: boolean): AnyShape {
  if (startRadius <= 0 || endRadius <= 0) throw new Error('The radius must be more than zero')
  const { points, tangents } = alongCurve(rail, 2)
  const profile = curveToWire(ringAt(points[0], tangents[0], startRadius))
  const spine = curveToWire(rail)
  const closed = isClosed(rail) && startPoint(rail).distanceTo(endPoint(rail)) < TOLERANCE
  let law: R.GenericSweepConfig['law'] = null
  if (Math.abs(endRadius - startRadius) > 1e-12) {
    const k = oc()
    // The profile is scaled along the spine's parameter range.
    const adaptor = new k.BRepAdaptor_CompCurve(spine.wrapped, false)
    const linear = new k.Law_Linear()
    linear.Set(adaptor.FirstParameter(), 1, adaptor.LastParameter(), endRadius / startRadius)
    adaptor.delete()
    law = linear
  }
  if (cap && !closed) return R.genericSweep(profile, spine, { law }, false)
  return R.genericSweep(profile, spine, { law }, true)[0]
}

// --- Blends ------------------------------------------------------------------------------------

/** Points and tangents along a kernel edge, at even parameter steps. */
function edgeSamples(edge: R.Edge, count: number): { points: Vector3[]; tangents: Vector3[] } {
  const points: Vector3[] = []
  const tangents: Vector3[] = []
  for (let i = 0; i < count; i++) {
    const p = edge.pointAt(i / (count - 1))
    const t = edge.tangentAt(i / (count - 1))
    points.push(v3(p))
    tangents.push(v3(t).normalize())
    p.delete()
    t.delete()
  }
  return { points, tangents }
}

/** The face an edge bounds (the first, for an edge between two faces). */
function faceOfEdge(shape: AnyShape, edge: R.Edge): R.Face {
  const face = shape.faces.find((f) => f.edges.some((e) => e.isSame(edge)))
  if (!face) throw new Error('The edge bounds no face')
  return face
}

/**
 * Directions square to the edge, lying in the face, pointing out of it: a blend leaves the surface
 * along these, so it meets it smoothly.
 */
function outwardDirections(face: R.Face, points: Vector3[], tangents: Vector3[], size: number): Vector3[] {
  const eps = size * 1e-3
  return points.map((p, i) => {
    const n = face.normalAt([p.x, p.y, p.z])
    const d = v3(n).cross(tangents[i]).normalize()
    n.delete()
    const probe = closestOn(face, p.clone().addScaledVector(d, eps))
    // Still on the face: it pointed inwards.
    if (probe && probe.distance < eps * 0.5) d.negate()
    return d
  })
}

/**
 * BlendSrf: a surface between an edge of one surface and an edge of another, leaving each along its
 * surface (tangent to it). `bulge` stretches how far the blend keeps each surface's direction.
 */
export function blendSurface(shapeA: AnyShape, edgeA: number, shapeB: AnyShape, edgeB: number, bulge = 1, count = 24): R.Face {
  const ea = shapeA.edges[edgeA]
  const eb = shapeB.edges[edgeB]
  if (!ea || !eb) throw new Error('Pick an edge of each surface')
  const a = edgeSamples(ea, count)
  let b = edgeSamples(eb, count)
  // Pair each point with the nearer end of the other edge.
  if (a.points[0].distanceTo(b.points[count - 1]) + a.points[count - 1].distanceTo(b.points[0]) < a.points[0].distanceTo(b.points[0]) + a.points[count - 1].distanceTo(b.points[count - 1])) {
    b = { points: [...b.points].reverse(), tangents: [...b.tangents].reverse().map((t) => t.negate()) }
  }
  const size = Math.max(...a.points.map((p, i) => p.distanceTo(b.points[i])), 1e-6)
  const da = outwardDirections(faceOfEdge(shapeA, ea), a.points, a.tangents, size)
  const db = outwardDirections(faceOfEdge(shapeB, eb), b.points, b.tangents, size)
  const across = 16
  const grid = a.points.map((pa, i) => {
    const pb = b.points[i]
    const reach = (pa.distanceTo(pb) / 3) * bulge
    // A cubic from one edge to the other, leaving each along its surface.
    const p1 = pa.clone().addScaledVector(da[i], reach)
    const p2 = pb.clone().addScaledVector(db[i], reach)
    const row: Vector3[] = []
    for (let j = 0; j < across; j++) {
      const t = j / (across - 1)
      const s = 1 - t
      row.push(
        pa
          .clone()
          .multiplyScalar(s * s * s)
          .addScaledVector(p1, 3 * s * s * t)
          .addScaledVector(p2, 3 * s * t * t)
          .addScaledVector(pb, t * t * t),
      )
    }
    return row
  })
  return gridSurface(grid)
}
