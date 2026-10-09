import { Vector3 } from 'three'
import type { CommandRunner } from '../commands/runner'
import type { Document } from '../core/document'
import {
  Detail,
  drawingArea,
  fitDetail,
  formatScale,
  Layout,
  PAPER_SIZES,
  paperFactor,
  Point,
  sheetFrame,
  sheetSize,
  STANDARD_SCALES,
  STANDARD_VIEWS,
  Vec,
  view,
  viewAxes,
  wireframeDrawing,
} from '../core/layout'
import { DEFAULT_PRINT_WIDTH } from '../core/linetypes'
import { cachedHiddenLines, computeHiddenLines, usesHiddenLines } from '../io/layoutSheet'
import { kernelReady, loadKernel } from '../kernel/loadKernel'
import type { Display } from '../view/display'

const SVG_NS = 'http://www.w3.org/2000/svg'
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/** Polylines as one SVG path; y is flipped, since the sheet's y goes up. */
const pathData = (lines: Point[][], height: number) =>
  lines.map((l) => `M${l.map(([x, y]) => `${x.toFixed(2)} ${(height - y).toFixed(2)}`).join('L')}`).join('')
const fillData = (regions: Point[][][], height: number) =>
  regions.map((r) => r.map((l) => `M${l.map(([x, y]) => `${x.toFixed(2)} ${(height - y).toFixed(2)}`).join('L')}Z`).join('')).join('')

type Drag =
  | { kind: 'move' | 'pan'; detail: Detail; start: Point; current: Point }
  | { kind: 'resize'; detail: Detail; corner: number; start: Point; current: Point }
  | { kind: 'page'; start: Point; origin: Point }

const PERSPECTIVE = 'Perspective (current view)'

/**
 * Layouts over the viewports: sheet tabs along the bottom, and for an open layout the sheet itself,
 * where details are moved and resized by dragging and their view panned with Shift, and a form for
 * the selected detail or the sheet and its title block.
 */
export class LayoutEditor {
  private readonly tabs = document.createElement('div')
  private readonly root = document.createElement('div')
  private readonly canvas = svg('svg', { class: 'layout-canvas' })
  private readonly form = document.createElement('div')
  private selected: number | null = null
  private drag: Drag | null = null
  /** Sheet millimeters per screen pixel, and the sheet's offset on screen. */
  private zoom = 0
  private offset: Point = [0, 0]
  private frame = 0
  private computing = new Set<string>()

