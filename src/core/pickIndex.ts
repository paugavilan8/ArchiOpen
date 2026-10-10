import type { Vector3 } from 'three'
import { SNAP_POINT_KINDS, snapPoints, wireframe, type Geometry, type SnapPoints } from './geometry'

/**
 * Bounding volume hierarchies over everything the cursor can land on, so picking, object snaps and
 * window selection look only at what comes near the cursor (or the window) on screen instead of
 * projecting every point of the model at every mouse move.
 *
 * Two levels, as renderers do: each geometry has its own tree over short runs of its drawn lines
 * and small groups of its snap points, kept for as long as the geometry is unchanged; over them, a
 * tree of the model's objects, made again (quickly) when the model changes.
 */

/** A piece of a polyline: points[from..to], both included. */
export interface Range {
  points: Vector3[]
  from: number
  to: number
}

/** Some runs of an object's drawn lines (`kind` 'line'), or a group of snap points of one kind. */
export interface PickItem {
  kind: 'line' | keyof SnapPoints
  /** In the order an object's lines (or its snaps, by kind) are gone through. */
  ranges: Range[]
  /** Where the item comes in that order: ties between equally near candidates go to the first. */
  seq: number
}

export interface ScreenRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Projects a world point to the screen; false if it is outside the view's depth range. */
export type Projector = (p: Vector3, out: { x: number; y: number }) => boolean

/** Points per item, and items (or objects) per leaf. */
const RUN = 16
const LEAF = 8

/** A tree over boxes (6 numbers each: min x, y, z, then max). Leaves hold up to LEAF entries. */
class Bvh {
  readonly order: Int32Array
  // Per node: its box, then either its two children or (left = -1) a leaf's range in `order`.
  readonly nodeBox: number[] = []
  readonly left: number[] = []
  readonly right: number[] = []
  readonly start: number[] = []
  readonly count: number[] = []

  constructor(readonly boxes: Float64Array) {
    const n = boxes.length / 6
    this.order = Int32Array.from({ length: n }, (_, i) => i)
    const centers = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) centers[i * 3 + c] = (boxes[i * 6 + c] + boxes[i * 6 + 3 + c]) / 2
    if (n > 0) this.split(0, n, centers)
  }

  get box(): number[] {
    return this.nodeBox.length > 0 ? this.nodeBox.slice(0, 6) : [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  }

  /** The node for order[start..end), split at the median along its longest side. */
  private split(start: number, end: number, centers: Float64Array): number {
    const node = this.left.length
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = start; i < end; i++) {
      const b = this.order[i] * 6
      for (let c = 0; c < 3; c++) {
        if (this.boxes[b + c] < box[c]) box[c] = this.boxes[b + c]
        if (this.boxes[b + 3 + c] > box[3 + c]) box[3 + c] = this.boxes[b + 3 + c]
      }
    }
    this.nodeBox.push(...box)
    this.left.push(-1)
    this.right.push(-1)
    this.start.push(start)
    this.count.push(end - start)
    if (end - start <= LEAF) return node
    const sizes = [box[3] - box[0], box[4] - box[1], box[5] - box[2]]
    const axis = sizes.indexOf(Math.max(...sizes))
    this.order.subarray(start, end).sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis])
    const mid = (start + end) >> 1
    this.left[node] = this.split(start, mid, centers)
    this.right[node] = this.split(mid, end, centers)
    return node
  }

  /**
   * Visits the entries whose boxes may reach the screen rectangle, telling whether each is surely
   * wholly within it (`classify` says where a box lands: 0 off, 1 partly or unknown, 2 within).
   */
  query(classify: (box: ArrayLike<number>, offset: number) => number, visit: (entry: number, inside: boolean) => void): void {
    if (this.left.length === 0) return
    const stack = [0]
    while (stack.length > 0) {
      const node = stack.pop()!
      const where = classify(this.nodeBox, node * 6)
      if (where === 0) continue
      if (where === 2) {
        for (let i = this.start[node]; i < this.start[node] + this.count[node]; i++) visit(this.order[i], true)
        continue
      }
      if (this.left[node] >= 0) {
        stack.push(this.right[node], this.left[node])
        continue
      }
      for (let i = this.start[node]; i < this.start[node] + this.count[node]; i++) {
        const entry = this.order[i]
        const at = classify(this.boxes, entry * 6)
        if (at > 0) visit(entry, at === 2)
      }
    }
  }
}

/** The tree of one geometry: its items, their boxes, and how many hold its drawn lines. */
interface GeometryTree {
  items: PickItem[]
  bvh: Bvh
  /** Line items: all of them in a window means the whole object is. */
  lineItems: number
}

const trees = new WeakMap<Geometry, GeometryTree>()

/** Groups ranges into items of about RUN points, in order. */
function group(kind: PickItem['kind'], ranges: Range[], items: PickItem[]): void {
  let current: Range[] = []
  let size = 0
  const flush = () => {
    if (current.length > 0) items.push({ kind, ranges: current, seq: items.length })
    current = []
    size = 0
  }
  for (const r of ranges) {
    current.push(r)
    size += r.to - r.from + 1
    if (size >= RUN) flush()
  }
  flush()
}

