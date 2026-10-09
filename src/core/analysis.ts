import { Box3, Vector3 } from 'three'
import { length } from './curves'
import { AnyCurve, domain, Geometry, HatchGeometry, isClosed, MeshGeometry, Plane, pointAt, wireframe } from './geometry'
import { hatchTriangles } from './hatch'
import { meshTriangles } from './mesh'

/** Measurements that need no geometry kernel: curves, hatches and meshes. */

export interface AreaResult {
  area: number
  centroid: Vector3
}

/** Vector area (normal times area) and centroid of a closed polygon. */
function polygonArea(pts: Vector3[]): { vector: Vector3; centroid: Vector3 } {
  const vector = new Vector3()
  for (let i = 0; i < pts.length; i++) vector.add(pts[i].clone().cross(pts[(i + 1) % pts.length]))
  vector.multiplyScalar(0.5)
  const n = vector.clone().normalize()
  // Centroid of the fan of triangles from the first point, weighted by their signed areas.
  const centroid = new Vector3()
  let total = 0
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i].clone().sub(pts[0]).cross(pts[i + 1].clone().sub(pts[0])).dot(n) / 2
    centroid.addScaledVector(pts[0].clone().add(pts[i]).add(pts[i + 1]), a / 3)
    total += a
  }
  return { vector, centroid: Math.abs(total) > 0 ? centroid.divideScalar(total) : pts[0].clone() }
}

/**
 * A closed curve as a polygon (the start not repeated): polylines by their own points, everything
 * else at `count` even parameter steps per segment.
 */
function curvePolygon(g: AnyCurve, count: number): Vector3[] {
  if (g.type === 'polyline') {
    const pts = g.points
    return !g.closed && pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) === 0 ? pts.slice(0, -1) : pts
  }
  if (g.type === 'polycurve') return g.segments.flatMap((s) => (s.type === 'polyline' ? s.points.slice(0, -1) : curvePolygon(s, count)))
  const [t0, t1] = domain(g)
  const pts: Vector3[] = []
  for (let i = 0; i < count; i++) pts.push(pointAt(g, t0 + ((t1 - t0) * i) / count))
  return pts
}

/**
 * Area and centroid inside a closed planar curve, or null when it is open or not flat. Smooth curves
 * are measured from two polygons, which extrapolate to within about a millionth.
 */
export function curveArea(g: AnyCurve): AreaResult | null {
  if (!isClosed(g)) return null
  if (g.type === 'circle') return { area: Math.PI * g.radius * g.radius, centroid: g.center.clone() }
  const count = 1024
  const fine = polygonArea(curvePolygon(g, count))
  const area = fine.vector.length()
  if (area === 0) return null
  // Flat: every point within a small fraction of the curve's size from the plane.
  const n = fine.vector.clone().normalize()
  const pts = curvePolygon(g, Math.max(64, count / 8))
  const tolerance = length(g) * 1e-6
  if (pts.some((p) => Math.abs(p.clone().sub(pts[0]).dot(n)) > tolerance)) return null
  if (g.type === 'polyline') return { area, centroid: fine.centroid }
  const coarse = polygonArea(curvePolygon(g, count / 2))
  return {
    area: area + (area - coarse.vector.length()) / 3,
    centroid: fine.centroid.clone().add(fine.centroid.clone().sub(coarse.centroid).divideScalar(3)),
  }
}

function trianglesArea(flat: number[], indices?: number[]): AreaResult {
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const centroid = new Vector3()
  let area = 0
  const count = indices ? indices.length / 3 : flat.length / 9
  for (let i = 0; i < count; i++) {
    const [ia, ib, ic] = indices ? [indices[3 * i], indices[3 * i + 1], indices[3 * i + 2]] : [3 * i, 3 * i + 1, 3 * i + 2]
    a.fromArray(flat, 3 * ia)
    b.fromArray(flat, 3 * ib)
    c.fromArray(flat, 3 * ic)
    const piece = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
    centroid.addScaledVector(a.clone().add(b).add(c), piece / 3)
    area += piece
  }
  return { area, centroid: area > 0 ? centroid.divideScalar(area) : centroid }
}

/** Area of a hatch's filled region (holes left out). */
export const hatchArea = (g: HatchGeometry): AreaResult => trianglesArea(hatchTriangles(g))

/** Area of a mesh's faces and their centroid. */
export const meshAreaCentroid = (g: MeshGeometry): AreaResult => trianglesArea(g.vertices, meshTriangles(g))

export interface VolumeResult {
  volume: number
  centroid: Vector3
}

/** Volume enclosed by a closed mesh and its centroid (from the tetrahedra its faces make with the origin). */
export function meshVolumeCentroid(g: MeshGeometry): VolumeResult {
  const t = meshTriangles(g)
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const centroid = new Vector3()
  let volume = 0
  for (let i = 0; i < t.length; i += 3) {
    a.fromArray(g.vertices, 3 * t[i])
    b.fromArray(g.vertices, 3 * t[i + 1])
    c.fromArray(g.vertices, 3 * t[i + 2])
    const v = a.dot(b.clone().cross(c)) / 6
    centroid.addScaledVector(a.clone().add(b).add(c), v / 4)
    volume += v
  }
  return { volume: Math.abs(volume), centroid: volume !== 0 ? centroid.divideScalar(volume) : centroid }
}

/** Every point that bounds a geometry: its line work, plus the vertices of surfaces and meshes. */
function boundingPoints(g: Geometry): Vector3[] {
  if (g.type === 'mesh' || g.type === 'brep') {
    const flat = g.type === 'mesh' ? g.vertices : g.display.vertices
    const pts: Vector3[] = []
    for (let i = 0; i < flat.length; i += 3) pts.push(new Vector3().fromArray(flat, i))
    return pts
  }
  return wireframe(g).flat()
}

/** Bounding box of geometries in a plane's coordinates (x, y along its axes, z along its normal). */
export function boundingBox(geometries: Geometry[], plane?: Plane): Box3 {
  const box = new Box3()
  const local = new Vector3()
  for (const g of geometries) {
    for (const p of boundingPoints(g)) {
      if (!plane) box.expandByPoint(p)
      else {
        const d = p.clone().sub(plane.origin)
        box.expandByPoint(local.set(d.dot(plane.xaxis), d.dot(plane.yaxis), d.dot(plane.normal)))
      }
    }
  }
  return box
}
