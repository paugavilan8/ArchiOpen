import { Matrix4, Quaternion, Vector3 } from 'three'
import { wireframe, type Geometry, type Plane } from './geometry'

/**
 * The transforms behind Orient, Orient3Pt, Align and Distribute: placing objects by reference
 * points, and lining them up or spacing them out by their bounding boxes in a construction plane.
 */

/** How Orient scales what it moves: not at all, evenly, or only along the reference line. */
export type OrientScale = 'No' | 'Uniform' | 'OneDirection'

/**
 * Moves `from[0]` onto `to[0]` and, given second points, turns the line between the reference
 * points onto the line between the target points (by the smallest turn), scaling as asked so that
 * their lengths match.
 */
export function orientByPoints(from: Vector3[], to: Vector3[], scale: OrientScale = 'No'): Matrix4 {
  const [a0, a1] = from
  const [b0, b1] = to
  const m = new Matrix4().makeTranslation(-a0.x, -a0.y, -a0.z)
  if (a1 && b1) {
    const u = a1.clone().sub(a0)
    const v = b1.clone().sub(b0)
    if (u.length() < 1e-12 || v.length() < 1e-12) throw new Error('The reference and target points must not be the same point')
    const factor = v.length() / u.length()
    const ud = u.clone().normalize()
    if (scale === 'Uniform') m.premultiply(new Matrix4().makeScale(factor, factor, factor))
    if (scale === 'OneDirection') m.premultiply(stretch(ud, factor))
    m.premultiply(new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(ud, v.clone().normalize())))
  }
  return m.premultiply(new Matrix4().makeTranslation(b0.x, b0.y, b0.z))
}

/** Scale by `factor` along the unit direction `d` only. */
function stretch(d: Vector3, factor: number): Matrix4 {
  const k = factor - 1
  // prettier-ignore
  return new Matrix4().set(
    1 + k * d.x * d.x, k * d.x * d.y, k * d.x * d.z, 0,
    k * d.y * d.x, 1 + k * d.y * d.y, k * d.y * d.z, 0,
    k * d.z * d.x, k * d.z * d.y, 1 + k * d.z * d.z, 0,
    0, 0, 0, 1,
  )
}

/**
 * The frame of three points: origin at the first, X towards the second, Y on the side of the
 * third. Null if they are in a line.
 */
export function frameOf(p: Vector3[]): Matrix4 | null {
  const x = p[1].clone().sub(p[0])
  const toThird = p[2].clone().sub(p[0])
  if (x.length() < 1e-12) return null
  x.normalize()
  const z = x.clone().cross(toThird)
  if (z.length() < 1e-9 * Math.max(1, toThird.length())) return null
  z.normalize()
  const y = z.clone().cross(x)
  return new Matrix4().makeBasis(x, y, z).setPosition(p[0])
}

/** Moves and turns (without scaling) the frame of three reference points onto that of three targets. */
export function orientByThreePoints(from: Vector3[], to: Vector3[]): Matrix4 {
  const a = frameOf(from)
  const b = frameOf(to)
  if (!a || !b) throw new Error('The three points must not be in a line')
  return b.multiply(a.invert())
}

/** The extent of some geometry along the axes of a construction plane: [min, max] in x, y and z. */
export interface PlaneBox {
  min: Vector3
  max: Vector3
}

/**
 * The points that bound a geometry: its drawn lines, and for surfaces and meshes their vertices too
 * (a sphere's edges, a seam and two poles, say nothing of its width).
 */
function boundingPoints(g: Geometry, visit: (x: number, y: number, z: number) => void): void {
  const flat = g.type === 'brep' ? g.display.vertices : g.type === 'mesh' ? g.vertices : null
  if (flat) for (let i = 0; i < flat.length; i += 3) visit(flat[i], flat[i + 1], flat[i + 2])
  for (const line of wireframe(g)) for (const p of line) visit(p.x, p.y, p.z)
}

