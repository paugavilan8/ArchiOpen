import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { beforeAll, describe, expect, it } from 'vitest'
import { planarFace } from './brep'
import { matchSurface } from './matchSrf'

beforeAll(async () => {
  R.setOC(await opencascade())
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const rect = (points: Vector3[]) => planarFace({ type: 'polyline', points, closed: true })!
const oc = () => R.getOC()

/** Point, derivative across the edge (along u or v) and normal at (u, v) of a single face. */
function probe(shape: R.AnyShape, at: Vector3) {
  const k = oc()
  const face = shape.faces[0]
  const surface = new k.BRepAdaptor_Surface(k.TopoDS.Face(face.wrapped), true)
  const n = face.normalAt([at.x, at.y, at.z])
  surface.delete()
  return { normal: new Vector3(n.x, n.y, n.z) }
}

/** Three points of a single face's surface going in across its side nearest `at`, `step` apart in parameter. */
function crossing(shape: R.AnyShape, at: Vector3, step: number): [Vector3, Vector3, Vector3] {
  const k = oc()
  const f = k.TopoDS.Face(shape.faces[0].wrapped)
  const s = new k.BRepAdaptor_Surface(f, true)
  const b = k.BRepTools.UVBounds(f)
  const value = (u: number, w: number) => {
    const p = s.Value(u, w)
    return new Vector3(p.X(), p.Y(), p.Z())
  }
  const [um, vm] = [(b.UMin + b.UMax) / 2, (b.VMin + b.VMax) / 2]
  const du = (b.UMax - b.UMin) * step
  const dv = (b.VMax - b.VMin) * step
  const sides = [
    (i: number) => value(b.UMin + i * du, vm),
    (i: number) => value(b.UMax - i * du, vm),
    (i: number) => value(um, b.VMin + i * dv),
    (i: number) => value(um, b.VMax - i * dv),
  ]
  const side = sides.reduce((x, y) => (x(0).distanceTo(at) < y(0).distanceTo(at) ? x : y))
  return [side(0), side(1), side(2)]
}

const nearestEdge = (shape: R.AnyShape, p: Vector3) => {
  let best = 0
  let d = Infinity
  shape.edges.forEach((e, i) => {
    const c = e.pointAt(0.5)
    const dist = Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z)
    if (dist < d) [best, d] = [i, dist]
  })
  return best
}

// The target: a floor, its edge along x = 10. The surface to change: a tilted plate, short of it.
const floor = () => rect([v(0, 0), v(10, 0), v(10, 10), v(0, 10)])
const plate = () => rect([v(11, 0, 1), v(20, 0, 4), v(20, 10, 4), v(11, 10, 1)])
const edgeOfFloor = (b: R.AnyShape) => nearestEdge(b, v(10, 5))

const onEdge = (shape: R.AnyShape) => {
  // Points along the changed edge: the corners nearest x = 10, and between.
  const out: Vector3[] = []
  for (const y of [0, 2.5, 5, 7.5, 10]) {
    const k = oc()
    const dist = new k.BRepExtrema_DistShapeShape()
    dist.LoadS1(R.makeVertex([10, y, 0]).wrapped)
    dist.LoadS2(shape.wrapped)
    dist.Perform()
    out.push(new Vector3(dist.Value(), 0, 0))
    dist.delete()
  }
  return out.map((p) => p.x)
}

describe('MatchSrf', () => {
  it('moves the edge onto the target edge (position)', () => {
    const b = floor()
    const result = matchSurface(plate(), 0, v(11, 5, 1), b, edgeOfFloor(b), 'position')
    for (const d of onEdge(result)) expect(d).toBeLessThan(1e-6)
    // The far edge stays where it was.
    const bounds = result.boundingBox.bounds
    expect(bounds[1][0]).toBeCloseTo(20, 6)
    expect(bounds[1][2]).toBeCloseTo(4, 6)
  })

  it('leaves the edge in the target tangent plane (tangency)', () => {
    const b = floor()
    const result = matchSurface(plate(), 0, v(11, 5, 1), b, edgeOfFloor(b), 'tangency')
    for (const d of onEdge(result)) expect(d).toBeLessThan(1e-6)
    // Just past the edge the surface is still flat: its normal is the floor's.
    for (const y of [1, 5, 9]) expect(Math.abs(probe(result, v(10.01, y, 0)).normal.z)).toBeGreaterThan(0.9999)
  })

  it('takes the curvature of a curved target (curvature)', () => {
    // A quarter cylinder of radius 5 about the y axis line at (0, *, -5), ending upright at x = 5.
    const cylinder = R.makeCylinder(5, 10, [0, 0, -5], [0, 1, 0])
    const quarter = (cylinder as R.Shape3D).intersect(R.makeBox([0, 0, -5], [5, 10, 0]))
    const side = quarter.faces.find((f) => f.geomType === 'CYLINDRE')!
    const edge = nearestEdge(side, v(5, 5, -5))
    const result = matchSurface(rect([v(6, 0, -6), v(9, 0, -9), v(9, 10, -9), v(6, 10, -6)]), 0, v(6, 5, -6), side, edge, 'curvature')
    // Its edge on the cylinder's, and leaving it straight down (tangent to the cylinder there).
    for (const y of [1, 5, 9]) {
      const n = probe(result, v(5, y, -5.001)).normal
      expect(Math.abs(n.x)).toBeGreaterThan(0.999)
    }
    // Across the edge, at its middle, it starts off bending like the cylinder (radius 5).
    const [p0, p1, p2] = crossing(result, v(5, 5, -5), 1e-4)
    // Curvature from finite differences (the parameter step cancels out).
    const d1 = p2.clone().sub(p0).multiplyScalar(0.5)
    const d2 = p0.clone().sub(p1.clone().multiplyScalar(2)).add(p2)
    const curvature = d1.clone().cross(d2).length() / d1.length() ** 3
    expect(1 / curvature).toBeCloseTo(5, 0)
  })
})
