import * as THREE from 'three'
import type { Plane } from '../core/geometry'

export type ViewKind = 'Top' | 'Front' | 'Right' | 'Perspective'

/** How a viewport draws surfaces: not at all, solid, see-through, or see-through with every edge on top. */
export type DisplayMode = 'wireframe' | 'shaded' | 'rendered' | 'ghosted' | 'xray'

/** Where a viewport looks from, to save and restore views. */
export interface ViewState {
  target: [number, number, number]
  viewHeight: number
  distance: number
  azimuth: number
  elevation: number
}

/** The construction plane every view starts with. */
export function worldPlane(kind: ViewKind): Plane {
  const setup = SETUPS[kind]
  return { origin: new THREE.Vector3(), xaxis: setup.x.clone(), yaxis: setup.y.clone(), normal: setup.x.clone().cross(setup.y) }
}

const X = new THREE.Vector3(1, 0, 0)
const Y = new THREE.Vector3(0, 1, 0)
const Z = new THREE.Vector3(0, 0, 1)

// World is Z-up. `dir` is the viewing direction of the parallel views; x/y span the construction plane.
const SETUPS: Record<ViewKind, { dir: THREE.Vector3; up: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3 }> = {
  Top: { dir: new THREE.Vector3(0, 0, -1), up: Y, x: X, y: Y },
  Front: { dir: new THREE.Vector3(0, 1, 0), up: Z, x: X, y: Z },
  Right: { dir: new THREE.Vector3(-1, 0, 0), up: Z, x: Y, y: Z },
  Perspective: { dir: new THREE.Vector3(), up: Z, x: X, y: Y },
}

const ORTHO_DISTANCE = 10000
const DEFAULT_HEIGHT = 60
const DEFAULT_DISTANCE = 90
const DEFAULT_AZIMUTH = -Math.PI / 4
const DEFAULT_ELEVATION = Math.PI / 6
const MAX_ELEVATION = THREE.MathUtils.degToRad(89)
const FOV = 35

const GRID_EXTENT = 100
const GRID_MAJOR = 10
const GRID_COLORS = { minor: 0x9da3aa, major: 0x878d95, xaxis: 0x9b3a34, yaxis: 0x3b7d3f }

const GIZMO_SIZE = 56
const GIZMO_LENGTH = 20
const GIZMO_AXES = [
  { dir: X, label: 'X', color: '#c8463d' },
  { dir: Y, label: 'Y', color: '#3f9a45' },
  { dir: Z, label: 'Z', color: '#3a6fd8' },
]
const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ScreenPoint {
  x: number
  y: number
}

export class Viewport {
  readonly el: HTMLDivElement
  readonly titleEl: HTMLSpanElement
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  readonly cplane: Plane
  readonly grid: THREE.Group
  readonly target = new THREE.Vector3()
  /** How surfaces and solids are drawn; wireframe draws only their edges. */
  mode: DisplayMode
  private readonly gizmo: { group: SVGGElement; line: SVGLineElement; text: SVGTextElement }[] = []

  private viewHeight = DEFAULT_HEIGHT
  private distance = DEFAULT_DISTANCE
  private azimuth = DEFAULT_AZIMUTH
  private elevation = DEFAULT_ELEVATION
  private readonly tmp = new THREE.Vector3()

  constructor(readonly kind: ViewKind) {
    const setup = SETUPS[kind]
    this.cplane = worldPlane(kind)
    this.camera =
      kind === 'Perspective' ? new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e5) : new THREE.OrthographicCamera()
    this.grid = buildGrid(this.cplane)
    this.mode = kind === 'Perspective' ? 'shaded' : 'wireframe'

