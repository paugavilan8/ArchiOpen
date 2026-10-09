import { Vector3 } from 'three'
import type { Document } from '../core/document'
import { controlPoints } from '../core/curves'
import { snapPoints, wireframe, type SnapPoints } from '../core/geometry'
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

const PICK_TOLERANCE = 6
const SNAP_TOLERANCE = 12
const DRAG_THRESHOLD = 4
const ZOOM_STEP = 1.15
const SNAP_LABELS: Record<SnapKind, string> = { end: 'End', near: 'Near', mid: 'Mid', cen: 'Cen', quad: 'Quad' }
const POINT_SNAPS: (keyof SnapPoints)[] = ['end', 'mid', 'cen', 'quad']

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)`
const COORDINATE = new RegExp(String.raw`^(r|@|w)?\s*(${NUMBER})\s*,\s*(${NUMBER})(?:\s*,\s*(${NUMBER}))?$`, 'i')
const SINGLE_NUMBER = new RegExp(`^${NUMBER}$`)

/** Mouse handling for the viewports, plus the point/object/option requests that commands await. */
export class Interaction {
  ui: InteractionUI = { setPrompt() {}, log() {}, setCoords() {} }

  private request: Request | null = null
  private drag: Drag | null = null
  private script: string[] = []
  private lastPoint = new Vector3()
  private readonly marker = document.createElement('div')
  private readonly selectionBox = document.createElement('div')
  private readonly a: ScreenPoint = { x: 0, y: 0 }
  private readonly b: ScreenPoint = { x: 0, y: 0 }

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
  getPick(prompt: string, options: string[] = []): Promise<GetResult> {
    return this.start('pick', { prompt, options })
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

  private start(kind: Request['kind'], opts: GetPointOptions): Promise<GetResult> {
    return new Promise((resolve, reject) => {
      this.request = { kind, opts, resolve, reject }
      this.ui.setPrompt(opts.prompt, opts.options ?? [])
      const scripted = this.script.shift()
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
      const hit = this.pickPoint(vp, pos.x, pos.y)
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
    let best: { point: Vector3; label: string } | null = null
    let bestDistance = SNAP_TOLERANCE
    let near: Vector3 | null = null
    let nearDistance = SNAP_TOLERANCE

    for (const obj of this.doc.objects.values()) {
      if (!this.doc.isVisible(obj) || this.display.isHidden(obj.id)) continue
      const snaps = snapPoints(obj.geometry)
      for (const kind of POINT_SNAPS) {
        if (!enabled[kind]) continue
        for (const p of snaps[kind]) {
          if (!vp.project(p, this.a)) continue
          const d = Math.hypot(this.a.x - sx, this.a.y - sy)
          if (d < bestDistance) {
            bestDistance = d
            best = { point: p.clone(), label: SNAP_LABELS[kind] }
          }
        }
      }
      if (enabled.near && !best) {
        for (const line of wireframe(obj.geometry)) {
          const hit = this.closestOnPolyline(vp, line, sx, sy)
          if (hit && hit.distance < nearDistance) {
            nearDistance = hit.distance
            near = hit.point
          }
        }
      }
    }
    return best ?? (near ? { point: near, label: SNAP_LABELS.near } : null)
  }

  /** Closest point of a world polyline to a screen position, measured on screen. */
  private closestOnPolyline(vp: Viewport, pts: Vector3[], sx: number, sy: number): { distance: number; point: Vector3 } | null {
    let best = Infinity
    let bestIndex = -1
    let bestT = 0
    let prevVisible = pts.length > 0 && vp.project(pts[0], this.a)
    for (let i = 1; i < pts.length; i++) {
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
  private pickPoint(vp: Viewport, sx: number, sy: number): { id: number; point: Vector3 } | null {
    let best = PICK_TOLERANCE
    let result: { id: number; point: Vector3 } | null = null
    for (const obj of this.doc.objects.values()) {
      if (!this.doc.isSelectable(obj)) continue
      for (const line of wireframe(obj.geometry)) {
        const hit = this.closestOnPolyline(vp, line, sx, sy)
        if (hit && hit.distance < best) {
          best = hit.distance
          result = { id: obj.id, point: hit.point }
        }
      }
    }
    // In shaded views, clicking on a surface picks it too.
    return result ?? this.display.pickShaded(vp, sx, sy, (id) => this.doc.isSelectable(this.doc.objects.get(id)!))
  }

  private pickWindow(vp: Viewport, x0: number, y0: number, x1: number, y1: number, crossing: boolean): number[] {
    const minX = Math.min(x0, x1)
    const maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1)
    const maxY = Math.max(y0, y1)
    const inside = (p: ScreenPoint) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

    const ids: number[] = []
    for (const obj of this.doc.objects.values()) {
      if (!this.doc.isSelectable(obj)) continue
      const lines = wireframe(obj.geometry)
      let allInside = lines.some((pts) => pts.length > 0)
      let anyTouch = false
      for (const pts of lines) {
        let prevVisible = false
        for (let i = 0; i < pts.length; i++) {
          const visible = vp.project(pts[i], this.b)
          if (!visible || !inside(this.b)) allInside = false
          if (visible && inside(this.b)) anyTouch = true
          if (i > 0 && visible && prevVisible && segmentHitsRect(this.a, this.b, minX, minY, maxX, maxY)) anyTouch = true
          this.a.x = this.b.x
          this.a.y = this.b.y
          prevVisible = visible
        }
      }
      if (crossing ? anyTouch : allInside) ids.push(obj.id)
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