/** Bounding box of some geometries, measured along the plane's axes from its origin. */
export function boxInPlane(geometries: Geometry[], plane: Plane): PlaneBox {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  const { origin, xaxis, yaxis, normal } = plane
  for (const g of geometries) {
    boundingPoints(g, (x, y, z) => {
      const dx = x - origin.x
      const dy = y - origin.y
      const dz = z - origin.z
      const u = dx * xaxis.x + dy * xaxis.y + dz * xaxis.z
      const v = dx * yaxis.x + dy * yaxis.y + dz * yaxis.z
      const w = dx * normal.x + dy * normal.y + dz * normal.z
      min.set(Math.min(min.x, u), Math.min(min.y, v), Math.min(min.z, w))
      max.set(Math.max(max.x, u), Math.max(max.y, v), Math.max(max.z, w))
    })
  }
  return { min, max }
}

export type AlignMode = 'Bottom' | 'HorizontalCenter' | 'Left' | 'Right' | 'Top' | 'VerticalCenter' | 'Center'
export const ALIGN_MODES: AlignMode[] = ['Bottom', 'HorizontalCenter', 'Left', 'Right', 'Top', 'VerticalCenter', 'Center']

/** Where a box is along x and y for an alignment (null where the alignment leaves it alone). */
function alignAt(box: PlaneBox, mode: AlignMode): [number | null, number | null] {
  const cx = (box.min.x + box.max.x) / 2
  const cy = (box.min.y + box.max.y) / 2
  switch (mode) {
    case 'Left':
      return [box.min.x, null]
    case 'Right':
      return [box.max.x, null]
    case 'HorizontalCenter':
      return [cx, null]
    case 'Bottom':
      return [null, box.min.y]
    case 'Top':
      return [null, box.max.y]
    case 'VerticalCenter':
      return [null, cy]
    case 'Center':
      return [cx, cy]
  }
}

/**
 * How far to move each box (along the plane's x and y) to line them up. They line up on `target`
 * (plane coordinates) where given, otherwise on the bounding box of them all: their left edge for
 * Left, their center for the centers, and so on.
 */
export function alignOffsets(boxes: PlaneBox[], mode: AlignMode, target?: { x: number; y: number }): { x: number; y: number }[] {
  const all: PlaneBox = {
    min: new Vector3(Math.min(...boxes.map((b) => b.min.x)), Math.min(...boxes.map((b) => b.min.y)), 0),
    max: new Vector3(Math.max(...boxes.map((b) => b.max.x)), Math.max(...boxes.map((b) => b.max.y)), 0),
  }
  const [tx, ty] = target ? [target.x, target.y] : alignAt(all, mode)
  return boxes.map((box) => {
    const [x, y] = alignAt(box, mode)
    return { x: x === null ? 0 : (tx ?? 0) - x, y: y === null ? 0 : (ty ?? 0) - y }
  })
}

export type DistributeMode = 'Centers' | 'Gaps'

/**
 * How far to move each box along one axis (0, 1 or 2: the plane's x, y or normal) to space them out.
 * Their order along the axis is kept. With no spacing the first and last stay where they are and
 * those between are spread evenly; with one, the first stays and the rest follow at that spacing.
 * Centers spaces their centers; Gaps leaves equal room between one box and the next.
 */
export function distributeOffsets(boxes: PlaneBox[], axis: 0 | 1 | 2, mode: DistributeMode, spacing?: number): number[] {
  const lo = (b: PlaneBox) => b.min.getComponent(axis)
  const hi = (b: PlaneBox) => b.max.getComponent(axis)
  const center = (b: PlaneBox) => (lo(b) + hi(b)) / 2
  const order = boxes.map((_, i) => i).sort((i, j) => center(boxes[i]) - center(boxes[j]))
  const offsets = boxes.map(() => 0)
  const n = order.length
  if (n < 2) return offsets
  const first = boxes[order[0]]
  const last = boxes[order[n - 1]]
  if (mode === 'Centers') {
    const step = spacing ?? (center(last) - center(first)) / (n - 1)
    order.forEach((i, k) => (offsets[i] = center(first) + step * k - center(boxes[i])))
  } else {
    const sizes = order.map((i) => hi(boxes[i]) - lo(boxes[i]))
    const total = sizes.reduce((a, b) => a + b, 0)
    const gap = spacing ?? (hi(last) - lo(first) - total) / (n - 1)
    let at = lo(first)
    order.forEach((i, k) => {
      offsets[i] = at - lo(boxes[i])
      at += sizes[k] + gap
    })
  }
  return offsets
}
