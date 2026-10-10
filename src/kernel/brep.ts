import { Box3, Matrix4, Vector3 } from 'three'
import * as R from 'replicad'
import { isSimilarity, join } from '../core/curves'
import { AnyCurve, BrepGeometry, endPoint, isClosed, MeshGeometry, pointAt, startPoint } from '../core/geometry'
import { weldMesh } from '../core/mesh'
import { edgeToCurve } from './edges'

/**
 * Bridge between ArchiOpen geometry and the Open CASCADE kernel (through replicad). Everything here
 * needs the kernel to be loaded first; see loadKernel().
 */

type OC = ReturnType<typeof R.getOC>
type AnyShape = R.AnyShape

const oc = (): OC => R.getOC()
const pt = (v: Vector3): [number, number, number] => [v.x, v.y, v.z]

// --- Curves to edges ------------------------------------------------------------------

/** Exact B-spline edge from our control points and clamped knot vector. */
function splineEdge(g: Extract<AnyCurve, { type: 'curve' }>): R.Edge {
  const k = oc()
  const poles = new k.NCollection_Array1_gp_Pnt(1, g.points.length)
  g.points.forEach((p, i) => poles.SetValue(i + 1, new k.gp_Pnt(p.x, p.y, p.z)))
  // OCCT wants distinct knots with their multiplicities.
  const values: number[] = []
  const mults: number[] = []
  for (const u of g.knots) {
    if (values.length > 0 && Math.abs(u - values[values.length - 1]) < 1e-12) mults[mults.length - 1]++
    else {
      values.push(u)
      mults.push(1)
    }
  }
  const knots = new k.NCollection_Array1_double(1, values.length)
  const multiplicities = new k.NCollection_Array1_int(1, mults.length)
  values.forEach((u, i) => knots.SetValue(i + 1, u))
  mults.forEach((m, i) => multiplicities.SetValue(i + 1, m))
  const curve = new k.Geom_BSplineCurve(poles, knots, multiplicities, g.degree, false)
  // Weights make it rational (NURBS); there is no constructor that takes them directly.
  g.weights?.forEach((w, i) => curve.SetWeight(i + 1, w))
  const maker = new k.BRepBuilderAPI_MakeEdge(curve)
  const edge = new R.Edge(maker.Edge())
  maker.delete()
  return edge
}

/** The edges of a curve, in order. */
export function curveToEdges(g: AnyCurve): R.Edge[] {
  switch (g.type) {
    case 'polyline': {
      const n = g.points.length
      const edges: R.Edge[] = []
      for (let i = 0; i < (g.closed ? n : n - 1); i++) {
        const a = g.points[i]
        const b = g.points[(i + 1) % n]
        if (a.distanceTo(b) > 1e-9) edges.push(R.makeLine(pt(a), pt(b)))
      }
      return edges
    }
    case 'circle':
      return [R.makeCircle(g.radius, pt(g.center), pt(g.xaxis.clone().cross(g.yaxis)))]
    case 'arc':
      return [R.makeThreePointArc(pt(startPoint(g)), pt(pointAt(g, g.angle / 2)), pt(endPoint(g)))]
    case 'curve':
      return [splineEdge(g)]
    case 'polycurve':
      return g.segments.flatMap(curveToEdges)
  }
}

export function curveToWire(g: AnyCurve): R.Wire {
  return R.assembleWire(curveToEdges(g))
}

/** A planar face bounded by a closed curve, or null if the curve is open or not planar. */
export function planarFace(g: AnyCurve): R.Face | null {
  if (!isClosed(g)) return null
  try {
    return R.makeFace(curveToWire(g))
  } catch {
    return null
  }
}

// --- Breps -----------------------------------------------------------------------------

/** Turns a kernel shape into document geometry: the exact shape plus a mesh to draw it. */
export function toBrep(shape: AnyShape): BrepGeometry {
  const box = shape.boundingBox
  const size = Math.max(1e-6, Math.hypot(box.width, box.height, box.depth))
  // Mesh finely enough to look smooth at any size.
  const options = { tolerance: size / 800, angularTolerance: 0.25 }
  const mesh = shape.mesh(options)
  const edgeMesh = shape.meshEdges(options)
  const edges = edgeMesh.edgeGroups.map(({ start, count }) => {
    // Edge lines come as segment pairs; keep each point once.
    const flat: number[] = []
    for (let i = start; i < start + count; i++) {
      if (i > start && (i - start) % 2 === 0) continue
      flat.push(edgeMesh.lines[3 * i], edgeMesh.lines[3 * i + 1], edgeMesh.lines[3 * i + 2])
    }
    return flat
  })
  // Store the exact shape without its triangulation, which would make it many times larger.
  oc().BRepTools.Clean(shape.wrapped, true)
  const brep = oc().BRepToolsWrapper.Write(shape.wrapped)
  // Which triangles belong to which face, in the order of shape.faces.
  const faceIndex = new Map(shape.faces.map((f, i) => [f.hashCode, i]))
  const faceTriangles: number[][] = []
  for (const group of mesh.faceGroups) faceTriangles[faceIndex.get(group.faceId) ?? faceTriangles.length] = [group.start, group.count]
  const faces = shape.faces.length
  const solids = (shape as R.Shape3D).solids?.length ?? 0
  return {
    type: 'brep',
    brep,
    matrix: null,
    kind: solids > 0 ? 'solid' : faces === 1 ? 'surface' : 'polysurface',
    faces,
    display: { vertices: mesh.vertices, normals: mesh.normals, triangles: mesh.triangles, edges, faceTriangles },
  }
}

