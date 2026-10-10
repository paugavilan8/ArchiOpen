import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Material, RenderSettings } from '../core/materials'
import { addBoxUVs, TextureLibrary } from './textures'

/** Layer of everything that only rendered views draw. */
export const RENDER_LAYER = 3

export const BACKGROUNDS: Record<RenderSettings['background'], number> = { Studio: 0xd6d9de, White: 0xffffff, Sky: 0xbcd3e8 }

/**
 * The rendered look: physically based materials lit by a soft studio environment and a sun that
 * casts shadows on a ground under the model.
 */
export class RenderScene {
  readonly group = new THREE.Group()
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2)
  private readonly sky = new THREE.HemisphereLight(0xffffff, 0x6b6f75, 0.3)
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>
  private readonly meshes = new THREE.Group()
  private readonly materials = new Map<string, THREE.MeshPhysicalMaterial>()
  private environment: THREE.Texture | null = null

  private readonly textures: TextureLibrary

  /** `onTextureLoad` is called when a picture has loaded, to draw again. */
  /** `clippingPlanes` is the list of planes the model's materials are cut by (see clipping.ts). */
  constructor(
    onTextureLoad: () => void = () => {},
    private readonly clippingPlanes: THREE.Plane[] = [],
  ) {
    this.textures = new TextureLibrary(onTextureLoad)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0005
    // The shadow camera only draws what rendered views draw.
    this.sun.shadow.camera.layers.set(RENDER_LAYER)
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 }))
    this.ground.receiveShadow = true
    for (const o of [this.sun, this.sun.target, this.sky, this.ground]) o.layers.set(RENDER_LAYER)
    this.group.add(this.sun, this.sun.target, this.sky, this.ground, this.meshes)
  }

  /** Builds the environment lighting once, with the renderer that will draw it. */
  prepare(renderer: THREE.WebGLRenderer): void {
    if (this.environment) return
    const pmrem = new THREE.PMREMGenerator(renderer)
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    for (const m of this.materials.values()) {
      m.envMap = this.environment
      m.needsUpdate = true
    }
  }

  clear(): void {
    for (const child of this.meshes.children) {
      ;(child as THREE.Mesh).geometry.dispose()
      if (child instanceof THREE.InstancedMesh) child.dispose()
    }
    this.meshes.clear()
  }

  /**
   * Adds a surface or mesh with its material; `selected` tints it. A texture is laid on at its real
   * size, for a model whose unit is `metersPerUnit` meters.
   */
  add(geometry: THREE.BufferGeometry, material: Material, selected: boolean, metersPerUnit: number): void {
    if (material.texture) addBoxUVs(geometry, material.texture.size / metersPerUnit, material.texture.rotation)
    const mesh = new THREE.Mesh(geometry, this.material(material, selected))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.layers.set(RENDER_LAYER)
    this.meshes.add(mesh)
  }

  /** Adds copies of an untextured surface or mesh (a block's), at the given matrices, as GPU instances. */
  addInstances(geometry: THREE.BufferGeometry, matrices: number[], material: Material, selected: boolean): void {
    const mesh = new THREE.InstancedMesh(geometry, this.material(material, selected), matrices.length / 16)
    mesh.instanceMatrix.array.set(matrices)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.layers.set(RENDER_LAYER)
    this.meshes.add(mesh)
  }

  private material(m: Material, selected: boolean): THREE.MeshPhysicalMaterial {
    const t = m.texture
    const key = `${m.color}:${m.roughness}:${m.metalness}:${m.transparency}:${selected}:${t ? `${t.kind}:${t.bump}:${t.image ?? ''}` : ''}`
    let material = this.materials.get(key)
    if (!material) {
      const glass = m.transparency > 0
      material = new THREE.MeshPhysicalMaterial({
        color: selected ? new THREE.Color(m.color).lerp(new THREE.Color('#ffee00'), 0.5) : m.color,
        roughness: m.roughness,
        metalness: m.metalness,
        // Clear materials let light through and bend it a little, as glass and water do.
        transmission: m.transparency,
        thickness: glass ? 0.5 : 0,
        ior: 1.5,
        transparent: glass,
        side: THREE.DoubleSide,
        envMap: this.environment,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        clippingPlanes: this.clippingPlanes,
        clipShadows: true,
      })
      if (t) {
        material.map = this.textures.get(t)
        // Light and dark of the pattern read as relief: mortar joints sink, grain catches the light.
        if (t.bump > 0) {
          material.bumpMap = material.map
          material.bumpScale = t.bump * 3
        }
      }
      this.materials.set(key, material)
    }
    return material
  }

  /** Places the sun and the ground for a model in `box`. */
  update(settings: RenderSettings, box: THREE.Box3): void {
    const size = box.isEmpty() ? 10 : Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3)
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
    const azimuth = (settings.sunAzimuth * Math.PI) / 180
    const altitude = (settings.sunAltitude * Math.PI) / 180
    // Azimuth is measured clockwise from north (+Y), as on a compass.
    const toSun = new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude))
    this.sun.position.copy(center).addScaledVector(toSun, size * 2)
    this.sun.target.position.copy(center)
    this.sun.intensity = settings.sunIntensity
    const shadow = this.sun.shadow.camera
    shadow.left = shadow.bottom = -size
    shadow.right = shadow.top = size
    shadow.near = size * 0.01
    shadow.far = size * 4
    shadow.updateProjectionMatrix()
    // Pushes shadow lookups off the surfaces, in proportion to the model, so faces do not shadow themselves.
    this.sun.shadow.normalBias = size * 0.002
    this.ground.visible = settings.groundShadows && !box.isEmpty()
    this.ground.position.set(center.x, center.y, box.isEmpty() ? 0 : box.min.z - size * 1e-4)
    this.ground.scale.set(size * 8, size * 8, 1)
  }
}
