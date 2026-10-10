import { Vector3 } from 'three'
import * as R from 'replicad'

/**
 * UnrollSrf: flattens developable faces (planes, cylinders and cones) into the XY plane, keeping
 * lengths, for cutting patterns. Each face is laid flat through its own surface parameters, which
 * for these surfaces map to the plane without stretching:
 * - a plane by its own coordinates;
 * - a cylinder of radius r by (r·u, v);
 * - a cone by turning its slant lines about the apex by u·sin(α) (α the half angle).
 * Faces that share a straight edge stay joined along it, as a folding pattern; the rest are laid out
 * in a row. Faces of other kinds (spheres, free-form) cannot be flattened exactly and are skipped.
 */

type Shape = ReturnType<ReturnType<typeof R.getOC>['BRepToolsWrapper']['Read']>
const oc = () => R.getOC()

/** A 2D rigid placement: rotation by `angle`, then a move by (dx, dy); `mirror` flips x first. */
interface Placement {
  angle: number
  dx: number
  dy: number
  mirror: boolean
}

const IDENTITY: Placement = { angle: 0, dx: 0, dy: 0, mirror: false }

function place(p: Vector3, t: Placement): Vector3 {
  const x = t.mirror ? -p.x : p.x
  const c = Math.cos(t.angle)
  const s = Math.sin(t.angle)
  return new Vector3(c * x - s * p.y + t.dx, s * x + c * p.y + t.dy, 0)
}

/** A straight edge of a flattened face: its two ends in the face's own flat coordinates and in space. */
interface FlatEdge {
  edge: Shape
  flat: [Vector3, Vector3]
  space: [Vector3, Vector3]
}

interface FlatFace {
  loops: Vector3[][]
  straight: FlatEdge[]
}

export interface Unrolled {
  /** Each face's outline loops (outer and holes), placed in the XY plane. */
  faces: Vector3[][][]
  /** Faces that could not be flattened (not planes, cylinders or cones). */
  skipped: number
}

function explore(shape: Shape, kind: 'FACE' | 'VERTEX'): Shape[] {
  const k = oc()
  const out: Shape[] = []
  const ex = new k.TopExp_Explorer(shape, k.TopAbs_ShapeEnum[`TopAbs_${kind}`], k.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; ex.More(); ex.Next()) out.push(ex.Current())
  ex.delete()
  return out
}

/** The flattening of a face's parameters, or null if its surface does not develop onto a plane. */
function flattener(face: Shape): ((u: number, v: number) => Vector3) | null {
  const k = oc()
  const S = k.GeomAbs_SurfaceType
  const adaptor = new k.BRepAdaptor_Surface(face, false)
  const type = adaptor.GetType()
  if (type === S.GeomAbs_Plane) return (u, v) => new Vector3(u, v, 0)
  if (type === S.GeomAbs_Cylinder) {
    const r = adaptor.Cylinder().Radius()
    return (u, v) => new Vector3(r * u, v, 0)
  }
  if (type === S.GeomAbs_Cone) {
    // A cone's radius grows by sin(α) per unit along its slant lines (v): measured across the axis,
    // from points half a turn apart.
    const surface = k.BRep_Tool.Surface(face)
    const radius = (v: number) => xyz(surface.Value(0, v)).distanceTo(xyz(surface.Value(Math.PI, v))) / 2
    const sin = radius(1) - radius(0)
    if (Math.abs(sin) < 1e-12) return null
    const apex = radius(0) / sin
    return (u, v) => {
      const s = v + apex
      const phi = u * sin
      return new Vector3(s * Math.cos(phi), s * Math.sin(phi), 0)
    }
  }
  return null
}

const xyz = (p: { X(): number; Y(): number; Z(): number }) => new Vector3(p.X(), p.Y(), p.Z())

/** A face laid flat in its own coordinates, seen from outside (its normal towards the viewer). */
function flatten(f: Shape): FlatFace | null {
  const k = oc()
  const face = k.TopoDS.Face(f.Oriented(k.TopAbs_Orientation.TopAbs_FORWARD))
  const map = flattener(face)
  if (!map) return null
  // A face turned over is seen from its other side: mirrored, so the pattern reads from outside.
  const turned = f.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED
  const at = (u: number, v: number) => {
    const p = map(u, v)
    return turned ? new Vector3(-p.x, p.y, 0) : p
  }
  const loops: Vector3[][] = []
  const straight: FlatEdge[] = []
  const wires = new k.TopExp_Explorer(face, k.TopAbs_ShapeEnum.TopAbs_WIRE, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; wires.More(); wires.Next()) {
    const runs: Vector3[][] = []
    const edges = new k.TopExp_Explorer(wires.Current(), k.TopAbs_ShapeEnum.TopAbs_EDGE, k.TopAbs_ShapeEnum.TopAbs_SHAPE)
    for (; edges.More(); edges.Next()) {
      const edge = k.TopoDS.Edge(edges.Current())
      const backwards = edge.Orientation() === k.TopAbs_Orientation.TopAbs_REVERSED
      const pcurve = new k.BRepAdaptor_Curve2d(edge, face)
      const curve3d = new k.BRepAdaptor_Curve(edge)
      const isLine = curve3d.GetType() === k.GeomAbs_CurveType.GeomAbs_Line
      const [t0, t1] = [pcurve.FirstParameter(), pcurve.LastParameter()]
      const steps = isLine ? 1 : 64
      const points: Vector3[] = []
      for (let i = 0; i <= steps; i++) {
        const t = backwards ? t1 - ((t1 - t0) * i) / steps : t0 + ((t1 - t0) * i) / steps
        const uv = pcurve.Value(t)
        points.push(at(uv.X(), uv.Y()))
      }
      runs.push(points)
      if (isLine) {
        const a = xyz(curve3d.Value(backwards ? t1 : t0))
        const b = xyz(curve3d.Value(backwards ? t0 : t1))
        // Degenerate edges (a cone's apex) join nothing.
        if (a.distanceTo(b) > 1e-9) straight.push({ edge, flat: [points[0], points[points.length - 1]], space: [a, b] })
      }
    }
    edges.delete()
    const loop = chainRuns(runs)
    if (loop.length > 2 && loop[0].distanceTo(loop[loop.length - 1]) < 1e-7) loop.pop()
    if (loop.length > 2) loops.push(loop)
  }
  wires.delete()
  return loops.length > 0 ? { loops, straight } : null
}

