import { Box3, Matrix4, Vector3 } from 'three'
import { clampedKnots, evalCurve } from '../math/nurbs'
import { annotationLines } from './annotation'
import { hatchLines } from './hatch'
import { insertionPoint } from './blocks'
import { transform } from './curves'
import { meshEdgeLines, meshVertexPoints, SNAP_VERTEX_LIMIT } from './mesh'

export interface Plane {
  origin: Vector3
  xaxis: Vector3
  yaxis: Vector3
  normal: Vector3
}

/** Straight segments through the points. A line is a polyline with two points. */
export interface PolylineGeometry {
  type: 'polyline'
  points: Vector3[]
  closed: boolean
}

export interface CircleGeometry {
  type: 'circle'
  center: Vector3
  xaxis: Vector3
  yaxis: Vector3
  radius: number
}

/** Circular arc that starts on `xaxis` and turns `angle` radians towards `yaxis`. */
export interface ArcGeometry {
  type: 'arc'
  center: Vector3
  xaxis: Vector3
  yaxis: Vector3
  radius: number
  angle: number
}

/** Non-rational B-spline curve with a clamped knot vector. */
/** B-spline curve with a clamped knot vector; rational (NURBS) when it has weights. */
export interface CurveGeometry {
  type: 'curve'
  degree: number
  points: Vector3[]
  knots: number[]
  /** One per control point; missing for non-rational curves. */
  weights?: number[]
}

/** Open curves that can be chained into a polycurve. */
export type SegmentGeometry = PolylineGeometry | ArcGeometry | CurveGeometry

/** Curves joined end to end. */
export interface PolycurveGeometry {
  type: 'polycurve'
  segments: SegmentGeometry[]
}

/** Triangles and edge polylines for drawing a boundary representation without the kernel. */
export interface BrepDisplay {
  vertices: number[]
  normals: number[]
  triangles: number[]
  /** One flat [x, y, z, x, y, z, ...] polyline per edge, in the kernel's edge order. */
  edges: number[][]
  /** [first index, index count] into `triangles` for each face, in the kernel's face order. */
  faceTriangles?: number[][]
}

/**
 * A surface, polysurface or solid. `brep` is the exact shape in Open CASCADE's text format; `matrix`
 * is a transform (column-major 4×4) still to be applied to it, so moving a solid does not need the
 * kernel. `display` is already transformed.
 */
export interface BrepGeometry {
  type: 'brep'
  brep: string
  matrix: number[] | null
  kind: 'solid' | 'surface' | 'polysurface'
  faces: number
  display: BrepDisplay
}

export type AnnotationKind = 'text' | 'linear' | 'aligned' | 'radius' | 'diameter' | 'angle' | 'leader'

/**
 * Text, dimension or leader, drawn as line work in the plane of `xaxis` and `yaxis` (unit vectors).
 * The defining points depend on the kind:
 * - text: the lower left corner;
 * - linear, aligned: the two measured points and a point on the dimension line (linear measures
 *   along `xaxis`, aligned along the measured points);
 * - radius, diameter: the center, a point on the circle and the text location;
 * - angle: the vertex, a point on each ray and a point on the dimension arc;
 * - leader: the arrow tip, then the points of the leader line, the text at the last one.
 * For dimensions, `<>` in `text` stands for the measured value, and an empty text shows just that.
 */
export interface AnnotationGeometry {
  type: 'annotation'
  kind: AnnotationKind
  points: Vector3[]
  xaxis: Vector3
  yaxis: Vector3
  text: string
  /** Text height; arrows are the same size. */
  height: number
  arrow: 'arrow' | 'tick'
  /** Decimal places of the measured value. */
  precision: number
}

/**
 * A hatch: the region inside closed planar loops (loops inside loops are holes), filled solid or
 * with a pattern of lines. The pattern is laid out in the plane of `xaxis` and `yaxis` (unit
 * vectors) from `origin`, at `scale` and turned by `rotation` radians.
 */
