import { Vector3 } from 'three'
import type { CadObject, Document } from '../core/document'
import { controlPoints } from '../core/curves'
import { isCurve, wireframe, type AnyCurve } from '../core/geometry'
import { crossing, meetingPoint, perpendicularPoints, tangentPoints } from '../core/osnap'
import { isClipped } from '../view/clipping'
import { PickIndex, type PickItem, type Range, type ScreenRect } from '../core/pickIndex'
import { editedIds, transformSelection, transformedSelection, translation } from '../core/selectionEdit'
import type { Settings, SnapKind } from '../core/settings'
import type { Display } from '../view/display'
import type { ScreenPoint, Viewport } from '../view/viewport'

export class CancelError extends Error {
  constructor() {
    super('cancelled')
  }
}

export type GetResult =
  | { kind: 'point'; point: Vector3; viewport: Viewport }
  | { kind: 'option'; option: string }
  | { kind: 'number'; value: number }
  | { kind: 'pick'; id: number; point: Vector3; viewport: Viewport }
  | { kind: 'string'; text: string }
  | { kind: 'enter' }

export interface GetPointOptions {
  prompt: string
  /** Previous point: anchors the rubber band, ortho, relative coordinates and distance input. */
  base?: Vector3
  options?: string[]
  /** Return a typed number as a result instead of treating it as a distance constraint. */
  acceptNumber?: boolean
  rubberBand?: boolean
  preview?: (point: Vector3) => Vector3[][]
  /** For picks: only objects this accepts can be picked (others under the cursor are passed over). */
  accept?: (id: number) => boolean
}

export interface InteractionUI {
  setPrompt(text: string, options: string[]): void
  log(text: string): void
  setCoords(x: number, y: number, z: number): void
}

interface Request {
  kind: 'point' | 'objects' | 'option' | 'number' | 'pick' | 'string'
  opts: GetPointOptions
  resolve: (result: GetResult) => void
  reject: (error: Error) => void
  distance?: number
}

interface Drag {
  /** Set when the drag started on a selected object or control point: the drag moves the selection. */
  anchor?: Vector3
  /** Where the dragged selection currently goes, relative to the anchor. */
  delta?: Vector3
  button: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: boolean
}

/** Pixels by which point objects count as nearer than other objects when picking. */
const POINT_PREFERENCE = 3
const PICK_TOLERANCE = 6
const SNAP_TOLERANCE = 12
const DRAG_THRESHOLD = 4
const ZOOM_STEP = 1.15
const SNAP_LABELS: Record<SnapKind, string> = { end: 'End', near: 'Near', mid: 'Mid', cen: 'Cen', quad: 'Quad', knot: 'Knot', int: 'Int', perp: 'Perp', tan: 'Tan' }
/** At most this many drawn segments near the cursor are tried against each other for Int. */
const INT_SEGMENTS = 200

/** A drawn segment near the cursor: points[k] to points[k + 1] of a line, and where it is on screen. */
interface ScreenSegment {
  id: number
  item: PickItem
  points: Vector3[]
  k: number
  ax: number
  ay: number
  bx: number
  by: number
}

/** Perp and Tan points of a curve from one base point, kept while the cursor moves. */
const fromPointCache = new WeakMap<AnyCurve, { key: string; points: Vector3[] }>()