/** The exact kernel shape of a brep, with any pending transform applied. */
export function shapeOf(g: BrepGeometry): AnyShape {
  const shape = oc().BRepToolsWrapper.Read(g.brep)
  if (!g.matrix) return R.cast(shape)
  const m = new Matrix4().fromArray(g.matrix)
  if (!isSimilarity(m)) throw new Error('Surfaces and solids can only be moved, rotated, mirrored or scaled uniformly')
  const e = m.elements
  const trsf = new (oc().gp_Trsf)()
  // Rows of the 3×4 affine part; OCCT works out the uniform scale (and a mirror) from it.
  trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
  const maker = new (oc().BRepBuilderAPI_Transform)(shape, trsf, true, false)
  const result = R.cast(maker.Shape())
  maker.delete()
  trsf.delete()
  return result
}

// --- Construction ----------------------------------------------------------------------

const vec = (v: Vector3) => new (oc().gp_Vec)(v.x, v.y, v.z)

/** Extrudes a curve along `direction`. Closed planar curves become capped solids when `cap` is set. */
export function extrudeCurve(g: AnyCurve, direction: Vector3, cap: boolean): AnyShape {
  const face = cap ? planarFace(g) : null
  const profile = face ?? curveToWire(g)
  const prism = new (oc().BRepPrimAPI_MakePrism)(profile.wrapped, vec(direction), true, true)
  const result = R.cast(prism.Shape())
  prism.delete()
  return result
}

/** Revolves a curve around an axis by `angle` radians. Closed planar curves give solids. */
export function revolveCurve(g: AnyCurve, origin: Vector3, axis: Vector3, angle: number): AnyShape {
  const k = oc()
  const profile = planarFace(g) ?? curveToWire(g)
  const ax = new k.gp_Ax1(new k.gp_Pnt(origin.x, origin.y, origin.z), new k.gp_Dir(axis.x, axis.y, axis.z))
  const revol = new k.BRepPrimAPI_MakeRevol(profile.wrapped, ax, angle, true)
  const result = R.cast(revol.Shape())
  revol.delete()
  return result
}

/** Lofts through curves in order: closed curves give a capped solid, open curves a surface. */
export function loftCurves(curves: AnyCurve[]): AnyShape {
  const wires = curves.map(curveToWire)
  const closed = curves.every(isClosed)
  return closed ? R.loft(wires) : R.loft(wires, {}, true)
}

/** Box on the rectangle with corner `origin` and edges `u`, `v`, extruded by `w`. */
export function box(origin: Vector3, u: Vector3, v: Vector3, w: Vector3): AnyShape {
  const corners = [origin, origin.clone().add(u), origin.clone().add(u).add(v), origin.clone().add(v)]
  const face = R.makePolygon(corners.map(pt))
  return R.basicFaceExtrusion(face, new R.Vector(pt(w)))
}

export function cylinder(center: Vector3, radius: number, height: number, axis: Vector3): AnyShape {
  return R.makeCylinder(radius, height, pt(center), pt(axis))
}

export function sphere(center: Vector3, radius: number): AnyShape {
  return R.makeSphere(radius).translate(pt(center))
}

export type BooleanKind = 'union' | 'difference' | 'intersection'

/** Boolean of the first shape with the others. */
export function boolean(kind: BooleanKind, first: AnyShape, others: AnyShape[]): AnyShape {
  let result = first as R.Shape3D
  for (const other of others) {
    const tool = other as R.Shape3D
    result = kind === 'union' ? result.fuse(tool) : kind === 'difference' ? result.cut(tool) : result.intersect(tool)
  }
  return result
}

/** Rounds the given edges (indices into the shape's edge list) with radius r. */
export function filletEdges(shape: AnyShape, edgeIndices: number[], r: number): AnyShape {
  const all = shape.edges
  const chosen = edgeIndices.map((i) => all[i]).filter(Boolean)
  return (shape as R.Shape3D).fillet((edge) => (chosen.some((c) => c.isSame(edge)) ? r : null))
}

