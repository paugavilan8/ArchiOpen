import { Matrix4, Vector3 } from 'three'
import { rotationAbout, scaleAbout } from '../commands/helpers'
import type { Command, CommandRunner } from '../commands/runner'
import type { Document } from '../core/document'
import { tessellate } from '../core/geometry'
import { editBox, editedIds, transformedSelection, translation } from '../core/selectionEdit'
import type { Settings } from '../core/settings'
import type { Display } from '../view/display'
import type { ScreenPoint, Viewport } from '../view/viewport'

type Mode = 'move' | 'rotate' | 'scale' | 'free'

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]
const AXIS_NAMES = ['X', 'Y', 'Z']
const COLORS = ['#e5483d', '#3fae49', '#3b7ce6']
/** Arrow length on screen, in pixels. */
const SIZE = 84
const HEAD = 11
const ARC_RADIUS = 0.72
const SCALE_AT = 0.56
const CLICK_SLOP = 3
const ANGLE_STEP = Math.PI / 12
const SVG_NS = 'http://www.w3.org/2000/svg'

interface DragState {
  vp: Viewport
  mode: Mode
  axis: number
  origin: Vector3
  startX: number
  startY: number
  /** Parameter along the axis (move, scale), screen angle (rotate) or plane point (free) at the start. */
  startParam: number
  startPoint: Vector3 | null
  moved: boolean
  matrix: Matrix4
  label: string
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/**
 * The on-screen manipulator for the selection: arrows move along an axis, arcs rotate around it,
 * boxes scale along it (Shift scales uniformly) and the center moves freely in the construction
 * plane. Clicking a handle without dragging asks for an exact value.
 */
export class Gumball {
  private readonly layers = new Map<Viewport, SVGSVGElement>()
  private drag: DragState | null = null
  private readonly a: ScreenPoint = { x: 0, y: 0 }
  private readonly b: ScreenPoint = { x: 0, y: 0 }

  constructor(
    private readonly display: Display,
    private readonly doc: Document,
    private readonly settings: Settings,
    private readonly runner: CommandRunner,
    private readonly log: (text: string) => void,
  ) {
    for (const vp of display.viewports) {
      const layer = svg('svg', { class: 'gumball' })
      layer.dataset.noPick = ''
      layer.addEventListener('pointerdown', (e) => this.onDown(vp, e))
      layer.addEventListener('pointermove', (e) => this.onMove(e))
      layer.addEventListener('pointerup', (e) => this.onUp(e))
      layer.addEventListener('pointercancel', () => this.cancelDrag())
      vp.el.appendChild(layer)
      this.layers.set(vp, layer)
    }
    display.overlays.push((vp) => this.draw(vp))
    settings.onChange(() => display.requestRender())
  }

  private get visible(): boolean {
    if (!this.settings.gumball || this.runner.busy) return false
    // Hide while the selection is being dragged directly in a viewport.
    if (this.display.hasHidden && !this.drag) return false
    return this.doc.selection.size > 0 || this.doc.selectedPointCount > 0
  }

  // --- Drawing -------------------------------------------------------------------------

  private draw(vp: Viewport): void {
    const layer = this.layers.get(vp)!
    layer.replaceChildren()
    const box = editBox(this.doc)
    if (!this.visible || box.isEmpty()) return

    const origin = box.getCenter(new Vector3())
    if (this.drag) origin.applyMatrix4(this.drag.matrix)
    if (!vp.project(origin, this.a)) return
    const o = { x: this.a.x, y: this.a.y }
    const length = vp.worldPerPixel(origin) * SIZE
    const viewDirection = origin.clone().sub(vp.camera.position).normalize()

    AXES.forEach((axis, i) => {
      const tip = this.toScreen(vp, origin.clone().addScaledVector(axis, length))
      if (!tip) return
      const dx = tip.x - o.x
      const dy = tip.y - o.y
      const len = Math.hypot(dx, dy)
      // An axis pointing at the viewer has no usable arrow or box in this view.
      if (len > 14) {
        const ux = dx / len
        const uy = dy / len
        const base = { x: tip.x - ux * HEAD, y: tip.y - uy * HEAD }
        const arrow = this.handle(layer, 'move', i, `Drag to move along ${AXIS_NAMES[i]}, click to type a distance`)
        arrow.append(
          svg('line', { x1: o.x, y1: o.y, x2: base.x, y2: base.y, class: 'hit' }),
          svg('line', { x1: o.x, y1: o.y, x2: base.x, y2: base.y, stroke: COLORS[i], class: 'shaft' }),
          svg('polygon', {
            points: `${tip.x},${tip.y} ${base.x - uy * 5},${base.y + ux * 5} ${base.x + uy * 5},${base.y - ux * 5}`,
            fill: COLORS[i],
            class: 'head',
          }),
        )
        const at = this.toScreen(vp, origin.clone().addScaledVector(axis, length * SCALE_AT))
        if (at) {
          const scale = this.handle(layer, 'scale', i, `Drag to scale along ${AXIS_NAMES[i]} (Shift: uniform), click to type a factor`)
          scale.append(
            svg('rect', { x: at.x - 8, y: at.y - 8, width: 16, height: 16, class: 'hit' }),
            svg('rect', { x: at.x - 4, y: at.y - 4, width: 8, height: 8, fill: COLORS[i], class: 'box' }),
          )
        }
      }

      // Rotation: a quarter arc in the plane of the other two axes. Seen edge-on it would be a
      // line that cannot be dragged sensibly, so it is left out.
      if (Math.abs(axis.dot(viewDirection)) < 0.2) return
      const u = AXES[(i + 1) % 3]
      const w = AXES[(i + 2) % 3]
      const pts: ScreenPoint[] = []
      for (let k = 0; k <= 16; k++) {
        const t = (Math.PI / 2) * (0.12 + (0.76 * k) / 16)
        const p = origin
          .clone()
          .addScaledVector(u, Math.cos(t) * length * ARC_RADIUS)
          .addScaledVector(w, Math.sin(t) * length * ARC_RADIUS)
        const s = this.toScreen(vp, p)
        if (s) pts.push(s)
      }
      const extent = pts.length > 1 ? Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) : 0
      if (extent > 12) {
        const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')
        const arc = this.handle(layer, 'rotate', i, `Drag to rotate around ${AXIS_NAMES[i]}, click to type an angle`)
        arc.append(svg('path', { d, class: 'hit' }), svg('path', { d, stroke: COLORS[i], class: 'arc' }))
      }
    })

