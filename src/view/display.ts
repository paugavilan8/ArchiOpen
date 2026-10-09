import * as THREE from 'three'
import type { Document } from '../core/document'
import { controlPoints } from '../core/curves'
import { BrepGeometry, expandBox, wireframe } from '../core/geometry'
import { flatten } from '../core/blocks'
import { hatchTriangles } from '../core/hatch'
import { dashesOf } from '../core/linetypes'
import { Viewport, ViewKind } from './viewport'

const GAP_COLOR = 0x15171a
const BACKGROUND_COLOR = 0xb1b6bd
const SELECTED_COLOR = '#ffee00'
const LOCKED_COLOR = '#6b7280'
const PREVIEW_COLOR = '#1b2330'
const POINT_COLOR = '#14181d'
const POLYGON_COLOR = '#6b7280'
const POINT_SIZE = 7
/** Three.js layer for shaded surfaces, so only shaded viewports draw them. */
const SHADED_LAYER = 1
/** Screen pixels per millimeter at 96 dpi. */
const MM_TO_PX = 96 / 25.4

const VIEW_ORDER: ViewKind[] = ['Top', 'Perspective', 'Front', 'Right']

/** Owns the WebGL canvas and draws the document into every visible viewport. */
export class Display {
  readonly viewports: Viewport[]
  active: Viewport

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly objectsGroup = new THREE.Group()
  private readonly previewGroup = new THREE.Group()
  private readonly materials = new Map<string, THREE.LineBasicMaterial | THREE.LineDashedMaterial>()
  private readonly dashedMaterials: THREE.LineDashedMaterial[] = []
  private readonly fillMaterials = new Map<string, THREE.MeshBasicMaterial>()
  private readonly pointsGroup = new THREE.Group()
  private readonly surfaceGroup = new THREE.Group()
  private readonly fillGroup = new THREE.Group()
  private readonly surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>()
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6)
  private readonly raycaster = new THREE.Raycaster()
  private readonly previewMaterial = new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, depthTest: false })
  private readonly selectedPreviewMaterial = new THREE.LineBasicMaterial({ color: SELECTED_COLOR, depthTest: false })
  private readonly polygonMaterial = new THREE.LineBasicMaterial({ color: POLYGON_COLOR, depthTest: false })
  private readonly pointMaterial = pointMaterial(POINT_COLOR, POINT_SIZE)
  private readonly selectedPointMaterial = pointMaterial(SELECTED_COLOR, POINT_SIZE + 2)
  /** Objects left out of the drawing, e.g. while a dragged copy of them is shown as a preview. */
  private hidden = new Set<number>()
  /** The layout shown over the viewports, or null for the model. */
  activeLayout: number | null = null
  private readonly layoutListeners = new Set<() => void>()

  /** Shows a layout (or with null, the model again). */
  showLayout(id: number | null): void {
    if (id === this.activeLayout) return
    this.activeLayout = id
    for (const listener of this.layoutListeners) listener()
    this.requestRender()
  }

  onLayoutChange(listener: () => void): void {
    this.layoutListeners.add(listener)
  }

  /** Called for each visible viewport after it is drawn, to update HTML overlays such as the gumball. */
  readonly overlays: ((vp: Viewport) => void)[] = []
  private frame = 0
  private stale = false

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
    this.scene.add(this.fillGroup, this.objectsGroup, this.surfaceGroup, this.pointsGroup, this.previewGroup)
    // Ambient sky/ground light plus a light at the camera, as in most modelers' shaded modes.
    const ambient = new THREE.HemisphereLight(0xffffff, 0x8a9099, 1.1)
    ambient.layers.set(SHADED_LAYER)
    this.headlight.layers.set(SHADED_LAYER)
    this.scene.add(ambient, this.headlight, this.headlight.target)
    this.raycaster.layers.set(SHADED_LAYER)

    new ResizeObserver(() => this.resize()).observe(container)
    // Many changes can come at once (an import adds thousands of objects), so the scene is rebuilt
    // once, when it is next drawn or picked from.
    doc.on(() => {
      this.stale = true
      this.requestRender()
    })
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
    this.stale = false
    this.clearGroup(this.objectsGroup)
    this.clearGroup(this.surfaceGroup)
    this.clearGroup(this.fillGroup)
    // Line work is batched into one set of segments per material, so large drawings take a few draw
    // calls instead of one per line.
    const batches = new Map<THREE.Material, { positions: number[]; distances: number[]; selected: boolean }>()
    const edit = this.doc.blockEdit
    for (const obj of this.doc.objects.values()) {
      const layer = this.doc.layerOf(obj)
      if (!layer.visible || this.hidden.has(obj.id) || edit?.instanceId === obj.id) continue
      const selected = this.doc.selection.has(obj.id)
      // While a block is edited, everything else is shown dimmed.
      const color = selected ? SELECTED_COLOR : layer.locked || !this.doc.isEditable(obj) ? LOCKED_COLOR : layer.color
      const material = this.material(color, layer.linetype)
      let batch = batches.get(material)
      if (!batch) batches.set(material, (batch = { positions: [], distances: [], selected }))
      for (const pts of wireframe(obj.geometry)) {
        // Distances run along each polyline, so dashes flow around curves.
        let along = 0
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]
          const b = pts[i]
          const d = a.distanceTo(b)
          batch.positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
          batch.distances.push(along, along + d)
          along += d
        }
      }
      // Blocks fill and shade what they hold like loose objects.
      for (const g of flatten(obj.geometry)) {
        if (g.type === 'hatch' && g.pattern === 'Solid') {
          // Solid hatches are filled in every viewport, under the line work.
          const fill = new THREE.BufferGeometry()
          fill.setAttribute('position', new THREE.Float32BufferAttribute(hatchTriangles(g), 3))
          const mesh = new THREE.Mesh(fill, this.fillMaterial(color))
          mesh.userData.id = obj.id
          this.fillGroup.add(mesh)
        }
        if (g.type === 'brep') {
          const mesh = new THREE.Mesh(surfaceGeometry(g), this.surfaceMaterial(selected ? SELECTED_COLOR : layer.color, layer.locked || !this.doc.isEditable(obj)))
          mesh.layers.set(SHADED_LAYER)
          mesh.userData.id = obj.id
          this.surfaceGroup.add(mesh)
        }
      }
    }
    for (const [material, batch] of batches) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3))
      if (material instanceof THREE.LineDashedMaterial) geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(batch.distances, 1))
      const segments = new THREE.LineSegments(geometry, material)
      segments.renderOrder = batch.selected ? 1 : 0
      this.objectsGroup.add(segments)
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

  /** Surface color: the layer color blended towards light gray, so dark layers still read as shapes. */
  private surfaceMaterial(color: string, locked: boolean): THREE.MeshStandardMaterial {
    const key = `${color}${locked ? ':locked' : ''}`
    let material = this.surfaceMaterials.get(key)
    if (!material) {
      const tint = new THREE.Color(color).lerp(new THREE.Color(0xdde1e6), color === SELECTED_COLOR ? 0.35 : 0.7)
      material = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.75,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: locked,
        opacity: locked ? 0.55 : 1,
        // Pushed back slightly so edges drawn on the surface stay visible.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      this.surfaceMaterials.set(key, material)
    }
    return material
  }

  /** The surface (in a shaded viewport) or solid hatch under the cursor, and the point hit on it. */
  pickShaded(vp: Viewport, sx: number, sy: number, accept: (id: number) => boolean): { id: number; point: THREE.Vector3 } | null {
    if (this.stale) this.rebuildObjects()
    const targets = [...(vp.shaded ? this.surfaceGroup.children : []), ...this.fillGroup.children]
    if (targets.length === 0) return null
    const ndc = new THREE.Vector2((sx / vp.width) * 2 - 1, -(sy / vp.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, vp.camera)
    this.raycaster.layers.enableAll()
    for (const hit of this.raycaster.intersectObjects(targets, false)) {
      const id = hit.object.userData.id as number
      if (accept(id)) return { id, point: hit.point.clone() }
    }
    return null
  }

  /** Line material for a color and linetype. Dashes are sized in pixels; see renderNow(). */
  private material(color: string, linetype?: string): THREE.LineBasicMaterial | THREE.LineDashedMaterial {
    const dashes = dashesOf(linetype)
    const key = dashes.length > 0 ? `${color}:${linetype}` : color
    let material = this.materials.get(key)
    if (!material) {
      if (dashes.length > 0) {
        // The viewport shows the first dash and gap of the pattern, at about their printed size.
        const pixels = (mm: number) => Math.max(1.5, Math.abs(mm) * MM_TO_PX)
        const dashed = new THREE.LineDashedMaterial({ color, dashSize: pixels(dashes[0]), gapSize: pixels(dashes[1] ?? dashes[0]) })
        this.dashedMaterials.push(dashed)
        material = dashed
      } else {
        material = new THREE.LineBasicMaterial({ color })
      }
      this.materials.set(key, material)
    }
    return material
  }

  private fillMaterial(color: string): THREE.MeshBasicMaterial {
    let material = this.fillMaterials.get(color)
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      this.fillMaterials.set(color, material)
    }
    return material
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of group.children) (child as THREE.Line | THREE.Points | THREE.Mesh).geometry.dispose()
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
    if (this.stale) this.rebuildObjects()
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
      // Dashed lines measure their length in pixels of this viewport.
      const perPixel = vp.worldPerPixel(vp.target)
      for (const m of this.dashedMaterials) m.scale = 1 / perPixel
      const x = vp.el.offsetLeft
      const y = fullHeight - vp.el.offsetTop - vp.height
      r.setViewport(x, y, vp.width, vp.height)
      r.setScissor(x, y, vp.width, vp.height)
      r.clear()
      for (const other of this.viewports) other.grid.visible = other === vp
      vp.camera.layers.set(0)
      if (vp.shaded) {
        vp.camera.layers.enable(SHADED_LAYER)
        this.headlight.position.copy(vp.camera.position)
        this.headlight.target.position.copy(vp.target)
        this.headlight.target.updateMatrixWorld()
      }
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

const surfaceCache = new WeakMap<BrepGeometry, THREE.BufferGeometry>()

/** Triangles of a brep's display mesh. Rebuilt (and disposed) with the scene, so not shared. */
function surfaceGeometry(g: BrepGeometry): THREE.BufferGeometry {
  const cached = surfaceCache.get(g)
  if (cached) return cached.clone()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.display.vertices, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.display.normals, 3))
  geometry.setIndex(g.display.triangles)
  geometry.computeBoundingSphere()
  surfaceCache.set(g, geometry)
  return geometry.clone()
}
