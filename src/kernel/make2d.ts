import { Box3, Vector3 } from 'three'
import * as R from 'replicad'
import { join } from '../core/curves'
import { type ClipPlane, clipCurve, clipMesh, clipPolygon, isKept } from '../core/clipPlanes'
import { AnyCurve, BrepGeometry, MeshGeometry, tessellate } from '../core/geometry'
import { drawMeshes } from '../core/meshDrawing'
import { curveToEdges, sectionCurves } from './brep'
import { edgeToCurve } from './edges'

type TopoShape = ReturnType<ReturnType<typeof R.getOC>['BRepToolsWrapper']['Read']>

/** A parallel view: `direction` points from the model towards the viewer, `xaxis` is right on the drawing. */
export interface DrawingView {
  direction: Vector3
  xaxis: Vector3
}

export interface Drawing2D {
  visible: AnyCurve[]
  hidden: AnyCurve[]
  /** Visible lines where clipping planes cut through surfaces and solids (drawn heavier). */
  section?: AnyCurve[]
  /**
   * The cut faces of solids, to fill: for each solid and plane, its outline loops (loops inside
   * others are holes), in the drawing's plane. Only for planes the view looks straight at from the
   * side they cut away (plans and sections), where the cut faces are in front of everything.
   */
  fills?: Vector3[][][]
}

/**
 * Make2D with meshes too: surfaces, solids and curves through the kernel's hidden line removal, and
 * meshes by their silhouettes, creases and borders, hidden by the meshes and by the surfaces.
 * (Surfaces' own lines are not hidden by meshes.)
 *
 * With clipping planes, what they cut away is left out first: solids are cut (and closed along the
 * cut, so its outline is drawn), curves and meshes are trimmed. The visible lines along a cut are
 * returned apart, as `section`.
 */
export function make2DWithMeshes(
  shapes: R.AnyShape[],
  surfaces: BrepGeometry[],
  curves: AnyCurve[],
  meshes: MeshGeometry[],
  view: DrawingView,
  withHidden: boolean,
  clip: ClipPlane[] = [],
): Drawing2D {
  let cuts: AnyCurve[] = []
  const fills: Vector3[][][] = []
  if (clip.length > 0) {
    const toward = view.direction.clone().normalize()
    shapes.forEach((shape, s) => {
      if (surfaces[s]?.kind !== 'solid') return
      clip.forEach((plane, i) => {
        if (plane.normal.dot(toward) > -0.999) return
        const loops = sectionsOf(shape, plane)
          .map((c) => tessellate(c))
          // Closed outlines only, as far as the other planes keep them.
          .filter((pts) => pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6 * Math.max(1, pts[0].length()))
          .map((pts) => clipPolygon(pts.slice(0, -1), clip.filter((_, k) => k !== i)))
          .filter((pts) => pts.length >= 3)
          .map((pts) => pts.map((p) => toView(p, view)))
        if (loops.length > 0) fills.push(loops)
      })
    })
    // Where each plane cuts, as far as the other planes keep it.
    cuts = shapes.flatMap((shape) => clip.flatMap((plane, i) => sectionsOf(shape, plane).flatMap((c) => clipCurve(c, clip.filter((_, k) => k !== i)))))
    shapes = shapes.flatMap((shape) => clipShape(shape, clip) ?? [])
    curves = curves.flatMap((c) => clipCurve(c, clip))
    meshes = meshes.flatMap((m) => clipMesh(m, clip) ?? [])
  }
  const drawing = shapes.length > 0 || curves.length > 0 ? make2D(shapes, curves, view, withHidden) : { visible: [], hidden: [] }
  if (meshes.length > 0) {
    // Surfaces hide meshes, as far as the planes keep them.
    const occluderMeshes = surfaces.flatMap((g) => clipMesh({ type: 'mesh', vertices: g.display.vertices, faces: trianglesAsFaces(g.display.triangles) }, clip) ?? [])
    const occluders = occluderMeshes.map((g) => g.faces.flatMap((i, n) => (n % 4 === 3 ? [] : [g.vertices[3 * i], g.vertices[3 * i + 1], g.vertices[3 * i + 2]])))
    const lines = drawMeshes(meshes, view, occluders, withHidden)
    const polyline = (points: Vector3[]): AnyCurve => ({ type: 'polyline', points, closed: false })
    drawing.visible.push(...lines.visible.map(polyline))
    drawing.hidden.push(...lines.hidden.map(polyline))
  }
  if (cuts.length === 0) return fills.length > 0 ? { ...drawing, fills } : drawing
  // The cut outlines, seen from the view: visible lines lying on them are section lines.
  const section = separateSections(drawing.visible, cuts.map((c) => tessellate(c).map((p) => toView(p, view))))
  return { visible: section.rest, hidden: drawing.hidden, section: section.on, ...(fills.length > 0 ? { fills } : {}) }
}