    this.el = document.createElement('div')
    this.el.className = 'viewport'
    this.el.dataset.view = kind
    this.titleEl = document.createElement('span')
    this.titleEl.className = 'viewport-title'
    this.titleEl.textContent = kind
    this.el.append(this.titleEl, this.buildGizmo())
  }

  private buildGizmo(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'axis-gizmo')
    svg.setAttribute('viewBox', `${-GIZMO_SIZE / 2} ${-GIZMO_SIZE / 2} ${GIZMO_SIZE} ${GIZMO_SIZE}`)
    for (const axis of GIZMO_AXES) {
      const group = document.createElementNS(SVG_NS, 'g')
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('stroke', axis.color)
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('fill', axis.color)
      text.textContent = axis.label
      group.append(line, text)
      svg.appendChild(group)
      this.gizmo.push({ group, line, text })
    }
    return svg
  }

  /** Points the corner axis triad along the current view. */
  updateGizmo(): void {
    const view = this.camera.matrixWorldInverse
    const ends = GIZMO_AXES.map((axis, i) => ({ i, v: this.tmp.copy(axis.dir).transformDirection(view).clone() }))
    // Draw the axes pointing away from the viewer first, so the nearer ones stay on top.
    ends.sort((a, b) => a.v.z - b.v.z)
    for (const { i, v } of ends) {
      const { group, line, text } = this.gizmo[i]
      const x = v.x * GIZMO_LENGTH
      const y = -v.y * GIZMO_LENGTH
      line.setAttribute('x2', x.toFixed(2))
      line.setAttribute('y2', y.toFixed(2))
      // An axis that points straight at the viewer collapses to a dot, so its label is hidden.
      const visible = Math.hypot(v.x, v.y) > 0.15
      text.style.display = visible ? '' : 'none'
      text.setAttribute('x', (x * 1.3).toFixed(2))
      text.setAttribute('y', (y * 1.3).toFixed(2))
      group.parentNode!.appendChild(group)
    }
  }

  /** True when surfaces are drawn filled (in any mode but wireframe). */
  get shaded(): boolean {
    return this.mode !== 'wireframe'
  }

  /** Moves the construction plane (the grid, typed coordinates and picking follow it). */
  setCPlane(plane: Pick<Plane, 'origin' | 'xaxis' | 'yaxis'>): void {
    const x = plane.xaxis.clone().normalize()
    const y = plane.yaxis.clone().addScaledVector(x, -plane.yaxis.dot(x)).normalize()
    this.cplane.origin.copy(plane.origin)
    this.cplane.xaxis.copy(x)
    this.cplane.yaxis.copy(y)
    this.cplane.normal.copy(x).cross(y)
    const fresh = buildGrid(this.cplane)
    for (const child of this.grid.children) (child as THREE.LineSegments).geometry.dispose()
    this.grid.clear()
    this.grid.add(...fresh.children)
  }

  get state(): ViewState {
    return {
      target: this.target.toArray() as [number, number, number],
      viewHeight: this.viewHeight,
      distance: this.distance,
      azimuth: this.azimuth,
      elevation: this.elevation,
    }
  }

  set state(s: ViewState) {
    this.target.fromArray(s.target)
    this.viewHeight = s.viewHeight
    this.distance = s.distance
    this.azimuth = s.azimuth
    this.elevation = s.elevation
    this.updateCamera()
  }

  get isOrtho(): boolean {
    return this.kind !== 'Perspective'
  }

  // The size is read from the page once per frame (see measure()), not for every projected point:
  // reading layout while the cursor overlays change forces the browser to lay out the page again.
  private size = { width: 1, height: 1 }

  /** Reads the viewport's size from the page; updateCamera() does, once per frame. */
  measure(): void {
    this.size = { width: Math.max(1, this.el.clientWidth), height: Math.max(1, this.el.clientHeight) }
  }

  get width(): number {
    return this.size.width
  }

  get height(): number {
    return this.size.height
  }

  get isVisible(): boolean {
    return this.el.clientWidth > 0 && this.el.clientHeight > 0
  }

  /** Recomputes the camera from the view parameters and the element size. */
  updateCamera(): void {
    this.measure()
    const aspect = this.width / this.height
    const cam = this.camera
    if (cam instanceof THREE.OrthographicCamera) {
      const setup = SETUPS[this.kind]
      const half = this.viewHeight / 2
      cam.left = -half * aspect
      cam.right = half * aspect
      cam.top = half
      cam.bottom = -half
      cam.near = 0.1
      cam.far = ORTHO_DISTANCE * 2
      cam.position.copy(this.target).addScaledVector(setup.dir, -ORTHO_DISTANCE)
      cam.up.copy(setup.up)
    } else {
      const ce = Math.cos(this.elevation)
      cam.aspect = aspect
      cam.near = Math.max(0.01, this.distance * 0.01)
      cam.far = this.distance * 1000
      cam.position.set(
        this.target.x + this.distance * ce * Math.cos(this.azimuth),
        this.target.y + this.distance * ce * Math.sin(this.azimuth),
        this.target.z + this.distance * Math.sin(this.elevation),
      )
      cam.up.copy(Z)
    }
    cam.lookAt(this.target)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
  }

  /** World length of one pixel at the depth of `at`, for overlays that keep a constant screen size. */
  worldPerPixel(at: THREE.Vector3): number {
    const cam = this.camera
    if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / this.height
    const depth = at.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3()))
    return (2 * Math.max(depth, cam.near) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.height
  }

  /** Projects a world point to element pixels. Returns false if it falls outside the depth range. */
  project(p: THREE.Vector3, out: ScreenPoint): boolean {
    const v = this.tmp.copy(p).project(this.camera)
    out.x = ((v.x + 1) / 2) * this.width
    out.y = ((1 - v.y) / 2) * this.height
    return v.z > -1 && v.z < 1
  }

  screenRay(sx: number, sy: number): THREE.Ray {
    const nx = (sx / this.width) * 2 - 1
    const ny = -((sy / this.height) * 2 - 1)
    if (this.isOrtho) {
      const origin = new THREE.Vector3(nx, ny, -1).unproject(this.camera)
      return new THREE.Ray(origin, this.camera.getWorldDirection(new THREE.Vector3()))
    }
    const origin = this.camera.position.clone()
    const direction = new THREE.Vector3(nx, ny, 0.5).unproject(this.camera).sub(origin).normalize()
    return new THREE.Ray(origin, direction)
  }

  /** Intersects the pick ray with a plane (the construction plane by default). */
  screenToPlane(sx: number, sy: number, origin = this.cplane.origin, normal = this.cplane.normal): THREE.Vector3 | null {
    const ray = this.screenRay(sx, sy)
    const denom = ray.direction.dot(normal)
    if (Math.abs(denom) < 1e-9) return null
    const t = this.tmp.copy(origin).sub(ray.origin).dot(normal) / denom
    if (!this.isOrtho && t < 0) return null
    return ray.origin.addScaledVector(ray.direction, t)
  }

  /** Point under the cursor on the plane through the target that faces the camera. */
  private screenToViewPlane(sx: number, sy: number): THREE.Vector3 | null {
    return this.screenToPlane(sx, sy, this.target, this.camera.getWorldDirection(new THREE.Vector3()))
  }

  pan(fromX: number, fromY: number, toX: number, toY: number): void {
    const a = this.screenToViewPlane(fromX, fromY)
    const b = this.screenToViewPlane(toX, toY)
    if (!a || !b) return
    this.target.add(a).sub(b)
    this.updateCamera()
  }

  orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.008
    this.elevation = THREE.MathUtils.clamp(this.elevation + dy * 0.008, -MAX_ELEVATION, MAX_ELEVATION)
    this.updateCamera()
  }

  /** Scales the view by `factor` (>1 zooms out), keeping the point under the cursor fixed. */
  zoom(factor: number, sx: number, sy: number): void {
    const before = this.screenToViewPlane(sx, sy)
    this.viewHeight = THREE.MathUtils.clamp(this.viewHeight * factor, 1e-4, 1e7)
    this.distance = THREE.MathUtils.clamp(this.distance * factor, 1e-3, 1e7)
    this.updateCamera()
    const after = this.screenToViewPlane(sx, sy)
    if (before && after) this.target.add(before).sub(after)
    this.updateCamera()
  }

  /** Frames a bounding box. An empty box restores the default view. */
  fit(box: THREE.Box3): void {
    if (box.isEmpty()) {
      this.target.set(0, 0, 0)
      this.viewHeight = DEFAULT_HEIGHT
      this.distance = DEFAULT_DISTANCE
      this.updateCamera()
      return
    }
    this.measure()
    const aspect = this.width / this.height
    box.getCenter(this.target)
    const radius = box.getSize(new THREE.Vector3()).length() / 2
    if (radius < 1e-9) {
      this.viewHeight = 10
      this.distance = 20
    } else {
      this.updateCamera()
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
      const size = box.getSize(new THREE.Vector3())
      const w = Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z
      const h = Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z
      this.viewHeight = Math.max(h, w / aspect, 1e-4) * 1.15
      const halfFov = THREE.MathUtils.degToRad(FOV) / 2
      const limitingFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect))
      this.distance = (radius / Math.sin(limitingFov)) * 1.1
    }
    this.updateCamera()
  }
}

function buildGrid(plane: Plane): THREE.Group {
  const buckets: Record<keyof typeof GRID_COLORS, THREE.Vector3[]> = { minor: [], major: [], xaxis: [], yaxis: [] }
  const at = (u: number, v: number) =>
    plane.origin.clone().addScaledVector(plane.xaxis, u).addScaledVector(plane.yaxis, v)

  for (let i = -GRID_EXTENT; i <= GRID_EXTENT; i++) {
    const kind = i % GRID_MAJOR === 0 ? 'major' : 'minor'
    buckets[i === 0 ? 'yaxis' : kind].push(at(i, -GRID_EXTENT), at(i, GRID_EXTENT))
    buckets[i === 0 ? 'xaxis' : kind].push(at(-GRID_EXTENT, i), at(GRID_EXTENT, i))
  }

  const group = new THREE.Group()
  for (const key of ['minor', 'major', 'xaxis', 'yaxis'] as const) {
    const material = new THREE.LineBasicMaterial({ color: GRID_COLORS[key], depthTest: false, depthWrite: false })
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(buckets[key]), material)
    lines.renderOrder = -1
    group.add(lines)
  }
  return group
}