/** Edges of a wire (as point runs) joined end to end into one loop, whatever order they came in. */
function chainRuns(runs: Vector3[][]): Vector3[] {
  const left = runs.filter((r) => r.length > 1)
  if (left.length === 0) return []
  const loop = [...left.shift()!]
  while (left.length > 0) {
    const end = loop[loop.length - 1]
    let best = 0
    let flip = false
    let distance = Infinity
    left.forEach((run, i) => {
      const d0 = run[0].distanceTo(end)
      const d1 = run[run.length - 1].distanceTo(end)
      if (d0 < distance) [best, flip, distance] = [i, false, d0]
      if (d1 < distance) [best, flip, distance] = [i, true, d1]
    })
    const run = left.splice(best, 1)[0]
    const next = flip ? [...run].reverse() : run
    loop.push(...next.slice(next[0].distanceTo(end) < 1e-7 ? 1 : 0))
  }
  return loop
}

/** The rigid placement taking segment b0–b1 onto a0–a1 (mirrored first if asked). */
function onto(b0: Vector3, b1: Vector3, a0: Vector3, a1: Vector3, mirror: boolean): Placement {
  const m0 = mirror ? new Vector3(-b0.x, b0.y) : b0
  const m1 = mirror ? new Vector3(-b1.x, b1.y) : b1
  const angle = Math.atan2(a1.y - a0.y, a1.x - a0.x) - Math.atan2(m1.y - m0.y, m1.x - m0.x)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { angle, mirror, dx: a0.x - (c * m0.x - s * m0.y), dy: a0.y - (s * m0.x + c * m0.y) }
}

const centroid = (loops: Vector3[][]) => {
  const all = loops.flat()
  return all.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / all.length)
}

/** Which side of the line through a–b a point is on. */
const side = (a: Vector3, b: Vector3, p: Vector3) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))

/** Unrolls the developable faces of a shape; with `separate`, each face is its own piece. */
export function unrollShape(shape: R.AnyShape, separate = false): Unrolled {
  const all = explore(shape.wrapped, 'FACE')
  const flat: (FlatFace | null)[] = all.map(flatten)
  const skipped = flat.filter((f) => f === null).length
  const placed: (Placement | null)[] = flat.map(() => null)
  const islands: number[][] = []

  for (let start = 0; start < flat.length; start++) {
    if (!flat[start] || placed[start]) continue
    placed[start] = IDENTITY
    const island = [start]
    const queue = [start]
    while (queue.length > 0 && !separate) {
      const a = queue.shift()!
      for (const ea of flat[a]!.straight) {
        for (let b = 0; b < flat.length; b++) {
          if (placed[b] || !flat[b]) continue
          const eb = flat[b]!.straight.find((e) => e.edge.IsSame(ea.edge))
          if (!eb) continue
          // The shared edge's ends, matched through space.
          const same = eb.space[0].distanceTo(ea.space[0]) < eb.space[0].distanceTo(ea.space[1])
          const a0 = place(ea.flat[0], placed[a]!)
          const a1 = place(ea.flat[1], placed[a]!)
          const [b0, b1] = same ? eb.flat : [eb.flat[1], eb.flat[0]]
          let t = onto(b0, b1, a0, a1, false)
          // Joined faces lie on either side of their fold.
          if (side(a0, a1, place(centroid(flat[b]!.loops), t)) === side(a0, a1, place(centroid(flat[a]!.loops), placed[a]!))) t = onto(b0, b1, a0, a1, true)
          placed[b] = t
          island.push(b)
          queue.push(b)
        }
      }
    }
    islands.push(island)
  }

  // Pieces in a row, left to right, with a gap between them.
  const faces: Vector3[][][] = []
  const pieces = islands.map((island) => island.map((i) => flat[i]!.loops.map((loop) => loop.map((p) => place(p, placed[i]!)))))
  const boxes = pieces.map((piece) => {
    const points = piece.flat(2)
    return { minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)) }
  })
  const gap = Math.max(...boxes.map((b) => Math.max(b.maxX - b.minX, b.maxY - b.minY)), 0) * 0.1
  let x = 0
  pieces.forEach((piece, i) => {
    const shift = new Vector3(x - boxes[i].minX, -boxes[i].minY, 0)
    for (const loops of piece) faces.push(loops.map((loop) => loop.map((p) => p.clone().add(shift))))
    x += boxes[i].maxX - boxes[i].minX + gap
  })
  return { faces, skipped }
}