export interface HatchGeometry {
  type: 'hatch'
  loops: AnyCurve[]
  pattern: string
  scale: number
  rotation: number
  origin: Vector3
  xaxis: Vector3
  yaxis: Vector3
}

/**
 * A polygon mesh, as in STL, OBJ or Rhino: flat [x, y, z, ...] vertex coordinates and four vertex
 * indices per face. A triangle repeats its third index (a, b, c, c). Faces wind counter-clockwise
 * seen from the side they face.
 */
export interface MeshGeometry {
  type: 'mesh'
  vertices: number[]
  faces: number[]
}

/** A single point in space, as Rhino's point objects (reference marks, survey points, divisions). */
export interface PointGeometry {
  type: 'point'
  point: Vector3
}

export type AnyCurve = PolylineGeometry | CircleGeometry | ArcGeometry | CurveGeometry | PolycurveGeometry

// Geometry values are immutable: edits produce a new value, which keeps the caches below valid.
/** An object of a block definition, with the layer it had when the block was made. */
export interface BlockObject {
  layerId: number
  geometry: Geometry
}

/** A named set of objects around a base point at the origin. Definitions are never changed in place. */
export interface BlockDefinition {
  name: string
  objects: BlockObject[]
}

/** A block definition placed with a transform (column-major 4×4). Drawn with the instance's layer. */
export interface InstanceGeometry {
  type: 'instance'
  definition: BlockDefinition
  matrix: number[]
}

export type Geometry = AnyCurve | BrepGeometry | AnnotationGeometry | HatchGeometry | InstanceGeometry | MeshGeometry | PointGeometry

export const isCurve = (g: Geometry): g is AnyCurve =>
  g.type !== 'brep' && g.type !== 'annotation' && g.type !== 'hatch' && g.type !== 'instance' && g.type !== 'mesh' && g.type !== 'point'

export interface SnapPoints {
  end: Vector3[]
  mid: Vector3[]
  cen: Vector3[]
  quad: Vector3[]
  /** Where the spans of a B-spline curve meet (its distinct knots). */
  knot: Vector3[]
}

/** The kinds of fixed snap points a geometry has, in the order they are gone through. */
export const SNAP_POINT_KINDS = ['end', 'mid', 'cen', 'quad', 'knot'] as const

const emptySnaps = (): SnapPoints => ({ end: [], mid: [], cen: [], quad: [], knot: [] })

/** Adds every snap point of `from` to `to`, moved by `move` if given. */
function addSnaps(to: SnapPoints, from: SnapPoints, move?: (p: Vector3) => Vector3): void {
  for (const kind of SNAP_POINT_KINDS) for (const p of from[kind]) to[kind].push(move ? move(p) : p)
}

/** Model tolerance: points closer than this are the same point. */
export const TOLERANCE = 1e-3

const CIRCLE_SEGMENTS = 96
const SAMPLES_PER_SPAN = 16
const TWO_PI = Math.PI * 2

// --- Evaluation --------------------------------------------------------------------
// Every curve has a parameter domain. Polylines use [0, segment count], circles [0, 2π], arcs
// [0, angle], B-splines their knot domain, and polycurves [0, segment count] with each segment
// mapped linearly onto one unit.

export function domain(g: AnyCurve): [number, number] {
  switch (g.type) {
    case 'polyline':
      return [0, g.closed ? g.points.length : g.points.length - 1]
    case 'circle':
      return [0, TWO_PI]
    case 'arc':
      return [0, g.angle]
    case 'curve':
      return [g.knots[g.degree], g.knots[g.points.length]]
    case 'polycurve':
      return [0, g.segments.length]
  }
}

/** Closed curves have no ends; parameters wrap around. */
export function isClosed(g: AnyCurve): boolean {
  switch (g.type) {
    case 'polyline':
      return g.closed
    case 'circle':
      return true
    case 'arc':
      return false
    case 'curve':
    case 'polycurve':
      return pointAt(g, domain(g)[0]).distanceTo(pointAt(g, domain(g)[1])) < TOLERANCE
  }
}