    const center = this.handle(layer, 'free', -1, 'Drag to move in the construction plane')
    center.append(svg('circle', { cx: o.x, cy: o.y, r: 9, class: 'hit' }), svg('circle', { cx: o.x, cy: o.y, r: 4.5, class: 'center' }))

    if (this.drag?.moved && this.drag.vp === vp && this.drag.label) {
      const text = svg('text', { x: o.x + 14, y: o.y - 14, class: 'readout' })
      text.textContent = this.drag.label
      layer.appendChild(text)
    }
  }

  private handle(layer: SVGSVGElement, mode: Mode, axis: number, tip: string): SVGGElement {
    const g = svg('g', { class: `handle ${mode}` })
    g.dataset.mode = mode
    g.dataset.axis = String(axis)
    g.dataset.tip = tip
    if (this.drag && this.drag.mode === mode && this.drag.axis === axis) g.classList.add('active')
    layer.appendChild(g)
    return g
  }

  private toScreen(vp: Viewport, p: Vector3): ScreenPoint | null {
    return vp.project(p, this.b) ? { x: this.b.x, y: this.b.y } : null
  }

  // --- Dragging ------------------------------------------------------------------------

  private local(vp: Viewport, e: PointerEvent): ScreenPoint {
    const rect = vp.el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Parameter along the axis line through `origin` closest to the pick ray. */
  private axisParam(vp: Viewport, origin: Vector3, axis: Vector3, sx: number, sy: number): number {
    const ray = vp.screenRay(sx, sy)
    const w0 = origin.clone().sub(ray.origin)
    const b = axis.dot(ray.direction)
    const denom = 1 - b * b
    if (denom < 1e-9) return 0
    return (b * ray.direction.dot(w0) - axis.dot(w0)) / denom
  }

  private screenAngle(vp: Viewport, origin: Vector3, sx: number, sy: number): number {
    vp.project(origin, this.a)
    return Math.atan2(-(sy - this.a.y), sx - this.a.x)
  }

  private onDown(vp: Viewport, e: PointerEvent): void {
    const target = (e.target as Element).closest<SVGGElement>('[data-mode]')
    if (!target || e.button !== 0 || !this.visible) return
    e.preventDefault()
    e.stopPropagation()
    this.display.setActive(vp)
    const mode = target.dataset.mode as Mode
    const axis = Number(target.dataset.axis)
    const origin = editBox(this.doc).getCenter(new Vector3())
    const { x, y } = this.local(vp, e)
    let startParam = 0
    let startPoint: Vector3 | null = null
    if (mode === 'move' || mode === 'scale') startParam = this.axisParam(vp, origin, AXES[axis], x, y)
    else if (mode === 'rotate') startParam = this.screenAngle(vp, origin, x, y)
    else startPoint = vp.screenToPlane(x, y, origin, vp.cplane.normal)
    this.drag = { vp, mode, axis, origin, startX: x, startY: y, startParam, startPoint, moved: false, matrix: new Matrix4(), label: '' }
    this.layers.get(vp)!.setPointerCapture(e.pointerId)
  }

  private onMove(e: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    const { x, y } = this.local(drag.vp, e)
    if (!drag.moved) {
      if (Math.hypot(x - drag.startX, y - drag.startY) <= CLICK_SLOP) return
      drag.moved = true
      this.display.setHidden(editedIds(this.doc))
    }
    const result = this.dragMatrix(drag, x, y, e.shiftKey)
    if (!result) return
    drag.matrix = result.matrix
    drag.label = result.label
    const moved = transformedSelection(this.doc, drag.matrix)
    this.display.setPreview([...moved.values()].map((g) => tessellate(g)), true)
  }

  private dragMatrix(drag: DragState, x: number, y: number, shift: boolean): { matrix: Matrix4; label: string } | null {
    const { vp, origin, axis } = drag
    const fmt = (n: number) => String(Number(n.toFixed(3)))
    switch (drag.mode) {
      case 'move': {
        let t = this.axisParam(vp, origin, AXES[axis], x, y) - drag.startParam
        if (this.settings.gridSnap) t = Math.round(t / this.settings.gridSpacing) * this.settings.gridSpacing
        return { matrix: translation(AXES[axis].clone().multiplyScalar(t)), label: `${AXIS_NAMES[axis]} ${t >= 0 ? '+' : ''}${fmt(t)}` }
      }
      case 'free': {
        const p = vp.screenToPlane(x, y, origin, vp.cplane.normal)
        if (!p || !drag.startPoint) return null
        let d = p.sub(drag.startPoint)
        if (this.settings.gridSnap) {
          const s = this.settings.gridSpacing
          const { xaxis, yaxis } = vp.cplane
          d = xaxis.clone().multiplyScalar(Math.round(d.dot(xaxis) / s) * s).addScaledVector(yaxis, Math.round(d.dot(yaxis) / s) * s)
        }
        return { matrix: translation(d), label: `${fmt(d.length())}` }
      }
      case 'rotate': {
        // Turning counterclockwise on screen is a positive rotation when the axis points at the viewer.
        const towardViewer = vp.camera.getWorldDirection(new Vector3()).negate()
        const sign = AXES[axis].dot(towardViewer) >= 0 ? 1 : -1
        let angle = this.screenAngle(vp, origin, x, y) - drag.startParam
        angle = Math.atan2(Math.sin(angle), Math.cos(angle)) * sign
        if (shift || this.settings.ortho) angle = Math.round(angle / ANGLE_STEP) * ANGLE_STEP
        return { matrix: rotationAbout(origin, AXES[axis], angle), label: `${fmt((angle * 180) / Math.PI)}°` }
      }
      case 'scale': {
        if (Math.abs(drag.startParam) < 1e-9) return null
        let f = this.axisParam(vp, origin, AXES[axis], x, y) / drag.startParam
        if (Math.abs(f) < 1e-3) f = 1e-3
        if (shift) return { matrix: scaleAbout(origin, f), label: `×${fmt(f)}` }
        return { matrix: axisScale(origin, axis, f), label: `${AXIS_NAMES[axis]} ×${fmt(f)}` }
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    const layer = this.layers.get(drag.vp)!
    if (layer.hasPointerCapture(e.pointerId)) layer.releasePointerCapture(e.pointerId)
    this.drag = null
    if (drag.moved) {
      this.display.setHidden([])
      this.display.setPreview([])
      // Commit through a command so the change is one undo step and shows in the history.
      void this.runner.runCommand(this.apply(drag.label, drag.matrix))
    } else if (drag.mode !== 'free') {
      void this.runner.runCommand(this.typedValue(drag))
    }
    this.display.requestRender()
  }

  private cancelDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.display.setHidden([])
    this.display.setPreview([])
  }

  private apply(label: string, matrix: Matrix4): Command {
    return {
      name: 'Gumball',
      repeat: false,
      run: ({ doc }) => {
        for (const [id, g] of transformedSelection(doc, matrix)) doc.setGeometry(id, g)
        this.log(`Gumball ${label}`)
      },
    }
  }

  /** Asks for an exact distance, angle or factor after a click on a handle. */
  private typedValue({ mode, axis, origin }: DragState): Command {
    const name = AXIS_NAMES[axis]
    return {
      name: 'Gumball',
      repeat: false,
      run: async ({ doc, input }) => {
        const prompt = mode === 'move' ? `Distance along ${name}` : mode === 'rotate' ? `Angle around ${name}` : `Scale factor along ${name}`
        const value = await input.getNumber(prompt, mode === 'scale' ? 1 : 0)
        if (typeof value !== 'number') return
        if (mode === 'scale' && value <= 0) throw new Error('The scale factor must be positive')
        const matrix =
          mode === 'move'
            ? translation(AXES[axis].clone().multiplyScalar(value))
            : mode === 'rotate'
              ? rotationAbout(origin, AXES[axis], (value * Math.PI) / 180)
              : axisScale(origin, axis, value)
        for (const [id, g] of transformedSelection(doc, matrix)) doc.setGeometry(id, g)
      },
    }
  }
}

/** Scale by f along one world axis, about a point. */
function axisScale(origin: Vector3, axis: number, f: number): Matrix4 {
  const s = [1, 1, 1]
  s[axis] = f
  return new Matrix4()
    .makeTranslation(origin.x, origin.y, origin.z)
    .multiply(new Matrix4().makeScale(s[0], s[1], s[2]))
    .multiply(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
}
