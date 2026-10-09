import * as THREE from 'three'
import type { Document } from '../core/document'
import { controlPoints } from '../core/curves'
import { BrepGeometry, expandBox, MeshGeometry, wireframe } from '../core/geometry'
import { meshTriangles, nakedEdges } from '../core/mesh'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { flatten } from '../core/blocks'
import { hatchTriangles } from '../core/hatch'
import { dashesOf } from '../core/linetypes'
import { METERS } from '../core/units'
import { BACKGROUNDS, RENDER_LAYER, RenderScene } from './renderScene'
import { DisplayMode, Viewport, ViewKind } from './viewport'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'

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
/** Lines only drawn in wireframe views (the inner edges of meshes). */
const WIRE_LAYER = 2
/** Edges of surfaces and meshes, which rendered views leave out. */
const EDGE_LAYER = 4

interface LineBatch {
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial
  positions: number[]
  distances: number[]
  selected: boolean
  wireOnly: boolean
  edges: boolean
}

const bordersCache = new WeakMap<MeshGeometry, THREE.Vector3[][]>()
function openBorders(g: MeshGeometry): THREE.Vector3[][] {
  let lines = bordersCache.get(g)
  if (!lines) bordersCache.set(g, (lines = nakedEdges(g)))
  return lines
}
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
  /** Lines drawn over the model by analysis commands (curvature combs, naked edges), by key. */
  private readonly overlayGroup = new THREE.Group()
  private readonly overlayLines = new Map<string, THREE.LineSegments>()
  /** Surfaces drawn with an analysis shading instead of their layer color. */
  private surfaceAnalysis: {
    mode: SurfaceAnalysisMode
    ids: Set<number>
  } | null = null
  private readonly analysisMaterials = new Map<string, THREE.ShaderMaterial>()
  /** What rendered views draw: materials, sun, environment and ground shadows. */
  readonly renderScene = new RenderScene(() => this.requestRender())
  private readonly surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>()
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6)
  private readonly raycaster = new THREE.Raycaster()
  private readonly previewMaterial = new THREE.LineBasicMaterial({
    color: PREVIEW_COLOR,
    depthTest: false,
  })
  private readonly selectedPreviewMaterial = new THREE.LineBasicMaterial({
    color: SELECTED_COLOR,
    depthTest: false,
  })
  private readonly polygonMaterial = new THREE.LineBasicMaterial({
    color: POLYGON_COLOR,
    depthTest: false,
  })
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
    this.overlayGroup.renderOrder = 3
    this.scene.add(this.fillGroup, this.objectsGroup, this.surfaceGroup, this.pointsGroup, this.previewGroup, this.overlayGroup, this.renderScene.group)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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

  /** Shows analysis lines under a key, replacing what the key showed before; no lines removes them. */
  setOverlay(key: string, lines: THREE.Vector3[][], color: string): void {
    const old = this.overlayLines.get(key)
    if (old) {
      this.overlayGroup.remove(old)
      old.geometry.dispose()
      ;(old.material as THREE.Material).dispose()
      this.overlayLines.delete(key)
    }
    const positions: number[] = []
    for (const pts of lines) for (let i = 1; i < pts.length; i++) positions.push(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z, pts[i].x, pts[i].y, pts[i].z)
    if (positions.length > 0) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const segments = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }))
      segments.renderOrder = 3
      this.overlayGroup.add(segments)
      this.overlayLines.set(key, segments)
    }
    this.requestRender()
  }

  /** Shades the given surfaces and meshes with an analysis (null turns it off). */
  setSurfaceAnalysis(analysis: { mode: SurfaceAnalysisMode; ids: Iterable<number> } | null): void {
    this.surfaceAnalysis = analysis && {
      mode: analysis.mode,
      ids: new Set(analysis.ids),
    }
    this.stale = true
    this.requestRender()
  }

  get surfaceAnalysisMode(): SurfaceAnalysisMode | null {
    return this.surfaceAnalysis?.mode ?? null
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
    this.renderScene.clear()
    const modelBox = new THREE.Box3()
    // Line work is batched into one set of segments per material, so large drawings take a few draw
    // calls instead of one per line.
    const batches = new Map<string, LineBatch>()
    // Point objects, by color.
    const dots = new Map<string, number[]>()
    const edit = this.doc.blockEdit
    for (const obj of this.doc.objects.values()) {
      const layer = this.doc.layerOf(obj)
      if (!layer.visible || obj.hidden || this.hidden.has(obj.id) || edit?.instanceId === obj.id) continue
      const selected = this.doc.selection.has(obj.id)
      // While a block is edited, everything else is shown dimmed.
      const color = selected ? SELECTED_COLOR : layer.locked || obj.locked || !this.doc.isEditable(obj) ? LOCKED_COLOR : layer.color
      const material = this.material(color, layer.linetype)
      const batchOf = (key: string) => {
        let batch = batches.get(key)
        if (!batch)
          batches.set(
            key,
            (batch = {
              material,
              positions: [],
              distances: [],
              selected,
              wireOnly: key.startsWith('wire:'),
              edges: key.startsWith('edge:'),
            }),
          )
        return batch
      }
      // A mesh shows every edge in wireframe views, but only its open borders over the shading.
      const mesh = obj.geometry.type === 'mesh' ? obj.geometry : null
      if (mesh) this.addLines(batchOf(`wire:${material.uuid}`), wireframe(mesh))
      // Edges of surfaces are left out of rendered views, unless selected.
      const surface = mesh !== null || obj.geometry.type === 'brep'
      this.addLines(batchOf(surface && !selected ? `edge:${material.uuid}` : material.uuid), mesh ? openBorders(mesh) : wireframe(obj.geometry))
      // Blocks fill and shade what they hold like loose objects.
      for (const g of flatten(obj.geometry)) {
        if (g.type === 'point') {
          let list = dots.get(color)
          if (!list) dots.set(color, (list = []))
          list.push(g.point.x, g.point.y, g.point.z)
        }
        if (g.type === 'hatch' && g.pattern === 'Solid') {
          // Solid hatches are filled in every viewport, under the line work.
          const fill = new THREE.BufferGeometry()
          fill.setAttribute('position', new THREE.Float32BufferAttribute(hatchTriangles(g), 3))
          const mesh = new THREE.Mesh(fill, this.fillMaterial(color))
          mesh.userData.id = obj.id
          this.fillGroup.add(mesh)
        }
        if (g.type === 'brep' || g.type === 'mesh') {
          const analysis = this.surfaceAnalysis?.ids.has(obj.id) ? this.analysisMaterial(this.surfaceAnalysis.mode) : null
          const material = analysis ?? this.surfaceMaterial(selected ? SELECTED_COLOR : layer.color, layer.locked || !this.doc.isEditable(obj))
          const mesh = new THREE.Mesh(g.type === 'brep' ? surfaceGeometry(g) : polygonMeshGeometry(g), material)
          this.renderScene.add(g.type === 'brep' ? surfaceGeometry(g) : polygonMeshGeometry(g), this.doc.materialOf(obj), selected, METERS[this.doc.units] ?? 0.001)
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
          modelBox.union(mesh.geometry.boundingBox!)
          // Analysis shading shows in every view, wireframe ones included.
          mesh.layers.set(analysis ? 0 : SHADED_LAYER)
          mesh.userData.id = obj.id
          this.surfaceGroup.add(mesh)
        }
      }
    }
    for (const { material, ...batch } of batches.values()) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3))
      if (material instanceof THREE.LineDashedMaterial) geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(batch.distances, 1))
      const segments = new THREE.LineSegments(geometry, material)
      segments.renderOrder = batch.selected ? 1 : 0
      if (batch.wireOnly) segments.layers.set(WIRE_LAYER)
      else if (batch.edges) segments.layers.set(EDGE_LAYER)
      this.objectsGroup.add(segments)
    }
    for (const [color, positions] of dots) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const points = new THREE.Points(geometry, this.dotMaterial(color))
      points.renderOrder = color === SELECTED_COLOR ? 1 : 0
      this.objectsGroup.add(points)
    }
    this.renderScene.update(this.doc.renderSettings, modelBox)
    this.rebuildPoints()
    this.requestRender()
  }

  /** Adds polylines to a batch of segments. Distances run along each one, so dashes flow around curves. */
  private addLines(batch: LineBatch, lines: THREE.Vector3[][]): void {
    for (const pts of lines) {
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
        // Always drawn as transparent, so ghosted and x-ray views only change the opacity (see renderNow()).
        transparent: true,
        opacity: locked ? 0.55 : 1,
        // Pushed back slightly so edges drawn on the surface stay visible.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      material.userData.opacity = material.opacity
      this.surfaceMaterials.set(key, material)
    }
    return material
  }

  private analysisMaterial(mode: SurfaceAnalysisMode): THREE.ShaderMaterial {
    const key = mode.kind === 'zebra' ? 'zebra' : `draft:${mode.angle}:${mode.pull.toArray().join(',')}`
    let material = this.analysisMaterials.get(key)
    if (!material) {
      material = mode.kind === 'zebra' ? zebraMaterial() : draftMaterial(mode.angle, mode.pull)
      this.analysisMaterials.set(key, material)
    }
    return material
  }

  /** Surfaces see-through in ghosted and x-ray views, and edges on top of everything in x-ray. */
  private applyMode(vp: Viewport): void {
    const seeThrough = vp.mode === 'ghosted' ? 0.4 : vp.mode === 'xray' ? 0.18 : 1
    for (const m of this.surfaceMaterials.values()) {
      m.opacity = (m.userData.opacity as number) * seeThrough
      m.depthWrite = seeThrough === 1
    }
    for (const m of this.materials.values()) m.depthTest = vp.mode !== 'xray'
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
        const dashed = new THREE.LineDashedMaterial({
          color,
          dashSize: pixels(dashes[0]),
          gapSize: pixels(dashes[1] ?? dashes[0]),
        })
        this.dashedMaterials.push(dashed)
        material = dashed
      } else {
        material = new THREE.LineBasicMaterial({ color })
      }
      this.materials.set(key, material)
    }
    return material
  }

  private readonly dotMaterials = new Map<string, THREE.PointsMaterial>()

  /** Point objects: small squares in their layer color, drawn over surfaces. */
  private dotMaterial(color: string): THREE.PointsMaterial {
    let material = this.dotMaterials.get(color)
    if (!material) {
      material = pointMaterial(color, POINT_SIZE - 1)
      this.dotMaterials.set(color, material)
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
      this.drawViewport(r, vp, vp.camera)
      for (const overlay of this.overlays) overlay(vp)
    }
  }

  /**
   * Draws the scene as a viewport shows it, into the renderer's current viewport: its display mode,
   * background, grid and lights. `camera` is the viewport's own, or a copy sized for an image.
   */
  private drawViewport(r: THREE.WebGLRenderer, vp: Viewport, camera: THREE.Camera, options: { grid?: boolean; occlusion?: boolean } = {}): void {
    const rendered = vp.mode === 'rendered'
    if (rendered) this.renderScene.prepare(r)
    r.setClearColor(rendered ? BACKGROUNDS[this.doc.renderSettings.background] : BACKGROUND_COLOR)
    r.toneMapping = rendered ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
    // Rhino's rendered views leave the grid out.
    for (const other of this.viewports) other.grid.visible = other === vp && !rendered && options.grid !== false
    camera.layers.set(0)
    this.applyMode(vp)
    if (!vp.shaded) camera.layers.enable(WIRE_LAYER)
    if (!rendered) camera.layers.enable(EDGE_LAYER)
    if (rendered) camera.layers.enable(RENDER_LAYER)
    else if (vp.shaded) {
      camera.layers.enable(SHADED_LAYER)
      this.headlight.position.copy(camera.position)
      this.headlight.target.position.copy(vp.target)
      this.headlight.target.updateMatrixWorld()
    }
    if (rendered && options.occlusion) {
      // Ambient occlusion darkens creases and contacts; the output pass then tone maps the result.
      const size = r.getDrawingBufferSize(new THREE.Vector2())
      const composer = new EffectComposer(r)
      composer.setPixelRatio(1)
      composer.setSize(size.x, size.y)
      const background = BACKGROUNDS[this.doc.renderSettings.background]
      // The backdrop is drawn clear and laid in at the end, so tone mapping leaves its color alone.
      composer.addPass(new RenderPass(this.scene, camera, undefined, new THREE.Color(background), 0))
      composer.addPass(new GTAOPass(this.scene, camera, size.x, size.y))
      composer.addPass(backdropOutputPass(background))
      composer.render()
      composer.dispose()
      return
    }
    r.clear()
    r.render(this.scene, camera)
  }

  /**
   * An image of a viewport at any size, drawn `supersample` times larger and scaled down for smooth
   * edges. `mode` draws it in another display mode (e.g. 'rendered'). The canvas is drawn at the new
   * size for a moment and put back before anything is shown.
   */
  captureImage(vp: Viewport, width: number, height: number, options: { mode?: DisplayMode; grid?: boolean; supersample?: number; occlusion?: boolean } = {}): HTMLCanvasElement {
    if (this.stale) this.rebuildObjects()
    const r = this.renderer
    const max = r.capabilities.maxTextureSize
    const scale = Math.max(1, Math.min(options.supersample ?? 2, Math.floor(max / Math.max(width, height))))
    const big = new THREE.Vector2(width * scale, height * scale)
    const ratio = r.getPixelRatio()
    const previousMode = vp.mode
    const camera = vp.camera.clone()
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height
    else if (camera instanceof THREE.OrthographicCamera) {
      // Same height of view; the width follows the image's shape.
      const half = (camera.top - camera.bottom) / 2
      const middle = (camera.left + camera.right) / 2
      camera.left = middle - half * (width / height)
      camera.right = middle + half * (width / height)
    }
    camera.updateProjectionMatrix()
    for (const m of this.dashedMaterials) m.scale = 1 / (vp.worldPerPixel(vp.target) / scale)
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    try {
      if (options.mode) vp.mode = options.mode
      r.setPixelRatio(1)
      r.setSize(big.x, big.y, false)
      r.setScissorTest(false)
      r.setViewport(0, 0, big.x, big.y)
      this.drawViewport(r, vp, camera, { grid: options.grid, occlusion: options.occlusion })
      // Read back at once, before the browser clears the drawing buffer.
      const ctx = out.getContext('2d')!
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(r.domElement, 0, 0, big.x, big.y, 0, 0, width, height)
    } finally {
      vp.mode = previousMode
      r.setPixelRatio(ratio)
      this.resize()
    }
    return out
  }
}

