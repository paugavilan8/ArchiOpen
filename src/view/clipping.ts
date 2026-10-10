import * as THREE from 'three'
import type { Document } from '../core/document'
import { clippingNormal, type ClippingGeometry } from '../core/geometry'

/**
 * Clipping planes as the views draw them. Every material of the model holds one shared list of
 * planes, filled with the planes of each viewport just before that viewport is drawn, so a plane
 * cuts only in the views it is on. Closed solids are then capped where they are cut: the classic
 * stencil count (faces facing away add one, faces facing the camera take one away) leaves a mark
 * where the cut plane is inside a solid, and a quad on the plane is drawn there. Solids are capped
 * in their own color, a little darker so the cut reads: those of one color are done together.
 */

/** How much darker than its solid a cut face is. */
const CAP_SHADE = 0.72

/** The clipping planes of the model that cut the given viewport (Three.js planes, keeping their positive side). */
export function viewClippingPlanes(doc: Document, view: string): THREE.Plane[] {
  const planes: THREE.Plane[] = []
  for (const obj of doc.objects.values()) {
    const g = obj.geometry
    if (g.type !== 'clipping' || !g.views.includes(view) || !doc.isVisible(obj)) continue
    planes.push(clippingPlane(g))
  }
  return planes
}

/** The plane of a clipping plane, moved back a hair so what lies on it (its own rectangle, faces in it) stays. */
export function clippingPlane(g: ClippingGeometry): THREE.Plane {
  const normal = clippingNormal(g)
  const slack = Math.max(g.width, g.height, g.center.length(), 1) * 1e-7
  return new THREE.Plane(normal, -normal.dot(g.center) + slack)
}

/** True if `p` is cut away by any of the planes. */
export const isClipped = (planes: readonly THREE.Plane[], p: THREE.Vector3): boolean => planes.some((plane) => plane.distanceToPoint(p) < 0)

/** Solids to cap, and how to draw the caps. */
/** Solids of one color: their color in shaded and in rendered views, and the meshes to count with. */
interface CapGroup {
  shaded: THREE.Color
  rendered: THREE.Color
  scene: THREE.Scene
}

export class ClippingCaps {
  /** Closed solids and meshes by color, sharing the geometry (and copies' matrices) of the shaded ones. */
  private readonly groups = new Map<string, CapGroup>()
  private readonly back = stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp)
  private readonly front = stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp)
  private readonly capMaterial = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    // Clears the mark as it draws, ready for the next plane.
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  })
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMaterial)
  private readonly quadScene = new THREE.Scene()
  /** How big a quad must be to cover the model, and where the model is. */
  private size = 1
  private readonly center = new THREE.Vector3()

  constructor() {
    this.quadScene.add(this.quad)
  }

  /** Forgets the solids (their geometry belongs to the shaded meshes, which dispose of it). */
  clear(): void {
    this.groups.clear()
  }

  /**
   * Adds a closed solid or mesh drawn by `mesh` (a plain or instanced mesh), cut in `shaded` color
   * in shaded views and `rendered` color (its material's) in rendered ones.
   */
  add(mesh: THREE.Mesh, shaded: THREE.ColorRepresentation, rendered: THREE.ColorRepresentation): void {
    const colors = [new THREE.Color(shaded), new THREE.Color(rendered)].map((c) => c.multiplyScalar(CAP_SHADE))
    const key = colors.map((c) => c.getHexString()).join(':')
    let group = this.groups.get(key)
    if (!group) this.groups.set(key, (group = { shaded: colors[0], rendered: colors[1], scene: new THREE.Scene() }))
    const copy =
      mesh instanceof THREE.InstancedMesh
        ? Object.assign(new THREE.InstancedMesh(mesh.geometry, this.back, mesh.count), { instanceMatrix: mesh.instanceMatrix })
        : new THREE.Mesh(mesh.geometry, this.back)
    copy.frustumCulled = false
    group.scene.add(copy)
  }

  setModelBox(box: THREE.Box3): void {
    if (box.isEmpty()) return
    box.getCenter(this.center)
    this.size = Math.max(box.getSize(new THREE.Vector3()).length() * 2, 1e-3)
  }

  /**
   * Draws the caps of the planes over what is already drawn (with its depth), into the renderer's
   * current viewport.
   */
  draw(r: THREE.WebGLRenderer, camera: THREE.Camera, planes: THREE.Plane[], rendered: boolean): void {
    if (planes.length === 0 || this.groups.size === 0) return
    const layers = camera.layers.mask
    camera.layers.set(0)
    planes.forEach((plane, i) => {
      this.back.clippingPlanes = this.front.clippingPlanes = [plane]
      this.capMaterial.clippingPlanes = planes.filter((_, k) => k !== i)
      // A quad on the plane, around the model's center, facing along the plane's normal.
      this.quad.position.copy(plane.projectPoint(this.center, new THREE.Vector3()))
      this.quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal)
      this.quad.scale.set(this.size, this.size, 1)
      this.quad.updateMatrixWorld()
      for (const group of this.groups.values()) {
        r.clearStencil()
        group.scene.overrideMaterial = this.back
        r.render(group.scene, camera)
        group.scene.overrideMaterial = this.front
        r.render(group.scene, camera)
        group.scene.overrideMaterial = null
        this.capMaterial.color.copy(rendered ? group.rendered : group.shaded)
        r.render(this.quadScene, camera)
      }
    })
    camera.layers.mask = layers
  }
}

function stencilMaterial(side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  })
}

/** Adds the clipping chunks to a shader material's shaders, so it is cut like the built-in ones. */
export function clippable(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.clipping = true
  material.vertexShader = material.vertexShader
    .replace('void main() {', '#include <clipping_planes_pars_vertex>\nvoid main() {')
    .replace(/}\s*$/, '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);\n  #include <clipping_planes_vertex>\n}')
  material.fragmentShader = material.fragmentShader
    .replace('void main() {', '#include <clipping_planes_pars_fragment>\nvoid main() {\n  #include <clipping_planes_fragment>')
  return material
}