/** Sweeps a profile along a rail. Closed planar profiles give solids. */
export function sweep(profile: AnyCurve, rail: AnyCurve): AnyShape {
  return R.genericSweep(curveToWire(profile), curveToWire(rail), {})
}

/** Hollows a solid inwards by `thickness`, leaving the given faces open. */
export function shellSolid(shape: AnyShape, openFaces: number[], thickness: number): AnyShape {
  const all = shape.faces
  const open = openFaces.map((i) => all[i]).filter(Boolean)
  return (shape as R.Shape3D).shell(thickness, (finder) => finder.inList(open))
}

/** Curves where the plane through `origin` with normal `normal` cuts the shape. */
export function sectionCurves(shape: AnyShape, origin: Vector3, normal: Vector3): AnyCurve[] {
  const k = oc()
  const plane = new k.gp_Pln(new k.gp_Pnt(origin.x, origin.y, origin.z), new k.gp_Dir(normal.x, normal.y, normal.z))
  const section = new k.BRepAlgoAPI_Section(shape.wrapped, plane, true)
  const result = R.cast(section.Shape())
  section.delete()
  plane.delete()
  const pieces = result.edges.map(edgeToCurve).filter((c): c is AnyCurve => c !== null)
  return join(pieces).map((j) => j.geometry)
}

/** The faces of a polysurface, each as its own surface. */
export function explodeShape(shape: AnyShape): AnyShape[] {
  return shape.faces
}

/** How many edges bound only one face: the open borders of a surface or polysurface. */
export function openEdgeCount(shape: AnyShape): number {
  const count = new Map<number, number>()
  for (const face of shape.faces) for (const edge of face.edges) count.set(edge.hashCode, (count.get(edge.hashCode) ?? 0) + 1)
  let open = 0
  for (const n of count.values()) if (n === 1) open++
  return open
}

/** Sews surfaces and polysurfaces together; a closed result becomes a solid. */
export function joinShapes(shapes: AnyShape[], tolerance = 1e-4): AnyShape {
  const k = oc()
  const sewing = new k.BRepBuilderAPI_Sewing(tolerance, true, true, true, false)
  for (const shape of shapes) for (const face of shape.faces) sewing.Add(face.wrapped)
  sewing.Perform()
  const sewn = R.cast(sewing.SewedShape())
  sewing.delete()
  // Only a closed shell makes a solid (OCCT would also accept an open one).
  if (sewn instanceof R.Shell && openEdgeCount(sewn) === 0) {
    try {
      return R.makeSolid([sewn])
    } catch {
      // Not closed: it stays an open polysurface.
    }
  }
  return sewn
}

// --- Meshes ----------------------------------------------------------------------------

/**
 * A mesh of a shape, finer for a smaller `tolerance` (largest distance from the true surface) and
 * `angularTolerance` (largest turn between neighbouring facets, in radians). Faces share vertices
 * inside each face of the shape; along its edges they are welded too.
 */
export function shapeToMesh(shape: AnyShape, tolerance: number, angularTolerance: number): MeshGeometry {
  const mesh = shape.mesh({ tolerance, angularTolerance })
  const faces: number[] = []
  for (let i = 0; i < mesh.triangles.length; i += 3) faces.push(mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2], mesh.triangles[i + 2])
  return weldMesh({ type: 'mesh', vertices: [...mesh.vertices], faces }, tolerance / 100)
}

/** A polysurface (a solid when closed) with one flat face per mesh face; bent quads become two triangles. */
export function meshToShape(g: MeshGeometry): AnyShape {
  const v = (i: number) => new Vector3().fromArray(g.vertices, 3 * i)
  const faces: R.Face[] = []
  const add = (corners: Vector3[]) => {
    try {
      faces.push(R.makePolygon(corners.map(pt)))
    } catch {
      // A face with no area adds nothing.
    }
  }
  const f = g.faces
  for (let i = 0; i < f.length; i += 4) {
    const [a, b, c, d] = [v(f[i]), v(f[i + 1]), v(f[i + 2]), v(f[i + 3])]
    if (f[i + 2] === f[i + 3]) {
      add([a, b, c])
      continue
    }
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    const size = Math.max(a.distanceTo(c), b.distanceTo(d))
    if (Math.abs(d.clone().sub(a).dot(normal)) < size * 1e-7) add([a, b, c, d])
    else {
      add([a, b, c])
      add([a, c, d])
    }
  }
  if (faces.length === 0) throw new Error('The mesh has no faces with area')
  let size = 1
  for (const x of g.vertices) size = Math.max(size, Math.abs(x))
  return joinShapes(faces, 1e-6 * size)
}

export { displayBox, nearestFace } from '../core/brepFaces'
