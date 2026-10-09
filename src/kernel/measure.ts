import { Box3, Vector3 } from 'three'
import type { Plane } from '../core/geometry'
import * as R from 'replicad'
import { openEdgeCount } from './brep'

/** Area, volume and validity of kernel shapes. Needs the kernel loaded. */

type AnyShape = R.AnyShape

/** Surfaces OCCT integrates exactly and quickly with its default rule. */
const ANALYTIC = new Set(['PLANE', 'CYLINDRE', 'CONE', 'SPHERE', 'TORUS'])

export interface Measure {
  value: number
  centroid: Vector3
}

/**
 * OCCT's integration is exact and quick on analytic faces (planes, cylinders, cones, spheres, tori)
 * but can be several percent off on others (B-splines, extrusions of ellipses). There, volumes use
 * its slower Gauss–Kronrod rule, which is exact, and areas a very fine triangulation (to about a
 * hundred-thousandth).
 */
function measureVolume(shape: AnyShape): Measure {
  const k = R.getOC()
  const props = new k.GProp_GProps()
  try {
    if (shape.faces.every((f) => ANALYTIC.has(f.geomType))) k.BRepGProp.VolumeProperties(shape.wrapped, props, true, false, false)
    else k.BRepGProp.VolumePropertiesGK(shape.wrapped, props, 1e-6, true, true, true, false, false)
    if (props.Mass() === 0) return { value: 0, centroid: new Vector3() }
    const c = props.CentreOfMass()
    const centroid = new Vector3(c.X(), c.Y(), c.Z())
    c.delete()
    return { value: props.Mass(), centroid }
  } finally {
    props.delete()
  }
}

function faceArea(face: R.Face, size: number): Measure {
  if (ANALYTIC.has(face.geomType)) {
    const k = R.getOC()
    const props = new k.GProp_GProps()
    try {
      // The adaptive rule: the default one is off on planes bounded by rational curves.
      k.BRepGProp.SurfaceProperties(face.wrapped, props, 1e-7, false)
      const c = props.CentreOfMass()
      const centroid = new Vector3(c.X(), c.Y(), c.Z())
      c.delete()
      return { value: props.Mass(), centroid }
    } finally {
      props.delete()
    }
  }
  const { vertices: v, triangles: t } = face.mesh({ tolerance: size * 1e-5, angularTolerance: 0.02 })
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const centroid = new Vector3()
  let area = 0
  for (let i = 0; i < t.length; i += 3) {
    a.fromArray(v, 3 * t[i])
    b.fromArray(v, 3 * t[i + 1])
    c.fromArray(v, 3 * t[i + 2])
    const piece = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
    area += piece
    centroid.addScaledVector(a.clone().add(b).add(c), piece / 3)
  }
  return { value: area, centroid: area > 0 ? centroid.divideScalar(area) : centroid }
}

function measureArea(shape: AnyShape): Measure {
  const box = shape.boundingBox
  const size = Math.max(1e-9, Math.hypot(box.width, box.height, box.depth))
  let area = 0
  const centroid = new Vector3()
  for (const face of shape.faces) {
    const m = faceArea(face, size)
    area += m.value
    centroid.addScaledVector(m.centroid, m.value)
  }
  return { value: area, centroid: area > 0 ? centroid.divideScalar(area) : centroid }
}

/** Total area of the faces and their centroid. */
export const shapeArea = (shape: AnyShape): Measure => measureArea(shape)

/** Volume enclosed by the closed shells of a shape (faces facing outwards) and its centroid. */
export function shapeVolume(shape: AnyShape): Measure {
  const m = measureVolume(shape)
  return { ...m, value: Math.abs(m.value) }
}

export interface ShapeCheck {
  /** OCCT finds no faults in the topology and geometry. */
  valid: boolean
  faces: number
  edges: number
  /** Edges with a face on one side only. */
  nakedEdges: number
  /** Edges shared by more than two faces. */
  nonManifoldEdges: number
}

/** Looks for faults a modeler would care about: invalid geometry, open and non-manifold edges. */
export function checkShape(shape: AnyShape): ShapeCheck {
  const k = R.getOC()
  const analyzer = new k.BRepCheck_Analyzer(shape.wrapped, true, false, false)
  const valid = analyzer.IsValid()
  analyzer.delete()
  const uses = new Map<number, number>()
  for (const face of shape.faces) for (const edge of face.edges) uses.set(edge.hashCode, (uses.get(edge.hashCode) ?? 0) + 1)
  let nonManifold = 0
  for (const n of uses.values()) if (n > 2) nonManifold++
  return { valid, faces: shape.faces.length, edges: uses.size, nakedEdges: openEdgeCount(shape), nonManifoldEdges: nonManifold }
}

/**
 * Tight bounding box of a shape from its exact geometry, in a plane's coordinates (x, y along its
 * axes, z along its normal) or the world's.
 */
export function shapeBounds(shape: AnyShape, plane?: Plane): Box3 {
  const k = R.getOC()
  let target = shape.wrapped
  let maker: { Shape(): typeof target; delete(): void } | null = null
  if (plane) {
    // Into the plane's coordinates: rows of the rotation are its axes.
    const { origin: o, xaxis: x, yaxis: y, normal: n } = plane
    const trsf = new k.gp_Trsf()
    trsf.SetValues(x.x, x.y, x.z, -x.dot(o), y.x, y.y, y.z, -y.dot(o), n.x, n.y, n.z, -n.dot(o))
    maker = new k.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false)
    target = maker.Shape()
    trsf.delete()
  }
  const box = new k.Bnd_Box()
  try {
    k.BRepBndLib.AddOptimal(target, box, false, false)
    const lo = box.CornerMin()
    const hi = box.CornerMax()
    const result = new Box3(new Vector3(lo.X(), lo.Y(), lo.Z()), new Vector3(hi.X(), hi.Y(), hi.Z()))
    lo.delete()
    hi.delete()
    return result
  } finally {
    box.delete()
    maker?.delete()
  }
}