function pointsFrom(g: AnyCurve, kind: 'perp' | 'tan', base: Vector3, normal: Vector3): Vector3[] {
  const key = `${kind} ${base.x} ${base.y} ${base.z} ${normal.x} ${normal.y} ${normal.z}`
  const cached = fromPointCache.get(g)
  if (cached?.key === key) return cached.points
  const points = kind === 'perp' ? perpendicularPoints(g, base) : tangentPoints(g, base, normal)
  fromPointCache.set(g, { key, points })
  return points
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)`
const COORDINATE = new RegExp(String.raw`^(r|@|w)?\s*(${NUMBER})\s*,\s*(${NUMBER})(?:\s*,\s*(${NUMBER}))?$`, 'i')
const SINGLE_NUMBER = new RegExp(`^${NUMBER}$`)

/** Mouse handling for the viewports, plus the point/object/option requests that commands await. */
export class Interaction {
  ui: InteractionUI = { setPrompt() {}, log() {}, setCoords() {} }

  private request: Request | null = null
  private drag: Drag | null = null
  private script: string[] = []
  /** Lines typed while the running command was busy (e.g. waiting for the kernel), for its next prompts. */
  private typeAhead: string[] = []
  private lastPoint = new Vector3()
  private readonly marker = document.createElement('div')
  private readonly selectionBox = document.createElement('div')
  private readonly a: ScreenPoint = { x: 0, y: 0 }
  private readonly b: ScreenPoint = { x: 0, y: 0 }
  private index: PickIndex | null = null
  private indexRevision = -1

  constructor(
    private readonly doc: Document,
    private readonly display: Display,
    private readonly settings: Settings,
  ) {
    this.marker.className = 'snap-marker'
    this.marker.hidden = true
    this.selectionBox.className = 'selection-box'
    this.selectionBox.hidden = true
    for (const vp of display.viewports) this.attach(vp)
  }

  get busy(): boolean {
    return this.request !== null
  }

  // --- Requests used by commands ---------------------------------------------

  getPoint(opts: GetPointOptions): Promise<GetResult> {
    return this.start('point', opts)
  }

  /** Resolves to the chosen option, or null if the user pressed Enter. */
  async getOption(prompt: string, options: string[]): Promise<string | null> {
    const result = await this.start('option', { prompt, options })
    return result.kind === 'option' ? result.option : null
  }

  /**
   * Asks for a number; Enter accepts the default. Resolves to the number, or to the name of an
   * option if one is chosen.
   */
  async getNumber(prompt: string, defaultValue: number, options: string[] = []): Promise<number | string> {
    const result = await this.start('number', { prompt: `${prompt} <${formatNumber(defaultValue)}>`, options })
    if (result.kind === 'number') return result.value
    if (result.kind === 'option') return result.option
    return defaultValue
  }

  /**
   * Asks for a line of text; Space types a space instead of answering. Resolves to the text (with
   * `\n` turned into line breaks), or to null if Enter is pressed on an empty line.
   */
  async getString(prompt: string): Promise<string | null> {
    const result = await this.start('string', { prompt })
    return result.kind === 'string' ? result.text.replace(/\\n/g, '\n') : null
  }

  /** True while a command waits for typed text, so Space must not answer it. */
  get wantsText(): boolean {
    return this.request?.kind === 'string'
  }

  /** Asks the user to click on one object; the result also says where on the object they clicked. */
  getPick(prompt: string, options: string[] = [], accept?: (id: number) => boolean): Promise<GetResult> {
    return this.start('pick', { prompt, options, accept })
  }

  /** Uses the current selection if there is one; otherwise lets the user select until Enter. */
  async getObjects(prompt: string): Promise<number[]> {
    if (this.doc.selection.size === 0) {
      await this.start('objects', { prompt: `${prompt}. Press Enter when done` })
      if (this.doc.selection.size === 0) throw new CancelError()
    }
    return [...this.doc.selection]
  }

  /** Queues text to answer the next prompts, as if typed. Used by macros such as "Zoom Extents". */
  setScript(inputs: string[]): void {
    this.script = [...inputs]
  }

  /**
   * Keeps a line typed while a command runs but asks for nothing (it is working), to answer its
   * next prompt, as typing ahead works when the window is busy.
   */
  typeAheadLine(text: string): void {
    this.typeAhead.push(text)
  }

  /** The lines typed ahead that no prompt has taken, emptying the queue. */
  takeTypeAhead(): string[] {
    const lines = this.typeAhead
    this.typeAhead = []
    return lines
  }

  private start(kind: Request['kind'], opts: GetPointOptions): Promise<GetResult> {
    return new Promise((resolve, reject) => {
      this.request = { kind, opts, resolve, reject }
      this.ui.setPrompt(opts.prompt, opts.options ?? [])
      const scripted = this.script.shift() ?? this.typeAhead.shift()
      if (scripted !== undefined) queueMicrotask(() => this.handleText(scripted))
    })
  }

  private finish(result: GetResult): void {
    const request = this.request
    if (!request) return
    this.clearRequest()
    request.resolve(result)
  }

  private clearRequest(): void {
    this.request = null
    this.marker.hidden = true
    this.display.setPreview([])
  }

  /** Enter, Space or a right click. */
  enter(): void {
    this.finish({ kind: 'enter' })
  }

  cancel(): void {
    const request = this.request
    this.script = []
    this.typeAhead = []
    if (!request) return
    this.clearRequest()
    request.reject(new CancelError())
  }

  /** Handles a line typed in the command line while a command is waiting for input. */
  handleText(raw: string): void {
    const request = this.request
    if (!request) return
    const text = raw.trim()
    if (text === '') return this.enter()

    if (request.kind === 'string') return this.finish({ kind: 'string', text })
    if (request.kind === 'number' && SINGLE_NUMBER.test(text)) return this.finish({ kind: 'number', value: parseFloat(text) })
    if (request.kind === 'point') {
      const coords = COORDINATE.exec(text)
      if (coords) return this.finishPoint(this.parsePoint(coords, request), this.display.active)

      if (SINGLE_NUMBER.test(text)) {
        const value = parseFloat(text)
        if (request.opts.acceptNumber) return this.finish({ kind: 'number', value })
        if (request.opts.base && value > 0) {
          request.distance = value
          this.ui.log(`Distance constrained to ${value}`)
          return
        }
      }
    }

    const option = matchOption(text, request.opts.options ?? [])
    if (option) return this.finish({ kind: 'option', option })
    this.ui.log(`Unknown input: ${text}`)
  }

  private parsePoint(match: RegExpExecArray, request: Request): Vector3 {
    const prefix = (match[1] ?? '').toLowerCase()
    const x = parseFloat(match[2])
    const y = parseFloat(match[3])
    const z = match[4] !== undefined ? parseFloat(match[4]) : 0
    if (prefix === 'w') return new Vector3(x, y, z)

    const plane = this.display.active.cplane
    const origin = prefix === '' ? plane.origin : (request.opts.base ?? this.lastPoint)
    return origin.clone().addScaledVector(plane.xaxis, x).addScaledVector(plane.yaxis, y).addScaledVector(plane.normal, z)
  }

  private finishPoint(point: Vector3, viewport: Viewport): void {
    this.lastPoint = point.clone()
    this.finish({ kind: 'point', point, viewport })
  }

  // --- Pointer events --------------------------------------------------------

  private attach(vp: Viewport): void {
    const el = vp.el
    el.addEventListener('pointerdown', (e) => this.onDown(vp, e))
    el.addEventListener('pointermove', (e) => this.onMove(vp, e))
    el.addEventListener('pointerup', (e) => this.onUp(vp, e))
    el.addEventListener('pointercancel', () => this.endDrag())
    el.addEventListener('pointerleave', () => (this.marker.hidden = true))
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const pos = localPosition(vp, e)
        vp.zoom(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, pos.x, pos.y)
        this.display.requestRender()
      },
      { passive: false },
    )
  }

  private onDown(vp: Viewport, e: PointerEvent): void {
    // Overlays with their own handling (viewport title, gumball) opt out of picking.
    if (vp.titleEl.contains(e.target as Node) || (e.target as Element).closest('[data-no-pick]')) return
    this.display.setActive(vp)
    vp.updateCamera()
    const pos = localPosition(vp, e)

    if (e.button === 0 && this.request?.kind === 'point') {
      const hit = this.computePoint(vp, pos.x, pos.y, e.shiftKey)
      if (hit) this.finishPoint(hit.point, vp)
      return
    }
    if (e.button === 0 && this.request?.kind === 'pick') {
      const hit = this.pickPoint(vp, pos.x, pos.y, this.request.opts.accept)
      if (hit) this.finish({ kind: 'pick', id: hit.id, point: hit.point, viewport: vp })
      return
    }
    if (e.button === 0 && (this.request?.kind === 'option' || this.request?.kind === 'number' || this.request?.kind === 'string')) return

    vp.el.setPointerCapture(e.pointerId)
    this.drag = { button: e.button, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, moved: false }
    // With no command running, pressing on a control point or an object grabs it, so a drag moves it.
    if (e.button === 0 && !this.request && !e.shiftKey && !e.ctrlKey) this.drag.anchor = this.grab(vp, pos.x, pos.y) ?? undefined
  }

  /** Selects what is under the cursor for dragging, and returns the point it is held by. */
  private grab(vp: Viewport, sx: number, sy: number): Vector3 | null {
    const cp = this.pickControlPoint(vp, sx, sy)
    if (cp) {
      if (!this.doc.pointSelection.get(cp.id)?.has(cp.index)) {
        this.doc.clearSelection()
        this.doc.selectPoints([cp])
      }
      return cp.point
    }
    const hit = this.pickPoint(vp, sx, sy)
    if (!hit) return null
    if (!this.doc.selection.has(hit.id)) {
      this.doc.clearPointSelection()
      this.doc.select(this.doc.withGroups([hit.id]))
    }
    return this.doc.selectedPointCount > 0 ? null : hit.point
  }

  /** Moves the grabbed selection with the cursor, in the construction plane through the grab point. */
  private dragSelection(vp: Viewport, drag: Drag, sx: number, sy: number, shift: boolean): void {
    const anchor = drag.anchor!
    if (!drag.delta) this.display.setHidden(editedIds(this.doc))
    const snap = this.settings.osnap ? this.findSnap(vp, sx, sy) : null
    let target = snap?.point ?? vp.screenToPlane(sx, sy, anchor, vp.cplane.normal)
    if (!target) return
    const plane = vp.cplane
    if (!snap) {
      if (this.settings.gridSnap) {
        const s = this.settings.gridSpacing
        const d = target.clone().sub(anchor)
        target = anchor
          .clone()
          .addScaledVector(plane.xaxis, Math.round(d.dot(plane.xaxis) / s) * s)
          .addScaledVector(plane.yaxis, Math.round(d.dot(plane.yaxis) / s) * s)
      }
      if (this.settings.ortho !== shift) {
        const d = target.clone().sub(anchor)
        const dx = d.dot(plane.xaxis)
        const dy = d.dot(plane.yaxis)
        target = anchor.clone().addScaledVector(Math.abs(dx) >= Math.abs(dy) ? plane.xaxis : plane.yaxis, Math.abs(dx) >= Math.abs(dy) ? dx : dy)
      }
    }
    drag.delta = target.clone().sub(anchor)
    this.showMarker(vp, snap ? target : null, snap?.label ?? null)
    const moved = transformedSelection(this.doc, translation(drag.delta))
    this.display.setPreview([...moved.values()].flatMap((g) => wireframe(g)), true)
    const d = target.clone().sub(plane.origin)
    this.ui.setCoords(d.dot(plane.xaxis), d.dot(plane.yaxis), d.dot(plane.normal))
  }

  private endSelectionDrag(): void {
    this.display.setHidden([])
    this.display.setPreview([])
    this.marker.hidden = true
  }

  private onMove(vp: Viewport, e: PointerEvent): void {
    const pos = localPosition(vp, e)
    const drag = this.drag
    vp.updateCamera()

    if (drag) {
      if (Math.hypot(pos.x - drag.startX, pos.y - drag.startY) > DRAG_THRESHOLD) drag.moved = true
      if (drag.moved && drag.button === 0) {
        if (drag.anchor) this.dragSelection(vp, drag, pos.x, pos.y, e.shiftKey)
        else this.showSelectionBox(vp, drag, pos)
      }
      if (drag.moved && drag.button !== 0) {
        // Right drag orbits the perspective view and pans the parallel ones; Shift or the middle button always pan.
        if (drag.button === 1 || vp.isOrtho || e.shiftKey) vp.pan(drag.lastX, drag.lastY, pos.x, pos.y)
        else vp.orbit(pos.x - drag.lastX, pos.y - drag.lastY)
        this.display.requestRender()
      }
      drag.lastX = pos.x
      drag.lastY = pos.y
      return
    }

    const hit = this.computePoint(vp, pos.x, pos.y, e.shiftKey)
    if (!hit) return
    const plane = vp.cplane
    const d = hit.point.clone().sub(plane.origin)
    this.ui.setCoords(d.dot(plane.xaxis), d.dot(plane.yaxis), d.dot(plane.normal))

    if (this.request?.kind !== 'point') return
    this.showMarker(vp, hit.snap ? hit.point : null, hit.snap)
    const opts = this.request.opts
    const lines = opts.preview ? opts.preview(hit.point) : []
    if (opts.base && opts.rubberBand !== false) lines.push([opts.base, hit.point])
    this.display.setPreview(lines)
  }

  private onUp(vp: Viewport, e: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    this.endDrag()
    if (vp.el.hasPointerCapture(e.pointerId)) vp.el.releasePointerCapture(e.pointerId)
    const pos = localPosition(vp, e)

    if (drag.button === 2 && !drag.moved) return this.onRightClick()
    if (drag.button !== 0) return

    if (drag.anchor && drag.moved) {
      // endDrag() above already removed the preview.
      if (drag.delta && drag.delta.lengthSq() > 0) transformSelection(this.doc, translation(drag.delta))
      return
    }

    const mode = e.shiftKey ? 'add' : e.ctrlKey ? 'remove' : 'replace'
    if (drag.moved) {
      // Dragging left to right selects what is fully inside; right to left also takes what it crosses.
      const crossing = pos.x < drag.startX
      const points = this.pickPointsInWindow(vp, drag.startX, drag.startY, pos.x, pos.y)
      if (points.length > 0 && this.request?.kind !== 'objects') {
        if (mode === 'replace') this.doc.clearSelection()
        this.doc.selectPoints(points, mode)
        return
      }
      if (mode === 'replace') this.doc.clearPointSelection()
      this.doc.select(this.doc.withGroups(this.pickWindow(vp, drag.startX, drag.startY, pos.x, pos.y, crossing)), mode)
      return
    }
    const cp = this.request?.kind === 'objects' ? null : this.pickControlPoint(vp, pos.x, pos.y)
    if (cp) {
      if (mode === 'replace') this.doc.clearSelection()
      this.doc.selectPoints([cp], mode)
      return
    }
    if (mode === 'replace') this.doc.clearPointSelection()
    const id = this.pickObject(vp, pos.x, pos.y)
    // Picking a member of a group picks the whole group.
    this.doc.select(id === null ? [] : this.doc.withGroups([id]), mode)
  }

  /** The control point under the cursor, among objects with points on. */
  private pickControlPoint(vp: Viewport, sx: number, sy: number): { id: number; index: number; point: Vector3 } | null {
    let best = PICK_TOLERANCE + 2
    let result: { id: number; index: number; point: Vector3 } | null = null
    for (const id of this.doc.pointsOn) {
      const pts = controlPoints(this.doc.objects.get(id)!.geometry) ?? []
      pts.forEach((p, index) => {
        if (!vp.project(p, this.a)) return
        const d = Math.hypot(this.a.x - sx, this.a.y - sy)
        if (d < best) {
          best = d
          result = { id, index, point: p.clone() }
        }
      })
    }
    return result
  }

  private pickPointsInWindow(vp: Viewport, x0: number, y0: number, x1: number, y1: number): { id: number; index: number }[] {
    const found: { id: number; index: number }[] = []
    for (const id of this.doc.pointsOn) {
      const pts = controlPoints(this.doc.objects.get(id)!.geometry) ?? []
      pts.forEach((p, index) => {
        if (!vp.project(p, this.a)) return
        if (this.a.x >= Math.min(x0, x1) && this.a.x <= Math.max(x0, x1) && this.a.y >= Math.min(y0, y1) && this.a.y <= Math.max(y0, y1)) {
          found.push({ id, index })
        }
      })
    }
    return found
  }

  /** Set by the command runner: a right click with no pending request repeats the last command. */
  onIdleEnter: () => void = () => {}

  private onRightClick(): void {
    if (this.request) this.enter()
    else this.onIdleEnter()
  }

  private endDrag(): void {
    if (this.drag?.anchor && this.drag.moved) this.endSelectionDrag()
    this.drag = null
    this.selectionBox.hidden = true
  }

  // --- Point computation -----------------------------------------------------

  private computePoint(vp: Viewport, sx: number, sy: number, shift: boolean): { point: Vector3; snap: string | null } | null {
    const request = this.request?.kind === 'point' ? this.request : null
    const base = request?.opts.base
    const plane = vp.cplane

    const snap = request && this.settings.osnap ? this.findSnap(vp, sx, sy) : null
    let point = snap?.point ?? vp.screenToPlane(sx, sy)
    if (!point) return null

    if (!snap) {
      if (this.settings.gridSnap) {
        const s = this.settings.gridSpacing
        const d = point.clone().sub(plane.origin)
        point = plane.origin
          .clone()
          .addScaledVector(plane.xaxis, Math.round(d.dot(plane.xaxis) / s) * s)
          .addScaledVector(plane.yaxis, Math.round(d.dot(plane.yaxis) / s) * s)
      }
      // Holding Shift inverts the ortho setting, as in most CAD programs.
      if (base && this.settings.ortho !== shift) {
        const d = point.clone().sub(base)
        const dx = d.dot(plane.xaxis)
        const dy = d.dot(plane.yaxis)
        point = base.clone().addScaledVector(Math.abs(dx) >= Math.abs(dy) ? plane.xaxis : plane.yaxis, Math.abs(dx) >= Math.abs(dy) ? dx : dy)
      }
    }

    if (base && request?.distance !== undefined) {
      const d = point.clone().sub(base)
      if (d.lengthSq() > 1e-18) point = base.clone().addScaledVector(d.normalize(), request.distance)
    }
    return { point, snap: snap?.label ?? null }
  }

  private findSnap(vp: Viewport, sx: number, sy: number): { point: Vector3; label: string } | null {
    const enabled = this.settings.snaps
    // Casts, as TypeScript does not follow assignments in callbacks. Equally near candidates go to
    // the one first in the model, then first in its object.
    let best = null as { point: Vector3; label: string; id: number; item: PickItem } | null
    let bestDistance = SNAP_TOLERANCE
    let near = null as { point: Vector3; id: number; item: PickItem } | null
    let nearDistance = SNAP_TOLERANCE
    const visible = this.filter((obj) => this.doc.isVisible(obj) && !this.display.isHidden(obj.id))
    const index = this.pickIndex()
    // Perp and Tan are measured from the point the command started from.
    const base = this.request?.kind === 'point' ? this.request.opts.base : undefined
    const fromBase = !!base && (enabled.perp || enabled.tan)
    // What a clipping plane cuts away in this view cannot be snapped to.
    const planes = this.display.clippingPlanes(vp)
    const clipped = (p: Vector3) => planes.length > 0 && isClipped(planes, p)
    // Drawn lines near the cursor, for the snaps that look at more than one point (Int, Perp, Tan).
    const lines: { id: number; item: PickItem }[] = []

    this.near(vp, sx, sy, SNAP_TOLERANCE, (id, item) => {
      if (!visible(id)) return
      if (item.kind === 'line') {
        if (enabled.int || fromBase) lines.push({ id, item })
        if (!enabled.near) return
        const hit = this.closestOnRanges(vp, item.ranges, sx, sy)
        if (hit && clipped(hit.point)) return
        if (hit && (hit.distance < nearDistance || (hit.distance === nearDistance && near && index.before(id, item, near.id, near.item)))) {
          nearDistance = hit.distance
          near = { point: hit.point, id, item }
        }
        return
      }
      if (!enabled[item.kind]) return
      for (const r of item.ranges) {
        for (let k = r.from; k <= r.to; k++) {
          const p = r.points[k]
          if (!vp.project(p, this.a) || clipped(p)) continue
          const d = Math.hypot(this.a.x - sx, this.a.y - sy)
          if (d < bestDistance || (d === bestDistance && best && index.before(id, item, best.id, best.item))) {
            bestDistance = d
            best = { point: p.clone(), label: SNAP_LABELS[item.kind], id, item }
          }
        }
      }
    })
    // Fixed points win a tie, so a corner snaps as End rather than as Int.
    let found = best ? { point: best.point, label: best.label } : null
    const consider = (point: Vector3, kind: SnapKind) => {
      if (!vp.project(point, this.a) || clipped(point)) return
      const d = Math.hypot(this.a.x - sx, this.a.y - sy)
      if (d < bestDistance) {
        bestDistance = d
        found = { point, label: SNAP_LABELS[kind] }
      }
    }
    if (enabled.int && lines.length > 0) {
      const hit = this.intersectionNear(vp, lines, sx, sy, bestDistance)
      if (hit) consider(hit, 'int')
    }
    if (fromBase) {
      const curves = new Set(lines.map((l) => l.id))
      for (const id of curves) {
        const g = this.doc.objects.get(id)!.geometry
        if (!isCurve(g)) continue
        if (enabled.perp) for (const p of pointsFrom(g, 'perp', base!, vp.cplane.normal)) consider(p, 'perp')
        if (enabled.tan) for (const p of pointsFrom(g, 'tan', base!, vp.cplane.normal)) consider(p, 'tan')
      }
    }
    // A point snap wins over a nearest point on a line.
    if (found) return found
    return near ? { point: near.point, label: SNAP_LABELS.near } : null
  }

  /**
   * Where two drawn lines cross nearest the cursor (within `within` pixels): where two curves meet
   * in space, or, if one only passes in front of the other, the point on the first in the model.
   */
  private intersectionNear(vp: Viewport, lines: { id: number; item: PickItem }[], sx: number, sy: number, within: number): Vector3 | null {
    const segments: ScreenSegment[] = []
    const a = this.a
    const b = this.b
    for (const { id, item } of lines) {
      for (const r of item.ranges) {
        for (let k = r.from; k < r.to && segments.length < INT_SEGMENTS; k++) {
          if (!vp.project(r.points[k], a) || !vp.project(r.points[k + 1], b)) continue
          if (distanceToSegment(sx, sy, a.x, a.y, b.x, b.y) > within) continue
          segments.push({ id, item, points: r.points, k, ax: a.x, ay: a.y, bx: b.x, by: b.y })
        }
      }
    }
    let best = null as { first: ScreenSegment; second: ScreenSegment; s: number; u: number } | null
    let bestDistance = within
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const p = segments[i]
        const q = segments[j]
        // Neighbouring pieces of one line meet at their shared point, which is no crossing.
        if (p.points === q.points && (Math.abs(p.k - q.k) <= 1 || sharesEnd(p, q))) continue
        const hit = crossing(p.ax, p.ay, p.bx, p.by, q.ax, q.ay, q.bx, q.by)
        if (!hit) continue
        const d = Math.hypot(p.ax + (p.bx - p.ax) * hit.s - sx, p.ay + (p.by - p.ay) * hit.s - sy)
        if (d < bestDistance) {
          bestDistance = d
          best = { first: p, second: q, s: hit.s, u: hit.u }
        }
      }
    }
    if (!best) return null
    const index = this.pickIndex()
    // The first in the model gives the point when they only seem to cross.
    const swap = index.before(best.second.id, best.second.item, best.first.id, best.first.item)
    const first = swap ? best.second : best.first
    const second = swap ? best.first : best.second
    const s = swap ? best.u : best.s
    const u = swap ? best.s : best.u
    const pa = first.points[first.k].clone().lerp(first.points[first.k + 1], s)
    const pb = second.points[second.k].clone().lerp(second.points[second.k + 1], u)
    const ga = this.doc.objects.get(first.id)!.geometry
    const gb = this.doc.objects.get(second.id)!.geometry
    // Curves are drawn as chords: find where the curves themselves meet.
    if (first.id !== second.id && isCurve(ga) && isCurve(gb)) return meetingPoint(ga, gb, pa, pb) ?? pa
    return pa.distanceTo(pb) < 1e-6 * Math.max(1, pa.length()) ? pa.add(pb).multiplyScalar(0.5) : pa
  }

  /** The index of what can be picked, made again when the model has changed. */
  private pickIndex(): PickIndex {
    if (!this.index || this.indexRevision !== this.doc.revision) {
      this.index = new PickIndex(this.doc.objects.values())
      this.indexRevision = this.doc.revision
    }
    return this.index
  }

  /** Visits the indexed runs and snap groups within `radius` pixels of a screen position. */
  private near(vp: Viewport, sx: number, sy: number, radius: number, visit: (id: number, item: PickItem, inside: boolean) => void): void {
    this.pickIndex().query((p, out) => vp.project(p, out), { minX: sx - radius, minY: sy - radius, maxX: sx + radius, maxY: sy + radius }, visit)
  }

  /** A test on objects by id, worked out once per object for one query. */
  private filter(test: (obj: CadObject) => boolean): (id: number) => boolean {
    const known = new Map<number, boolean>()
    return (id) => {
      let ok = known.get(id)
      if (ok === undefined) {
        const obj = this.doc.objects.get(id)
        ok = !!obj && test(obj)
        known.set(id, ok)
      }
      return ok
    }
  }

  /** Closest point of some pieces of polylines to a screen position; the first wins a tie. */
  private closestOnRanges(vp: Viewport, ranges: Range[], sx: number, sy: number): { distance: number; point: Vector3 } | null {
    let best: { distance: number; point: Vector3 } | null = null
    for (const r of ranges) {
      const hit = this.closestOnPolyline(vp, r.points, sx, sy, r.from, r.to)
      if (hit && (!best || hit.distance < best.distance)) best = hit
    }
    return best
  }

  /** Closest point of a world polyline to a screen position, measured on screen. */
  private closestOnPolyline(vp: Viewport, pts: Vector3[], sx: number, sy: number, from = 0, to = pts.length - 1): { distance: number; point: Vector3 } | null {
    let best = Infinity
    let bestIndex = -1
    let bestT = 0
    // A point object: the distance to it.
    if (pts.length === 1) return vp.project(pts[0], this.a) ? { distance: Math.hypot(this.a.x - sx, this.a.y - sy), point: pts[0].clone() } : null
    let prevVisible = to > from && vp.project(pts[from], this.a)
    for (let i = from + 1; i <= to; i++) {
      const visible = vp.project(pts[i], this.b)
      if (visible && prevVisible) {
        const ex = this.b.x - this.a.x
        const ey = this.b.y - this.a.y
        const len2 = ex * ex + ey * ey
        const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((sx - this.a.x) * ex + (sy - this.a.y) * ey) / len2))
        const d = Math.hypot(this.a.x + ex * t - sx, this.a.y + ey * t - sy)
        if (d < best) {
          best = d
          bestIndex = i
          bestT = t
        }
      }
      this.a.x = this.b.x
      this.a.y = this.b.y
      prevVisible = visible
    }
    if (bestIndex < 0) return null
    return { distance: best, point: pts[bestIndex - 1].clone().lerp(pts[bestIndex], bestT) }
  }

  // --- Picking ---------------------------------------------------------------

  private pickObject(vp: Viewport, sx: number, sy: number): number | null {
    return this.pickPoint(vp, sx, sy)?.id ?? null
  }

  /** The selectable object nearest the cursor, and the point on it under the cursor. */
  private pickPoint(vp: Viewport, sx: number, sy: number, accept: (id: number) => boolean = () => true): { id: number; point: Vector3 } | null {
    let best = PICK_TOLERANCE
    // Set inside the visit below (a cast, as TypeScript does not follow assignments in callbacks).
    let result = null as { id: number; point: Vector3; item: PickItem } | null
    const pickable = this.filter((obj) => this.doc.isSelectable(obj) && accept(obj.id))
    const index = this.pickIndex()
    const planes = this.display.clippingPlanes(vp)
    this.near(vp, sx, sy, PICK_TOLERANCE + POINT_PREFERENCE, (id, item) => {
      if (item.kind !== 'line' || !pickable(id)) return
      // A point lying on a curve wins over the curve, as it would be hard to pick otherwise.
      const preference = this.doc.objects.get(id)!.geometry.type === 'point' ? POINT_PREFERENCE : 0
      const hit = this.closestOnRanges(vp, item.ranges, sx, sy)
      // Lines cut away by a clipping plane are not there to click.
      if (hit && planes.length > 0 && isClipped(planes, hit.point)) return
      // Equally near: the first object in the model, then its first line, wins.
      if (hit && (hit.distance - preference < best || (hit.distance - preference === best && result && index.before(id, item, result.id, result.item)))) {
        best = hit.distance - preference
        result = { id, point: hit.point, item }
      }
    })
    // In shaded views, clicking on a surface picks it too. A click near an edge of a shaded surface
    // takes the point on the surface itself, so commands that pick faces get the face under the cursor.
    const shaded = this.display.pickShaded(vp, sx, sy, (id) => this.doc.isSelectable(this.doc.objects.get(id)!) && accept(id))
    if (result && shaded && shaded.id === result.id) return shaded
    return result ? { id: result.id, point: result.point } : shaded
  }

  private pickWindow(vp: Viewport, x0: number, y0: number, x1: number, y1: number, crossing: boolean): number[] {
    const rect: ScreenRect = { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) }
    const inside = (p: ScreenPoint) => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY
    const selectable = this.filter((obj) => this.doc.isSelectable(obj))
    const index = this.pickIndex()
    // Per object: its line items wholly in the window, and whether any touches it.
    const itemsInside = new Map<number, number>()
    const touched = new Set<number>()
    const wholly = new Set<number>()
    index.query(
      (p, out) => vp.project(p, out),
      rect,
      (id, item, whole) => {
        if (item.kind !== 'line' || !selectable(id)) return
        let allInside = whole
        let anyTouch = whole
        if (!whole) {
          allInside = true
          for (const r of item.ranges) {
            let prevVisible = false
            for (let i = r.from; i <= r.to; i++) {
              const visible = vp.project(r.points[i], this.b)
              if (!visible || !inside(this.b)) allInside = false
              if (visible && inside(this.b)) anyTouch = true
              if (i > r.from && visible && prevVisible && segmentHitsRect(this.a, this.b, rect.minX, rect.minY, rect.maxX, rect.maxY)) anyTouch = true
              this.a.x = this.b.x
              this.a.y = this.b.y
              prevVisible = visible
            }
          }
        }
        if (allInside) itemsInside.set(id, (itemsInside.get(id) ?? 0) + 1)
        if (anyTouch) touched.add(id)
      },
      // Objects wholly in the window are in it either way, point for point.
      (id) => {
        if (selectable(id) && index.lineItems(id) > 0) wholly.add(id)
      },
    )
    // In the order of the model, as before.
    const ids: number[] = []
    for (const id of this.doc.objects.keys()) {
      const lineItems = index.lineItems(id)
      if (wholly.has(id) || (crossing ? touched.has(id) : lineItems > 0 && itemsInside.get(id) === lineItems)) ids.push(id)
    }
    return ids
  }

  // --- Overlays --------------------------------------------------------------

  private showMarker(vp: Viewport, point: Vector3 | null, label: string | null): void {
    if (!point || !label || !vp.project(point, this.a)) {
      this.marker.hidden = true
      return
    }
    if (this.marker.parentElement !== vp.el) vp.el.appendChild(this.marker)
    this.marker.hidden = false
    this.marker.dataset.label = label
    this.marker.style.transform = `translate(${this.a.x}px, ${this.a.y}px)`
  }

  private showSelectionBox(vp: Viewport, drag: Drag, pos: ScreenPoint): void {
    if (this.request && this.request.kind !== 'objects') return
    const box = this.selectionBox
    if (box.parentElement !== vp.el) vp.el.appendChild(box)
    box.hidden = false
    box.classList.toggle('crossing', pos.x < drag.startX)
    box.style.left = `${Math.min(drag.startX, pos.x)}px`
    box.style.top = `${Math.min(drag.startY, pos.y)}px`
    box.style.width = `${Math.abs(pos.x - drag.startX)}px`
    box.style.height = `${Math.abs(pos.y - drag.startY)}px`
  }
}

function localPosition(vp: Viewport, e: MouseEvent): ScreenPoint {
  const rect = vp.el.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

/** Exact match first, then a unique prefix, ignoring case. */
function matchOption(text: string, options: string[]): string | null {
  const lower = text.toLowerCase()
  const exact = options.find((o) => o.toLowerCase() === lower)
  if (exact) return exact
  const prefixed = options.filter((o) => o.toLowerCase().startsWith(lower))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Liang–Barsky test of a segment against an axis-aligned rectangle. */
function segmentHitsRect(a: ScreenPoint, b: ScreenPoint, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dy, a.y - minY],
    [dy, maxY - a.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/** Screen distance from (px, py) to the segment from (ax, ay) to (bx, by). */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax
  const ey = by - ay
  const len2 = ex * ex + ey * ey
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2))
  return Math.hypot(ax + ex * t - px, ay + ey * t - py)
}

/** True for the first and last pieces of a closed line, which meet where it closes. */
function sharesEnd(p: ScreenSegment, q: ScreenSegment): boolean {
  const last = p.points.length - 2
  return ((p.k === 0 && q.k === last) || (q.k === 0 && p.k === last)) && p.points[0].equals(p.points[last + 1])
}