function circlePoint(c: CircleGeometry | ArcGeometry, angle: number): Vector3 {
  return c.center
    .clone()
    .addScaledVector(c.xaxis, c.radius * Math.cos(angle))
    .addScaledVector(c.yaxis, c.radius * Math.sin(angle))
}

/** For a polycurve parameter: the segment index and the parameter within that segment. */
export function segmentParam(g: PolycurveGeometry, t: number): [number, number] {
  const i = Math.min(g.segments.length - 1, Math.max(0, Math.floor(t)))
  const [s0, s1] = domain(g.segments[i])
  return [i, s0 + (s1 - s0) * (t - i)]
}

export function pointAt(g: AnyCurve, t: number): Vector3 {
  switch (g.type) {
    case 'polyline': {
      const n = g.points.length
      const last = g.closed ? n : n - 1
      const i = Math.min(last - 1, Math.max(0, Math.floor(t)))
      return g.points[i].clone().lerp(g.points[(i + 1) % n], t - i)
    }
    case 'circle':
    case 'arc':
      return circlePoint(g, t)
    case 'curve':
      return evalCurve(g, t)
    case 'polycurve': {
      const [i, s] = segmentParam(g, t)
      return pointAt(g.segments[i], s)
    }
  }
}

export function startPoint(g: AnyCurve): Vector3 {
  return pointAt(g, domain(g)[0])
}

export function endPoint(g: AnyCurve): Vector3 {
  return pointAt(g, domain(g)[1])
}

/** Unit tangent at t, by central differences (one-sided at the ends of open curves). */
export function tangentAt(g: AnyCurve, t: number): Vector3 {
  const [t0, t1] = domain(g)
  const h = (t1 - t0) * 1e-6
  const closed = isClosed(g)
  let a = t - h
  let b = t + h
  if (!closed) {
    a = Math.max(t0, a)
    b = Math.min(t1, b)
  } else {
    if (a < t0) a += t1 - t0
    if (b > t1) b -= t1 - t0
  }
  return pointAt(g, b).sub(pointAt(g, a)).normalize()
}

// --- Display and snapping ----------------------------------------------------------

export interface Samples {
  points: Vector3[]
  params: number[]
}

const sampleCache = new WeakMap<AnyCurve, Samples>()
const snapCache = new WeakMap<Geometry, SnapPoints>()

function buildSamples(g: AnyCurve): Samples {
  const params: number[] = []
  switch (g.type) {
    case 'polyline': {
      const [, t1] = domain(g)
      for (let i = 0; i <= t1; i++) params.push(i)
      break
    }
    case 'circle':
    case 'arc': {
      const sweep = g.type === 'circle' ? TWO_PI : g.angle
      const count = Math.max(8, Math.ceil((CIRCLE_SEGMENTS * sweep) / TWO_PI))
      for (let i = 0; i <= count; i++) params.push((sweep * i) / count)
      break
    }
    case 'curve': {
      const spans = [...new Set(g.knots.slice(g.degree, g.points.length + 1))]
      for (let s = 0; s < spans.length - 1; s++) {
        for (let i = 0; i < SAMPLES_PER_SPAN; i++) params.push(spans[s] + ((spans[s + 1] - spans[s]) * i) / SAMPLES_PER_SPAN)
      }
      params.push(spans[spans.length - 1])
      break
    }
    case 'polycurve': {
      const points: Vector3[] = []
      g.segments.forEach((segment, i) => {
        const sub = samples(segment)
        const [s0, s1] = domain(segment)
        sub.params.forEach((s, k) => {
          if (i > 0 && k === 0) return // Shared with the end of the previous segment.
          params.push(i + (s - s0) / (s1 - s0))
          points.push(sub.points[k])
        })
      })
      return { points, params }
    }
  }
  return { points: params.map((t) => pointAt(g, t)), params }
}