  constructor(
    private readonly container: HTMLElement,
    private readonly doc: Document,
    private readonly display: Display,
    private readonly runner: CommandRunner,
    private readonly log: (text: string) => void,
  ) {
    this.tabs.className = 'sheet-tabs'
    this.root.className = 'layout-editor'
    this.root.hidden = true
    const toolbar = document.createElement('div')
    toolbar.className = 'layout-toolbar'
    const button = (text: string, tip: string, action: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.dataset.tip = tip
      b.addEventListener('click', action)
      return b
    }
    toolbar.append(
      button('Add detail', 'Add a detail showing the model from the top', () => this.addDetail()),
      button('Fit', 'Center the selected detail on the model at a scale that fits', () => this.fitSelected()),
      button('Delete detail', 'Delete the selected detail', () => this.deleteSelected()),
      button('Zoom sheet', 'Show the whole sheet', () => this.fitSheet()),
      button('Print to PDF…', 'Print this sheet, or all of them, to PDF', () => void this.runner.run('ExportPDF')),
      button('Delete sheet', 'Delete this layout', () => this.deleteLayout()),
    )
    const body = document.createElement('div')
    body.className = 'layout-body'
    this.form.className = 'layout-form properties'
    body.append(this.canvas, this.form)
    this.root.append(toolbar, body)
    container.append(this.root, this.tabs)

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e))
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e))
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    new ResizeObserver(() => this.layout() && this.fitSheet()).observe(this.root)

    doc.on((kind) => {
      if (kind === 'selection') return
      // A layout removed by undo closes.
      if (display.activeLayout !== null && !this.layout()) display.showLayout(null)
      this.schedule()
    })
    display.onLayoutChange(() => {
      this.selected = null
      this.zoom = 0
      this.schedule()
    })
    this.schedule()
  }

  private layout(): Layout | undefined {
    return this.doc.layouts.find((l) => l.id === this.display.activeLayout)
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render())
  }

  // --- Changes -------------------------------------------------------------------------

  private commit(layout: Layout): void {
    if (this.runner.busy) return this.log('Finish the current command first')
    this.doc.begin()
    this.doc.updateLayout(layout)
    this.doc.commit()
  }

  private updateDetail(detail: Detail): void {
    const layout = this.layout()
    if (layout) this.commit({ ...layout, details: layout.details.map((d) => (d.id === detail.id ? detail : d)) })
  }

  /** Changes the open layout as it is now (form fields may change several things before redrawing). */
  private patch(change: (layout: Layout) => Layout): void {
    const layout = this.layout()
    if (layout) this.commit(change(layout))
  }

  /** Changes a detail of the open layout as it is now. */
  private patchDetail(id: number, change: (detail: Detail) => Detail): void {
    const detail = this.layout()?.details.find((d) => d.id === id)
    if (detail) this.updateDetail(change(detail))
  }

  /** A new paper size or orientation, with the details moved and sized to keep their place on the sheet. */
  private resheet(layout: Layout, paper: string, landscape: boolean): Layout {
    const [ox, oy, ow, oh] = drawingArea(...sheetSize(layout))
    const next = { ...layout, paper, landscape }
    const [nx, ny, nw, nh] = drawingArea(...sheetSize(next))
    const sx = nw / ow
    const sy = nh / oh
    return {
      ...next,
      details: layout.details.map((d) => {
        const [x, y, w, h] = d.rect
        return { ...d, rect: [nx + (x - ox) * sx, ny + (y - oy) * sy, w * sx, h * sy] }
      }),
    }
  }

  private addDetail(): void {
    const layout = this.layout()
    if (!layout) return
    const [w, h] = sheetSize(layout)
    const [x, y, aw, ah] = drawingArea(w, h)
    const id = layout.details.reduce((max, d) => Math.max(max, d.id), 0) + 1
    // A third of the drawing area, stepped so new details do not cover each other exactly.
    const shift = (layout.details.length % 4) * 10
    const detail = fitDetail(this.doc, { id, rect: [x + shift, y + shift, aw / 2, ah / 2], view: view('Top'), target: [0, 0, 0], scale: 100, hidden: false, title: '' })
    this.selected = id
    this.commit({ ...layout, details: [...layout.details, detail] })
  }

  private selectedDetail(): Detail | undefined {
    return this.layout()?.details.find((d) => d.id === this.selected)
  }

  private fitSelected(): void {
    const detail = this.selectedDetail()
    if (detail) this.updateDetail(fitDetail(this.doc, detail))
    else this.log('Select a detail first')
  }

  private deleteSelected(): void {
    const layout = this.layout()
    if (!layout || this.selected === null) return this.log('Select a detail first')
    this.commit({ ...layout, details: layout.details.filter((d) => d.id !== this.selected) })
    this.selected = null
  }

  private deleteLayout(): void {
    const layout = this.layout()
    if (!layout || this.runner.busy) return
    this.doc.begin()
    this.doc.setLayouts(this.doc.layouts.filter((l) => l !== layout))
    this.doc.commit()
    this.display.showLayout(null)
    this.log(`Layout "${layout.name}" deleted (Undo brings it back)`)
  }

  // --- Drawing -------------------------------------------------------------------------

  /** Shows the whole sheet with a margin. */
  private fitSheet(): void {
    const layout = this.layout()
    if (!layout) return
    const [w, h] = sheetSize(layout)
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0) return
    this.zoom = Math.max(w / (rect.width - 40), h / (rect.height - 40))
    this.offset = [(rect.width - w / this.zoom) / 2, (rect.height - h / this.zoom) / 2]
    this.schedule()
  }

  /** A screen point on the canvas in sheet millimeters (y up). */
  private toSheet(e: { clientX: number; clientY: number }): Point {
    const layout = this.layout()!
    const rect = this.canvas.getBoundingClientRect()
    const [, h] = sheetSize(layout)
    return [(e.clientX - rect.left - this.offset[0]) * this.zoom, h - (e.clientY - rect.top - this.offset[1]) * this.zoom]
  }

  private render(): void {
    this.frame = 0
    this.renderTabs()
    const layout = this.layout()
    this.root.hidden = !layout
    if (!layout) return
    if (this.zoom === 0) {
      this.fitSheet()
      if (this.zoom === 0) return
    }
    const [w, h] = sheetSize(layout)
    this.canvas.replaceChildren()
    const page = svg('g', { transform: `translate(${this.offset[0]} ${this.offset[1]}) scale(${1 / this.zoom})` })
    page.append(svg('rect', { class: 'sheet', x: 0, y: 0, width: w, height: h }))
    const drag = this.drag
    for (const detail of layout.details) {
      let shown = detail
      if (drag && drag.kind !== 'page' && drag.detail.id === detail.id) shown = this.dragged(drag)
      page.append(this.renderDetail(shown, h, drag && drag.kind !== 'page' && drag.detail.id === detail.id ? drag.kind : null))
    }
    page.append(svg('path', { class: 'sheet-frame', d: pathData(sheetFrame(layout, w, h, String(this.doc.layouts.indexOf(layout) + 1), this.doc.layouts.length), h) }))
    this.canvas.append(page)
    this.renderForm(layout)
  }

  private renderDetail(detail: Detail, height: number, dragging: Drag['kind'] | null): SVGGElement {
    const [x, y, w, h] = detail.rect
    const g = svg('g', { 'data-detail': detail.id })
    const clipId = `detail-clip-${detail.id}`
    const clip = svg('clipPath', { id: clipId })
    clip.append(svg('rect', { x, y: height - y - h, width: w, height: h }))
    g.append(clip)
    // Moving a detail just slides its drawing; resizing shows the frame until the drop.
    if (dragging !== 'resize') {
      const content = svg('g', { 'clip-path': `url(#${clipId})` })
      const hidden = usesHiddenLines(detail) ? cachedHiddenLines(this.doc, detail) : null
      if (usesHiddenLines(detail) && !hidden) this.computeLater(detail)
      const drawing = wireframeDrawing(this.doc, detail, hidden ? (geo) => geo.type === 'annotation' || geo.type === 'hatch' : undefined)
      if (hidden) content.append(svg('path', { class: 'detail-lines', d: pathData(hidden, height), stroke: '#000', 'stroke-width': 0.25 }))
      for (const layer of this.doc.layers) {
        const entry = drawing.layers.get(layer.id)
        if (!entry) continue
        if (entry.fills.length) content.append(svg('path', { d: fillData(entry.fills, height), fill: layer.color, 'fill-rule': 'evenodd' }))
        if (entry.lines.length) {
          const width = layer.printWidth || DEFAULT_PRINT_WIDTH
          content.append(svg('path', { class: 'detail-lines', d: pathData(entry.lines, height), stroke: layer.color, 'stroke-width': width }))
        }
      }
      if (usesHiddenLines(detail) && !hidden) {
        const note = svg('text', { x: x + 2, y: height - y - h + 5, class: 'detail-note' })
        note.textContent = 'Removing hidden lines…'
        content.append(note)
      }
      g.append(content)
    }
    const selected = detail.id === this.selected
    g.append(svg('rect', { class: `detail-frame${selected ? ' selected' : ''}`, x, y: height - y - h, width: w, height: h }))
    if (selected) {
      const s = 6 * this.zoom
      const corners: Point[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]
      corners.forEach(([cx, cy], i) => g.append(svg('rect', { class: 'detail-handle', 'data-corner': i, x: cx - s / 2, y: height - cy - s / 2, width: s, height: s })))
    }
    return g
  }

  /** Works out hidden lines in the background, then draws again. */
  private computeLater(detail: Detail): void {
    const key = `${this.display.activeLayout}:${detail.id}:${this.doc.revision}`
    if (this.computing.has(key)) return
    this.computing.add(key)
    void (async () => {
      if (!kernelReady()) await loadKernel()
      // Let the sheet draw first.
      await new Promise((r) => setTimeout(r, 0))
      try {
        computeHiddenLines(this.doc, detail)
      } catch (error) {
        console.error(error)
        this.log('Could not remove hidden lines in a detail')
      }
      this.schedule()
    })()
  }

  private renderTabs(): void {
    const tab = (label: string, active: boolean, action: () => void, rename?: (el: HTMLElement) => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `sheet-tab${active ? ' active' : ''}`
      b.textContent = label
      b.addEventListener('click', action)
      if (rename) b.addEventListener('dblclick', () => rename(b))
      return b
    }
    const active = this.display.activeLayout
    const add = tab('+', false, () => void this.runner.run('Layout'))
    add.dataset.tip = 'New layout'
    this.tabs.replaceChildren(
      tab('Model', active === null, () => this.display.showLayout(null)),
      ...this.doc.layouts.map((l) =>
        tab(l.name, l.id === active, () => this.display.showLayout(l.id), (el) => this.rename(l, el)),
      ),
      add,
    )
  }

  /** Renames a layout in place of its tab. */
  private rename(layout: Layout, tab: HTMLElement): void {
    const input = document.createElement('input')
    input.className = 'sheet-tab-rename'
    input.value = layout.name
    tab.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name && name !== layout.name) this.commit({ ...layout, name })
      else this.renderTabs()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }

  // --- Form ----------------------------------------------------------------------------

  private renderForm(layout: Layout): void {
    // Keep the form while one of its fields is being edited.
    if (this.form.contains(document.activeElement) && document.activeElement !== document.body) return
    const section = (title: string) => {
      const s = document.createElement('section')
      const h = document.createElement('h3')
      h.textContent = title
      const dl = document.createElement('dl')
      s.append(h, dl)
      return { s, dl }
    }
    const field = (dl: HTMLElement, label: string, input: HTMLElement) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.append(input)
      dl.append(dt, dd)
    }
    const select = (options: [string, string][], value: string, change: (v: string) => void) => {
      const el = document.createElement('select')
      for (const [v, label] of options) el.add(new Option(label, v, false, v === value))
      el.addEventListener('change', () => change(el.value))
      return el
    }
    const text = (value: string, change: (v: string) => void) => {
      const el = document.createElement('input')
      el.value = value
      el.addEventListener('change', () => change(el.value))
      return el
    }

    const detail = layout.details.find((d) => d.id === this.selected)
    const parts: HTMLElement[] = []
    if (detail) {
      const id = detail.id
      const { s, dl } = section('Detail')
      const views = [...Object.keys(STANDARD_VIEWS).map((n): [string, string] => [n, n]), [PERSPECTIVE, PERSPECTIVE] as [string, string]]
      field(dl, 'View', select(views, detail.view.eye ? PERSPECTIVE : detail.view.name, (name) => this.patchDetail(id, (d) => fitDetail(this.doc, { ...d, view: this.viewNamed(name) }))))
      if (!detail.view.eye) {
        const scales = STANDARD_SCALES.map((n): [string, string] => [String(n), formatScale(n)])
        if (!STANDARD_SCALES.includes(detail.scale)) scales.unshift([String(detail.scale), formatScale(detail.scale)])
        field(dl, 'Scale', select(scales, String(detail.scale), (v) => this.patchDetail(id, (d) => ({ ...d, scale: Number(v) }))))
        field(
          dl,
          'Display',
          select([['wire', 'Wireframe'], ['hidden', 'Hidden lines removed']], detail.hidden ? 'hidden' : 'wire', (v) => this.patchDetail(id, (d) => ({ ...d, hidden: v === 'hidden' }))),
        )
      }
      field(dl, 'Caption', text(detail.title, (v) => this.patchDetail(id, (d) => ({ ...d, title: v }))))
      const hint = document.createElement('p')
      hint.className = 'panel-hint layout-hint'
      hint.textContent = 'Drag to move, drag a corner to resize, Shift+drag to pan the view.'
      s.append(hint)
      parts.push(s)
    }
    const sheet = section('Sheet')
    field(sheet.dl, 'Name', text(layout.name, (v) => v.trim() && this.patch((l) => ({ ...l, name: v.trim() }))))
    field(sheet.dl, 'Paper', select(Object.keys(PAPER_SIZES).map((p): [string, string] => [p, p]), layout.paper, (v) => this.patch((l) => this.resheet(l, v, l.landscape))))
    field(sheet.dl, 'Orientation', select([['l', 'Landscape'], ['p', 'Portrait']], layout.landscape ? 'l' : 'p', (v) => this.patch((l) => this.resheet(l, l.paper, v === 'l'))))
    parts.push(sheet.s)
    const title = section('Title block')
    const entry = (label: string, key: keyof Layout['titleBlock']) =>
      field(title.dl, label, text(layout.titleBlock[key], (v) => this.patch((l) => ({ ...l, titleBlock: { ...l.titleBlock, [key]: v } }))))
    entry('Project', 'project')
    entry('Drawing', 'title')
    entry('Number', 'number')
    entry('Drawn by', 'author')
    entry('Date', 'date')
    parts.push(title.s)
    this.form.replaceChildren(...parts)
  }

  /** A standard view, or the perspective viewport's camera as it is now. */
  private viewNamed(name: string) {
    if (name !== PERSPECTIVE) return view(name)
    const vp = this.display.viewports.find((v) => v.kind === 'Perspective') ?? this.display.active
    vp.updateCamera()
    const camera = vp.camera
    const back = camera.getWorldDirection(new Vector3()).negate()
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    return { name: 'Perspective', direction: back.toArray() as Vec, right: right.toArray() as Vec, eye: camera.position.toArray() as Vec }
  }

  // --- Pointer -------------------------------------------------------------------------

  /** The detail as it would be after the drag so far. */
  private dragged(drag: Exclude<Drag, { kind: 'page' }>): Detail {
    const d = drag.detail
    const dx = drag.current[0] - drag.start[0]
    const dy = drag.current[1] - drag.start[1]
    const [x, y, w, h] = d.rect
    if (drag.kind === 'move') return { ...d, rect: [x + dx, y + dy, w, h] }
    if (drag.kind === 'pan') {
      // The view moves with the cursor: the target goes the other way, in model units.
      const { right, up } = viewAxes(d.view)
      const k = paperFactor(this.doc, d)
      const target = new Vector3(...d.target).addScaledVector(right, -dx / k).addScaledVector(up, -dy / k)
      const moved = { ...d, target: target.toArray() as Vec }
      if (d.view.eye) moved.view = { ...d.view, eye: new Vector3(...d.view.eye).addScaledVector(right, -dx / k).addScaledVector(up, -dy / k).toArray() as Vec }
      return moved
    }
    if (drag.kind !== 'resize') return d
    // Resize from a corner (0 lower left, then counterclockwise), keeping the opposite one.
    const left = drag.corner === 0 || drag.corner === 3
    const bottom = drag.corner === 0 || drag.corner === 1
    const nx = left ? Math.min(x + dx, x + w - 10) : x
    const ny = bottom ? Math.min(y + dy, y + h - 10) : y
    const nw = left ? x + w - nx : Math.max(10, w + dx)
    const nh = bottom ? y + h - ny : Math.max(10, h + dy)
    return { ...d, rect: [nx, ny, nw, nh] }
  }

  private onDown(e: PointerEvent): void {
    const layout = this.layout()
    if (!layout) return
    this.canvas.setPointerCapture(e.pointerId)
    const at = this.toSheet(e)
    if (e.button !== 0) {
      this.drag = { kind: 'page', start: [e.clientX, e.clientY], origin: [...this.offset] }
      return
    }
    const handle = (e.target as Element).closest('.detail-handle')
    const current = this.selectedDetail()
    if (handle && current) {
      this.drag = { kind: 'resize', detail: current, corner: Number(handle.getAttribute('data-corner')), start: at, current: at }
      return
    }
    // The last detail is drawn on top, so it is the one picked.
    const hit = [...layout.details].reverse().find((d) => at[0] >= d.rect[0] && at[0] <= d.rect[0] + d.rect[2] && at[1] >= d.rect[1] && at[1] <= d.rect[1] + d.rect[3])
    this.selected = hit?.id ?? null
    this.drag = hit ? { kind: e.shiftKey ? 'pan' : 'move', detail: hit, start: at, current: at } : null
    this.schedule()
  }

  private onMove(e: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    if (drag.kind === 'page') {
      this.offset = [drag.origin[0] + e.clientX - drag.start[0], drag.origin[1] + e.clientY - drag.start[1]]
    } else {
      drag.current = this.toSheet(e)
    }
    this.schedule()
  }

  private onUp(e: PointerEvent): void {
    const drag = this.drag
    this.drag = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (!drag || drag.kind === 'page') return
    const moved = Math.hypot(drag.current[0] - drag.start[0], drag.current[1] - drag.start[1]) > 0.01
    if (moved) this.updateDetail(this.dragged(drag))
    else this.schedule()
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
    // Zoom about the cursor.
    this.offset = [sx - (sx - this.offset[0]) / factor, sy - (sy - this.offset[1]) / factor]
    this.zoom *= factor
    this.schedule()
  }
}
