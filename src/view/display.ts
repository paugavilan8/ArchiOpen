import * as THREE from 'three'
import type { Document } from '../core/document'
import { controlPoints } from '../core/curves'
import { expandBox, tessellate } from '../core/geometry'
import { Viewport, ViewKind } from './viewport'

const GAP_COLOR = 0x15171a
const BACKGROUND_COLOR = 0xb1b6bd
const SELECTED_COLOR = '#ffee00'
const LOCKED_COLOR = '#6b7280'
const PREVIEW_COLOR = '#1b2330'
const POINT_COLOR = '#14181d'
const POLYGON_COLOR = '#6b7280'
const POINT_SIZE = 7

const VIEW_ORDER: ViewKind[] = ['Top', 'Perspective', 'Front', 'Right']

/** Owns the WebGL canvas and draws the document into every visible viewport. */
export class Display {
  readonly viewports: Viewport[]
  active: Viewport

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly objectsGroup = new THREE.Group()
  private readonly previewGroup = new THREE.Group()
  private readonly materials = new Map<string, THREE.LineBasicMaterial>()
  private readonly pointsGroup = new THREE.Group()
  private readonly previewMaterial = new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, depthTest: false })
  private readonly selectedPreviewMaterial = new THREE.LineBasicMaterial({ color: SELECTED_COLOR, depthTest: false })
  private readonly polygonMaterial = new THREE.LineBasicMaterial({ color: POLYGON_COLOR, depthTest: false })
  private readonly pointMaterial = pointMaterial(POINT_COLOR, POINT_SIZE)
  private readonly selectedPointMaterial = pointMaterial(SELECTED_COLOR, POINT_SIZE + 2)
  /** Objects left out of the drawing, e.g. while a dragged copy of them is shown as a preview. */
  private hidden = new Set<number>()
  /** Called for each visible viewport after it is drawn, to update HTML overlays such as the gumball. */
  readonly overlays: ((vp: Viewport) => void)[] = []
  private frame = 0

  constructor(
    private readonly container: HTMLElement,
    private readonly doc: Document,
  ) {
    const canvas = document.createElement('canvas')
    canvas.className = 'viewport-canvas'
    container.appendChild(canvas)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.autoClear = false

    this.viewports = VIEW_ORDER.map((kind) => new Viewport(kind))
    for (const vp of this.viewports) {
      container.appendChild(vp.el)
      this.scene.add(vp.grid)
      vp.titleEl.addEventListener('dblclick', () => this.toggleMaximize(vp))
    }
    this.active = this.viewports[1]
    this.active.el.classList.add('active')

    this.previewGroup.renderOrder = 2
    this.scene.add(this.objectsGroup, this.pointsGroup, this.previewGroup)

    new ResizeObserver(() => this.resize()).observe(container)
    doc.on(() => this.rebuildObjects())
    this.resize()
    this.rebuildObjects()
  }

  setActive(vp: Viewport): void {
    if (vp === this.active) return
    this.active.el.classList.remove('active')
    this.active = vp
    vp.el.classList.add('active')
    if (this.isMaximized) this.setMaximized(vp)
    this.requestRender()
  }

  get isMaximized(): boolean {
    return this.container.classList.contains('maximized')
  }

  toggleMaximize(vp: Viewport = this.active): void {
    this.setActive(vp)
    this.setMaximized(this.isMaximized ? null : vp)
  }

  private setMaximized(vp: Viewport | null): void {
    this.container.classList.toggle('maximized', vp !== null)
    for (const v of this.viewports) v.el.classList.toggle('maximized', v === vp)
    this.renderNow()
  }

  /** Dynamic geometry shown while picking points; `selected` draws it in the selection color. */
  setPreview(polylines: THREE.Vector3[][], selected = false): void {
    this.clearGroup(this.previewGroup)
    for (const pts of polylines) {
      if (pts.length < 2) continue
      const material = selected ? this.selectedPreviewMaterial : this.previewMaterial
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material)
      line.renderOrder = 2
      this.previewGroup.add(line)
    }
    this.requestRender()
  }

  setHidden(ids: Iterable<number>): void {
    this.hidden = new Set(ids)
    this.rebuildObjects()
  }

  get hasHidden(): boolean {
    return this.hidden.size > 0
  }

  isHidden(id: number): boolean {
    return this.hidden.has(id)
  }

  /** Frames the given objects (all visible ones by default) in the given viewports. */
  fit(viewports: Viewport[], ids?: Iterable<number>): void {
    const box = new THREE.Box3()
    const objects = ids ? [...ids].map((id) => this.doc.objects.get(id)) : [...this.doc.objects.values()]
    for (const obj of objects) if (obj && this.doc.isVisible(obj)) expandBox(box, obj.geometry)
    for (const vp of viewports) vp.fit(box)
    this.requestRender()
  }

  requestRender(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderNow()
    })
  }

  private rebuildObjects(): void {
    this.clearGroup(this.objectsGroup)
    for (const obj of this.doc.objects.values()) {
      const layer = this.doc.layerOf(obj)
      if (!layer.visible || this.hidden.has(obj.id)) continue
      const color = this.doc.selection.has(obj.id) ? SELECTED_COLOR : layer.locked ? LOCKED_COLOR : layer.color
      const geometry = new THREE.BufferGeometry().setFromPoints(tessellate(obj.geometry))
      const line = new THREE.Line(geometry, this.material(color))
      line.renderOrder = this.doc.selection.has(obj.id) ? 1 : 0
      this.objectsGroup.add(line)
    }
    this.rebuildPoints()
    this.requestRender()
  }

  /** Control points (and the control polygon of curves) of objects with points on. */
  private rebuildPoints(): void {
    this.clearGroup(this.pointsGroup)
    for (const id of this.doc.pointsOn) {
      const obj = this.doc.objects.get(id)
      const pts = obj && !this.hidden.has(id) ? controlPoints(obj.geometry) : null
      if (!obj || !pts) continue
      if (obj.geometry.type === 'curve') {
        const polygon = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.polygonMaterial)
        polygon.renderOrder = 3
        this.pointsGroup.add(polygon)
      }
      const selected = this.doc.pointSelection.get(id)
      const normal = pts.filter((_, i) => !selected?.has(i))
      const chosen = pts.filter((_, i) => selected?.has(i))
      for (const [list, material] of [
        [normal, this.pointMaterial],
        [chosen, this.selectedPointMaterial],
      ] as const) {
        if (list.length === 0) continue
        const points = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list), material)
        points.renderOrder = 4
        this.pointsGroup.add(points)
      }
    }
  }

  private material(color: string): THREE.LineBasicMaterial {
    let material = this.materials.get(color)
    if (!material) {
      material = new THREE.LineBasicMaterial({ color })
      this.materials.set(color, material)
    }
    return material
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of group.children) (child as THREE.Line | THREE.Points).geometry.dispose()
    group.clear()
  }

  private resize(): void {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.renderNow()
  }

  private renderNow(): void {
    const r = this.renderer
    const fullHeight = this.container.clientHeight
    r.setScissorTest(false)
    r.setClearColor(GAP_COLOR)
    r.clear()
    r.setScissorTest(true)
    r.setClearColor(BACKGROUND_COLOR)

    for (const vp of this.viewports) {
      if (!vp.isVisible) continue
      vp.updateCamera()
      vp.updateGizmo()
      const x = vp.el.offsetLeft
      const y = fullHeight - vp.el.offsetTop - vp.height
      r.setViewport(x, y, vp.width, vp.height)
      r.setScissor(x, y, vp.width, vp.height)
      r.clear()
      for (const other of this.viewports) other.grid.visible = other === vp
      r.render(this.scene, vp.camera)
      for (const overlay of this.overlays) overlay(vp)
    }
  }
}

function pointMaterial(color: string, size: number): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    color,
    size: size * window.devicePixelRatio,
    sizeAttenuation: false,
    depthTest: false,
  })
}