/** Points along the curve with their parameters. Cached; must not be mutated. */
export function samples(g: AnyCurve): Samples {
  let s = sampleCache.get(g)
  if (!s) {
    s = buildSamples(g)
    sampleCache.set(g, s)
  }
  return s
}

/**
 * What an instance's contents look like where it is placed. The definition's own lines and snap
 * points are moved by the instance's matrix, instead of moving whole objects (surfaces with their
 * display meshes) just to draw them. Annotations are placed for real: a dimension in a scaled block
 * measures, and reads, the scaled length.
 */
function placedContents<T>(g: InstanceGeometry, of: (g: Geometry) => T, move: (value: T, m: Matrix4) => T): T[] {
  const m = new Matrix4().fromArray(g.matrix)
  // A nested block is placed by composing matrices (copying nothing), so what it holds is placed in
  // one go, its annotations with the whole scale.
  return g.definition.objects.map((o) => (o.geometry.type === 'annotation' || o.geometry.type === 'instance' ? of(transform(o.geometry, m)) : move(of(o.geometry), m)))
}

const movePoints = (pts: Vector3[], m: Matrix4) => pts.map((p) => p.clone().applyMatrix4(m))

function instanceLines(g: InstanceGeometry): Vector3[][] {
  return placedContents(g, wireframe, (lines, m) => lines.map((line) => movePoints(line, m))).flat()
}

function instanceSnaps(g: InstanceGeometry): SnapPoints[] {
  return placedContents(g, snapPoints, (s, m) => {
    const moved = emptySnaps()
    addSnaps(moved, s, (p) => p.clone().applyMatrix4(m))
    return moved
  })
}

/** Display polyline for a curve. The result is cached and must not be mutated. */
export function tessellate(g: AnyCurve): Vector3[] {
  return samples(g).points
}

const wireframeCache = new WeakMap<Geometry, Vector3[][]>()

/** Polylines that draw any geometry as wires: the curve itself, or every edge of a brep. Cached. */
export function wireframe(g: Geometry): Vector3[][] {
  let lines = wireframeCache.get(g)
  if (!lines) {
    lines = isCurve(g)
      ? [tessellate(g)]
      : g.type === 'annotation'
        ? annotationLines(g)
        : g.type === 'hatch'
          ? hatchWires(g)
          : g.type === 'instance'
            ? instanceLines(g)
            : g.type === 'mesh'
              ? meshEdgeLines(g)
              : g.type === 'point'
                ? [[g.point]]
              : g.display.edges.map((flat) => {
          const pts: Vector3[] = []
          for (let i = 0; i < flat.length; i += 3) pts.push(new Vector3(flat[i], flat[i + 1], flat[i + 2]))
          return pts
        })
    wireframeCache.set(g, lines)
  }
  return lines
}

/** Pattern lines of a hatch; a solid hatch (or one too dense to draw) shows its boundary instead. */
function hatchWires(g: HatchGeometry): Vector3[][] {
  let lines: Vector3[][] = []
  try {
    lines = hatchLines(g)
  } catch {
    // Too dense: fall through to the boundary.
  }
  return lines.length > 0 ? lines : g.loops.map((loop) => tessellate(loop))
}

/** Point halfway along the curve, measured by length. */
function midPoint(g: AnyCurve): Vector3 {
  const { points } = samples(g)
  let total = 0
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1])
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const d = points[i].distanceTo(points[i - 1])
    if (walked + d >= total / 2) return points[i - 1].clone().lerp(points[i], d === 0 ? 0 : (total / 2 - walked) / d)
    walked += d
  }
  return points[0].clone()
}

