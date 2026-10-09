import { Box3, Vector3 } from 'three'
import * as R from 'replicad'
import { join } from '../core/curves'
import { AnyCurve, BrepGeometry, MeshGeometry, tessellate } from '../core/geometry'
import { drawMeshes } from '../core/meshDrawing'
import { curveToEdges } from './brep'
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
}

/**
 * Make2D with meshes too: surfaces, solids and curves through the kernel's hidden line removal, and
 * meshes by their silhouettes, creases and borders, hidden by the meshes and by the surfaces.
 * (Surfaces' own lines are not hidden by meshes.)
 */
export function make2DWithMeshes(shapes: R.AnyShape[], surfaces: BrepGeometry[], curves: AnyCurve[], meshes: MeshGeometry[], view: DrawingView, withHidden: boolean): Drawing2D {
  const drawing = shapes.length > 0 || curves.length > 0 ? make2D(shapes, curves, view, withHidden) : { visible: [], hidden: [] }
  if (meshes.length === 0) return drawing
  const occluders = surfaces.map((g) => {
    const { vertices: v, triangles: t } = g.display
    return t.flatMap((i) => [v[3 * i], v[3 * i + 1], v[3 * i + 2]])
  })
  const lines = drawMeshes(meshes, view, occluders, withHidden)
  const polyline = (points: Vector3[]): AnyCurve => ({ type: 'polyline', points, closed: false })
  return { visible: [...drawing.visible, ...lines.visible.map(polyline)], hidden: [...drawing.hidden, ...lines.hidden.map(polyline)] }
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