function treeOf(g: Geometry): GeometryTree {
  let tree = trees.get(g)
  if (tree) return tree
  const items: PickItem[] = []
  // Lines cut into runs of RUN segments; short lines (like a mesh's edges) share runs.
  const runs: Range[] = []
  for (const line of wireframe(g)) {
    if (line.length === 0) continue
    if (line.length === 1) runs.push({ points: line, from: 0, to: 0 })
    for (let from = 0; from < line.length - 1; from += RUN) runs.push({ points: line, from, to: Math.min(line.length - 1, from + RUN) })
  }
  group('line', runs, items)
  const lineItems = items.length
  const snaps = snapPoints(g)
  for (const kind of SNAP_POINT_KINDS) {
    const pts = snaps[kind]
    group(
      kind,
      pts.map((_, i) => ({ points: pts, from: i, to: i })),
      items,
    )
  }
  const boxes = new Float64Array(items.length * 6)
  items.forEach((item, i) => {
    const b = i * 6
    boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b)
    for (const r of item.ranges) {
      for (let k = r.from; k <= r.to; k++) {
        const p = r.points[k]
        if (p.x < boxes[b]) boxes[b] = p.x
        if (p.y < boxes[b + 1]) boxes[b + 1] = p.y
        if (p.z < boxes[b + 2]) boxes[b + 2] = p.z
        if (p.x > boxes[b + 3]) boxes[b + 3] = p.x
        if (p.y > boxes[b + 4]) boxes[b + 4] = p.y
        if (p.z > boxes[b + 5]) boxes[b + 5] = p.z
      }
    }
  })
  tree = { items, bvh: new Bvh(boxes), lineItems }
  trees.set(g, tree)
  return tree
}

interface Source {
  id: number
  geometry: Geometry
}

export class PickIndex {
  private readonly ids: number[] = []
  private readonly objectTrees: GeometryTree[] = []
  private readonly treeById = new Map<number, GeometryTree>()
  private readonly top: Bvh
  /** Each object's place in the model, to settle ties the way going through it in order would. */
  private readonly rank = new Map<number, number>()

  constructor(objects: Iterable<Source>) {
    for (const { id, geometry } of objects) {
      const tree = treeOf(geometry)
      this.rank.set(id, this.rank.size)
      if (tree.items.length === 0) continue
      this.ids.push(id)
      this.objectTrees.push(tree)
      this.treeById.set(id, tree)
    }
    const boxes = new Float64Array(this.ids.length * 6)
    this.objectTrees.forEach((tree, i) => boxes.set(tree.bvh.box, i * 6))
    this.top = new Bvh(boxes)
  }

  /** How many line items an object has; a window holds the whole object when it holds them all. */
  lineItems(id: number): number {
    return this.treeById.get(id)?.lineItems ?? 0
  }

  /** True if candidate a (an item of object ida) comes before b (of idb) when both are as near. */
  before(ida: number, a: PickItem, idb: number, b: PickItem): boolean {
    if (ida !== idb) return this.rank.get(ida)! < this.rank.get(idb)!
    return a.seq < b.seq
  }

  /**
   * Calls `visit` for each item whose box may reach `rect` on screen. `inside` is true when the
   * whole item is surely within `rect` (and in the view's depth range), so callers can skip testing
   * its points one by one. With `whole`, objects wholly within `rect` go to it instead, item-less.
   */
  query(project: Projector, rect: ScreenRect, visit: (id: number, item: PickItem, inside: boolean) => void, whole?: (id: number) => void): void {
    const corner = { x: 0, y: 0 }
    const p = { x: 0, y: 0, z: 0 } as Vector3
    const classify = (box: ArrayLike<number>, o: number): number => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let k = 0; k < 8; k++) {
        p.x = box[o + (k & 1 ? 3 : 0)]
        p.y = box[o + 1 + (k & 2 ? 3 : 0)]
        p.z = box[o + 2 + (k & 4 ? 3 : 0)]
        // Partly behind the camera or past its depth range: no conclusion from the corners.
        if (!project(p, corner)) return 1
        if (corner.x < minX) minX = corner.x
        if (corner.y < minY) minY = corner.y
        if (corner.x > maxX) maxX = corner.x
        if (corner.y > maxY) maxY = corner.y
      }
      if (maxX < rect.minX || minX > rect.maxX || maxY < rect.minY || minY > rect.maxY) return 0
      return minX >= rect.minX && maxX <= rect.maxX && minY >= rect.minY && maxY <= rect.maxY ? 2 : 1
    }
    this.top.query(classify, (o, inside) => {
      const id = this.ids[o]
      const tree = this.objectTrees[o]
      if (inside && whole) whole(id)
      else if (inside) for (const item of tree.items) visit(id, item, true)
      else tree.bvh.query(classify, (i, itemInside) => visit(id, tree.items[i], itemInside))
    })
  }
}