/** The output pass (tone mapping, sRGB) with the backdrop color mixed in where nothing was drawn. */
function backdropOutputPass(color: number): OutputPass {
  const pass = new OutputPass()
  // The color as written, already in sRGB like the pass's result.
  pass.uniforms.background = { value: new THREE.Color().setHex(color, THREE.LinearSRGBColorSpace) }
  pass.material.fragmentShader = pass.material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform vec3 background;')
    .replace(/}\s*$/, '\tgl_FragColor = vec4( mix( background, gl_FragColor.rgb, gl_FragColor.a ), 1.0 );\n}')
  return pass
}

function pointMaterial(color: string, size: number): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    color,
    size: size * window.devicePixelRatio,
    sizeAttenuation: false,
    depthTest: false,
  })
}

/** Facets meeting at a sharper angle than this are shaded as a crease. */
const CREASE_ANGLE = (40 * Math.PI) / 180

/** How surfaces are shaded for analysis: zebra stripes, or by draft angle against a pull direction. */
export type SurfaceAnalysisMode = { kind: 'zebra' } | { kind: 'draft'; angle: number; pull: THREE.Vector3 }

/**
 * Stripes of a striped room reflected in the surface: kinks in the stripes show where surfaces meet
 * without tangency, and their flow shows curvature.
 */
function zebraMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: { stripes: { value: 6 } },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = isOrthographic ? vec3(0.0, 0.0, 1.0) : -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float stripes;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 r = reflect(-normalize(vView), n);
        float s = smoothstep(0.46, 0.54, abs(fract(r.y * stripes) - 0.5) * 2.0);
        gl_FragColor = vec4(vec3(0.08 + 0.87 * s), 1.0);
      }`,
  })
}

/**
 * Green where a face leans away from the pull direction by at least the draft angle, yellow where it
 * leans less, red where it leans back (an undercut, which would lock in a mold).
 */
function draftMaterial(angle: number, pull: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      draft: { value: (angle * Math.PI) / 180 },
      pull: { value: pull.clone().normalize() },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float draft;
      uniform vec3 pull;
      varying vec3 vNormal;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float a = asin(clamp(dot(n, pull), -1.0, 1.0));
        vec3 color = a >= draft - 1e-4 ? vec3(0.25, 0.7, 0.3) : a >= -1e-4 ? mix(vec3(0.95, 0.85, 0.2), vec3(0.6, 0.8, 0.3), a / max(draft, 1e-4)) : vec3(0.85, 0.2, 0.2);
        gl_FragColor = vec4(color, 1.0);
      }`,
  })
}

const polygonMeshCache = new WeakMap<MeshGeometry, THREE.BufferGeometry>()

/** Triangles of a polygon mesh, smooth across gentle bends and sharp at creases (as a box's edges). */
function polygonMeshGeometry(g: MeshGeometry): THREE.BufferGeometry {
  let geometry = polygonMeshCache.get(g)
  if (!geometry) {
    const indexed = new THREE.BufferGeometry()
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(g.vertices, 3))
    indexed.setIndex(meshTriangles(g))
    geometry = toCreasedNormals(indexed, CREASE_ANGLE)
    indexed.dispose()
    geometry.computeBoundingSphere()
    polygonMeshCache.set(g, geometry)
  }
  return geometry.clone()
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