/** Display triangles as mesh faces (a triangle repeats its last corner). */
const trianglesAsFaces = (t: number[]) => t.flatMap((_, i) => (i % 3 === 2 ? [t[i - 2], t[i - 1], t[i], t[i]] : []))

/** A point in the drawing's plane: X to the right of the view, Y up, as make2D draws. */
function toView(p: Vector3, view: DrawingView): Vector3 {
  const d = view.direction.clone().normalize()
  const x = view.xaxis.clone().addScaledVector(d, -view.xaxis.dot(d)).normalize()
  const y = d.clone().cross(x)
  return new Vector3(p.dot(x), p.dot(y), 0)
}

/** Where a plane cuts a shape (nothing if the cut fails). */
function sectionsOf(shape: R.AnyShape, plane: ClipPlane): AnyCurve[] {
  try {
    return sectionCurves(shape, plane.origin, plane.normal)
  } catch {
    return []
  }
}

/** The corners of a shape's bounding box. */
function boxCorners(shape: R.AnyShape): Vector3[] {
  const [min, max] = shape.boundingBox.bounds
  const corners: Vector3[] = []
  for (let i = 0; i < 8; i++) corners.push(new Vector3(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]))
  return corners
}

/**
 * What the planes keep of a shape: cut with the half-space each plane removes, so a solid stays a
 * solid, closed along the cut. Null if nothing is left. A plane that misses the shape is skipped;
 * if a cut fails, the shape is kept whole rather than lost.
 */
function clipShape(shape: R.AnyShape, planes: ClipPlane[]): R.AnyShape | null {
  const k = R.getOC()
  let current = shape
  for (const plane of planes) {
    const corners = boxCorners(current)
    const keptCorners = corners.filter((p) => isKept([plane], p)).length
    if (keptCorners === corners.length) continue
    if (keptCorners === 0) return null
    const { origin: o, normal: n } = plane
    try {
      const pln = new k.gp_Pln(new k.gp_Pnt(o.x, o.y, o.z), new k.gp_Dir(n.x, n.y, n.z))
      const face = new k.BRepBuilderAPI_MakeFace(pln).Face()
      // The half-space on the side the plane removes.
      const halfSpace = new k.BRepPrimAPI_MakeHalfSpace(face, new k.gp_Pnt(o.x - n.x, o.y - n.y, o.z - n.z)).Solid()
      const cut = new k.BRepAlgoAPI_Cut(current.wrapped, halfSpace)
      cut.Build()
      if (cut.HasErrors()) continue
      const result = R.cast(cut.Shape())
      if (result.faces.length === 0 && result.edges.length === 0) return null
      current = result
    } catch {
      // Kept whole.
    }
  }
  return current
}

/**
 * Splits drawn lines into those lying on the cut outlines and the rest. A line partly on an
 * outline (make2D joins the lines it draws) is split into runs of segments on and off it.
 */
function separateSections(lines: AnyCurve[], cuts: Vector3[][]): { on: AnyCurve[]; rest: AnyCurve[] } {
  const all = [...lines.flatMap(tessellate), ...cuts.flat()]
  if (all.length === 0) return { on: [], rest: lines }
  const box = new Box3().setFromPoints(all)
  const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 1e-9)
  const tolerance = size * 1e-4
  const grid = new SegmentGrid(box, size / 64)
  for (const c of cuts) grid.add(c)
  const on: AnyCurve[] = []
  const rest: AnyCurve[] = []
  const polyline = (points: Vector3[]): AnyCurve => ({ type: 'polyline', points, closed: false })
  for (const line of lines) {
    const points = tessellate(line)
    const onCut = points.slice(1).map((p, i) => grid.near(p, tolerance) && grid.near(points[i], tolerance) && grid.near(p.clone().lerp(points[i], 0.5), tolerance))
    if (onCut.every(Boolean)) on.push(line)
    else if (!onCut.some(Boolean)) rest.push(line)
    else {
      // Runs of segments on one side or the other.
      let start = 0
      for (let i = 1; i <= onCut.length; i++) {
        if (i < onCut.length && onCut[i] === onCut[start]) continue
        ;(onCut[start] ? on : rest).push(polyline(points.slice(start, i + 1)))
        start = i
      }
    }
  }
  return { on, rest }
}

const edgesOf = (shape: TopoShape): R.Edge[] => (shape.IsNull() ? [] : R.cast(shape).edges)