function buildSnapPoints(g: Geometry): SnapPoints {
  const snaps = emptySnaps()
  switch (g.type) {
    case 'polyline': {
      const pts = tessellate(g)
      snaps.end = g.points
      for (let i = 0; i < pts.length - 1; i++) snaps.mid.push(pts[i].clone().lerp(pts[i + 1], 0.5))
      break
    }
    case 'circle':
      snaps.cen = [g.center]
      for (let i = 0; i < 4; i++) snaps.quad.push(circlePoint(g, (i * Math.PI) / 2))
      break
    case 'arc':
      snaps.end = [startPoint(g), endPoint(g)]
      snaps.mid = [circlePoint(g, g.angle / 2)]
      snaps.cen = [g.center]
      // Quadrants are measured from the arc's own axes.
      for (let i = 0; i < 4; i++) if ((i * Math.PI) / 2 <= g.angle + 1e-9) snaps.quad.push(circlePoint(g, (i * Math.PI) / 2))
      break
    case 'curve':
      if (g.points.length < 2) break
      snaps.end = [startPoint(g), endPoint(g)]
      snaps.mid = [midPoint(g)]
      snaps.knot = [...new Set(g.knots.slice(g.degree, g.points.length + 1))].map((t) => pointAt(g, t))
      break
    case 'polycurve':
      for (const segment of g.segments) addSnaps(snaps, snapPoints(segment))
      break
    case 'annotation':
      snaps.end = g.points
      break
    case 'hatch':
      break
    case 'point':
      snaps.end = [g.point]
      break
    case 'mesh':
      // Vertices snap as ends, unless there are so many that snapping would crawl.
      if (g.vertices.length / 3 <= SNAP_VERTEX_LIMIT) snaps.end = meshVertexPoints(g)
      break
    case 'instance':
      // The insertion point, then the snaps of what the block draws.
      snaps.end.push(insertionPoint(g))
      for (const s of instanceSnaps(g)) addSnaps(snaps, s)
      break
    case 'brep':
      // Corners and edge midpoints of surfaces and solids.
      for (const edge of wireframe(g)) {
        if (edge.length < 2) continue
        for (const p of [edge[0], edge[edge.length - 1]]) if (!snaps.end.some((q) => q.distanceTo(p) < TOLERANCE)) snaps.end.push(p)
        snaps.mid.push(edge[Math.floor(edge.length / 2)])
      }
      break
  }
  return snaps
}

export function snapPoints(g: Geometry): SnapPoints {
  let snaps = snapCache.get(g)
  if (!snaps) {
    snaps = buildSnapPoints(g)
    snapCache.set(g, snaps)
  }
  return snaps
}

export function expandBox(box: Box3, g: Geometry): void {
  for (const line of wireframe(g)) for (const p of line) box.expandByPoint(p)
}

export function typeName(g: Geometry): string {
  if (g.type === 'polyline') return g.points.length === 2 ? 'line' : 'polyline'
  if (g.type === 'brep') return g.kind
  if (g.type === 'hatch') return 'hatch'
  if (g.type === 'mesh') return 'mesh'
  if (g.type === 'point') return 'point'
  if (g.type === 'instance') return 'block'
  if (g.type === 'annotation') return g.kind === 'text' || g.kind === 'leader' ? g.kind : 'dimension'
  return g.type
}

// --- Persistence -------------------------------------------------------------------

type Triple = [number, number, number]

const toTriple = (v: Vector3): Triple => [v.x, v.y, v.z]
const fromTriple = (t: Triple): Vector3 => new Vector3(t[0], t[1], t[2])

export function geometryToJSON(g: Geometry): unknown {
  switch (g.type) {
    case 'polyline':
      return { type: g.type, points: g.points.map(toTriple), closed: g.closed }
    case 'circle':
      return { type: g.type, center: toTriple(g.center), xaxis: toTriple(g.xaxis), yaxis: toTriple(g.yaxis), radius: g.radius }
    case 'arc':
      return {
        type: g.type,
        center: toTriple(g.center),
        xaxis: toTriple(g.xaxis),
        yaxis: toTriple(g.yaxis),
        radius: g.radius,
        angle: g.angle,
      }
    case 'curve':
      return { type: g.type, degree: g.degree, points: g.points.map(toTriple), knots: g.knots, ...(g.weights ? { weights: g.weights } : {}) }
    case 'polycurve':
      return { type: g.type, segments: g.segments.map(geometryToJSON) }
    case 'hatch':
      return {
        type: g.type,
        loops: g.loops.map(geometryToJSON),
        pattern: g.pattern,
        scale: g.scale,
        rotation: g.rotation,
        origin: toTriple(g.origin),
        xaxis: toTriple(g.xaxis),
        yaxis: toTriple(g.yaxis),
      }
    case 'annotation':
      return {
        type: g.type,
        kind: g.kind,
        points: g.points.map(toTriple),
        xaxis: toTriple(g.xaxis),
        yaxis: toTriple(g.yaxis),
        text: g.text,
        height: g.height,
        arrow: g.arrow,
        precision: g.precision,
      }
    case 'brep':
      return { type: g.type, brep: g.brep, matrix: g.matrix, kind: g.kind, faces: g.faces, display: g.display }
    case 'instance':
      return { type: g.type, block: g.definition.name, matrix: g.matrix }
    case 'mesh':
      return { type: g.type, vertices: g.vertices, faces: g.faces }
    case 'point':
      return { type: g.type, point: toTriple(g.point) }
  }
}

/** Block definitions by name, for reading instances. */
export type BlockLookup = (name: string) => BlockDefinition | undefined

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geometryFromJSON(j: any, blocks?: BlockLookup): Geometry {
  const read = (x: unknown) => geometryFromJSON(x, blocks)
  switch (j.type) {
    case 'polyline':
      return { type: 'polyline', points: j.points.map(fromTriple), closed: !!j.closed }
    case 'circle':
      return { type: 'circle', center: fromTriple(j.center), xaxis: fromTriple(j.xaxis), yaxis: fromTriple(j.yaxis), radius: j.radius }
    case 'arc':
      return {
        type: 'arc',
        center: fromTriple(j.center),
        xaxis: fromTriple(j.xaxis),
        yaxis: fromTriple(j.yaxis),
        radius: j.radius,
        angle: j.angle,
      }
    case 'curve': {
      const points: Vector3[] = j.points.map(fromTriple)
      const degree = Math.min(j.degree, points.length - 1)
      // Files from before knots were stored used uniform clamped knots.
      const knots = j.knots ?? clampedKnots(points.length, degree)
      return { type: 'curve', degree, points, knots, ...(Array.isArray(j.weights) ? { weights: j.weights } : {}) }
    }
    case 'polycurve':
      return { type: 'polycurve', segments: j.segments.map(read) }
    case 'hatch':
      return {
        type: 'hatch',
        loops: j.loops.map(read),
        pattern: j.pattern,
        scale: j.scale,
        rotation: j.rotation ?? 0,
        origin: fromTriple(j.origin),
        xaxis: fromTriple(j.xaxis),
        yaxis: fromTriple(j.yaxis),
      }
    case 'annotation':
      return {
        type: 'annotation',
        kind: j.kind,
        points: j.points.map(fromTriple),
        xaxis: fromTriple(j.xaxis),
        yaxis: fromTriple(j.yaxis),
        text: j.text ?? '',
        height: j.height,
        arrow: j.arrow === 'tick' ? 'tick' : 'arrow',
        precision: j.precision ?? 2,
      }
    case 'brep':
      return { type: 'brep', brep: j.brep, matrix: j.matrix ?? null, kind: j.kind, faces: j.faces, display: j.display }
    case 'instance':
      // A missing definition reads as an empty block rather than failing the whole file.
      return { type: 'instance', definition: blocks?.(j.block) ?? { name: j.block, objects: [] }, matrix: j.matrix }
    case 'mesh':
      return { type: 'mesh', vertices: j.vertices, faces: j.faces }
    case 'point':
      return { type: 'point', point: fromTriple(j.point) }
    default:
      throw new Error(`Unknown geometry type: ${j.type}`)
  }
}