/**
 * Hidden line drawing of surfaces, solids and curves seen from a view. The result lies in the XY
 * plane, with X to the right of the view and Y up, and the view's origin at the world origin.
 * Surfaces hide what is behind them, curves included.
 */
export function make2D(shapes: R.AnyShape[], curves: AnyCurve[], view: DrawingView, withHidden: boolean): Drawing2D {
  const k = R.getOC()
  // Everything goes in one compound so that objects hide each other.
  const builder = new k.TopoDS_Builder()
  const compound = new k.TopoDS_Compound()
  builder.MakeCompound(compound)
  for (const shape of shapes) builder.Add(compound, shape.wrapped)
  for (const curve of curves) for (const edge of curveToEdges(curve)) builder.Add(compound, edge.wrapped)

  const d = view.direction.clone().normalize()
  const x = view.xaxis.clone().addScaledVector(d, -view.xaxis.dot(d)).normalize()
  const axes = new k.gp_Ax2(new k.gp_Pnt(0, 0, 0), new k.gp_Dir(d.x, d.y, d.z), new k.gp_Dir(x.x, x.y, x.z))
  const projector = new k.HLRAlgo_Projector(axes)
  const algo = new k.HLRBRep_Algo()
  algo.Add(compound, 0)
  algo.Projector(projector)
  algo.Update()
  algo.Hide()
  const result = new k.HLRBRep_HLRToShape(algo)

  const collect = (parts: TopoShape[]): AnyCurve[] => {
    const pieces: AnyCurve[] = []
    for (const part of parts) {
      for (const edge of edgesOf(part)) {
        k.BRepLib.BuildCurves3d(edge.wrapped)
        const curve = edgeToCurve(edge)
        if (curve) pieces.push(curve)
      }
    }
    return pieces
  }
  // Sharp edges, smooth (tangent) edges and silhouettes; seams are left out.
  const visible = collect([result.VCompound(), result.Rg1LineVCompound(), result.OutLineVCompound()])
  const hidden = withHidden ? collect([result.HCompound(), result.Rg1LineHCompound(), result.OutLineHCompound()]) : []

  result.delete()
  algo.delete()
  projector.delete()
  axes.delete()
  return { visible: join(visible).map((j) => j.geometry), hidden: join(withoutOverlaps(hidden, visible)).map((j) => j.geometry) }
}

/**
 * Drops hidden lines that lie on a visible line or on another hidden line: seen straight on, the back
 * edges of a box fall exactly behind its front edges and would only clutter the drawing.
 */
function withoutOverlaps(hidden: AnyCurve[], visible: AnyCurve[]): AnyCurve[] {
  const all = [...visible, ...hidden]
  if (hidden.length === 0) return hidden
  const box = new Box3().setFromPoints(all.flatMap(tessellate))
  const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 1e-9)
  const tolerance = size * 1e-5
  const grid = new SegmentGrid(box, size / 64)
  for (const c of visible) grid.add(tessellate(c))
  const kept: AnyCurve[] = []
  for (const c of hidden) {
    const points = tessellate(c)
    const probes = [...points, ...points.slice(1).map((p, i) => p.clone().lerp(points[i], 0.5))]
    if (probes.every((p) => grid.near(p, tolerance))) continue
    kept.push(c)
    grid.add(points)
  }
  return kept
}

/** Segments of 2D polylines in a uniform grid, to find quickly whether a point lies on any of them. */
class SegmentGrid {
  private readonly cells = new Map<string, [Vector3, Vector3][]>()
  constructor(
    private readonly box: Box3,
    private readonly cell: number,
  ) {}

  private key(i: number, j: number) {
    return `${i},${j}`
  }

  private index(x: number, y: number): [number, number] {
    return [Math.floor((x - this.box.min.x) / this.cell), Math.floor((y - this.box.min.y) / this.cell)]
  }

  add(points: Vector3[]): void {
    for (let n = 1; n < points.length; n++) {
      const a = points[n - 1]
      const b = points[n]
      const [i0, j0] = this.index(Math.min(a.x, b.x), Math.min(a.y, b.y))
      const [i1, j1] = this.index(Math.max(a.x, b.x), Math.max(a.y, b.y))
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = this.key(i, j)
          let list = this.cells.get(key)
          if (!list) this.cells.set(key, (list = []))
          list.push([a, b])
        }
      }
    }
  }

  near(p: Vector3, tolerance: number): boolean {
    const [i, j] = this.index(p.x, p.y)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [a, b] of this.cells.get(this.key(i + di, j + dj)) ?? []) {
          if (distanceToSegment(p, a, b) <= tolerance) return true
        }
      }
    }
    return false
  }
}

function distanceToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
