import * as THREE from 'three'
import type { MaterialTexture, TextureKind } from '../core/materials'

/**
 * Textures for rendered views: patterns drawn here (wood, brick, tiles, concrete, marble) and pictures
 * from files, laid on surfaces by box mapping at their real size.
 */

const SIZE = 512

/** Smooth noise in 0..1, repeating every `period` cells, so patterns tile without seams. */
function noise(seed: number, period: number) {
  const hash = (x: number, y: number) => {
    const h = Math.sin((((x % period) + period) % period) * 127.1 + (((y % period) + period) % period) * 311.7 + seed * 74.7) * 43758.5453
    return h - Math.floor(h)
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)
  return (x: number, y: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = smooth(x - x0)
    const fy = smooth(y - y0)
    const top = hash(x0, y0) * (1 - fx) + hash(x0 + 1, y0) * fx
    const bottom = hash(x0, y0 + 1) * (1 - fx) + hash(x0 + 1, y0 + 1) * fx
    return top * (1 - fy) + bottom * fy
  }
}

/** Several octaves of noise, 0..1, repeating over the tile (`cells` across at the coarsest). */
function fractal(seed: number, cells: number, octaves = 4) {
  const layers = Array.from({ length: octaves }, (_, i) => ({ n: noise(seed + i, cells << i), scale: cells << i, weight: 1 / (1 << i) }))
  const total = layers.reduce((s, l) => s + l.weight, 0)
  return (u: number, v: number) => layers.reduce((s, l) => s + l.n(u * l.scale, v * l.scale) * l.weight, 0) / total
}

type Rgb = [number, number, number]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Fills the canvas pixel by pixel from a color function of (u, v) in 0..1. */
function paint(color: (u: number, v: number) => Rgb): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(SIZE, SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = color(x / SIZE, y / SIZE)
      const o = 4 * (y * SIZE + x)
      image.data[o] = r
      image.data[o + 1] = g
      image.data[o + 2] = b
      image.data[o + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

const PATTERNS: Record<Exclude<TextureKind, 'Image'>, () => HTMLCanvasElement> = {
  // Planks running along u, with grain lines bent by noise.
  Wood: () => {
    const bend = fractal(1, 2)
    const fine = fractal(2, 16, 2)
    return paint((u, v) => {
      const plank = Math.floor(v * 4)
      const grain = Math.sin((v * 4 - plank) * 40 + bend(u, v) * 18 + plank * 7) * 0.5 + 0.5
      const tone = 0.55 + 0.25 * grain + 0.2 * fine(u, v) - (plank % 2) * 0.06
      const seam = Math.abs((v * 4) % 1) < 0.012 ? 0.55 : 1
      return mix([112, 66, 34], [196, 142, 88], tone).map((c) => c * seam) as Rgb
    })
  },
  // Running bond: six courses, two bricks each, mortar between.
  Brick: () => {
    const grit = fractal(3, 32, 3)
    return paint((u, v) => {
      const course = Math.floor(v * 6)
      const along = u * 2 + (course % 2) * 0.5
      const brick = Math.floor(along)
      const inCourse = v * 6 - course
      const inBrick = along - brick
      const mortar = inCourse < 0.1 || inBrick < 0.04
      if (mortar) return mix([170, 165, 155], [205, 200, 190], grit(u, v))
      const shade = noise(4, 64)(brick * 7.3 + course * 3.1, course * 5.7) * 0.35
      return mix([128, 52, 34], [176, 82, 52], shade + 0.65 * grit(u, v))
    })
  },
  // Square glazed tiles, four by four, with grout.
  Tiles: () => {
    const grit = fractal(5, 32, 2)
    return paint((u, v) => {
      const fu = (u * 4) % 1
      const fv = (v * 4) % 1
      if (fu < 0.03 || fv < 0.03) return mix([150, 150, 145], [175, 175, 170], grit(u, v))
      const tile = noise(6, 64)(Math.floor(u * 4) * 3.1, Math.floor(v * 4) * 5.3) * 0.08
      return mix([226, 228, 230], [245, 246, 247], grit(u, v) * 0.5 + tile)
    })
  },
  // Cast concrete: soft blotches and fine grit.
  Concrete: () => {
    const blotch = fractal(7, 3)
    const grit = fractal(8, 64, 2)
    return paint((u, v) => {
      const t = 0.6 * blotch(u, v) + 0.4 * grit(u, v)
      const pore = noise(9, 256)(u * 256, v * 256) > 0.93 ? 0.8 : 1
      return mix([138, 136, 130], [190, 187, 180], t).map((c) => c * pore) as Rgb
    })
  },
  // White stone with grey veins.
  Marble: () => {
    const warp = fractal(10, 2)
    const cloud = fractal(11, 4)
    const fine = fractal(12, 8)
    return paint((u, v) => {
      // Thin dark veins along a warped diagonal, and fainter hairlines across them.
      const vein = Math.pow(1 - Math.abs(Math.sin((u + v) * Math.PI * 2 + warp(u, v) * 5)), 40)
      const hair = Math.pow(1 - Math.abs(Math.sin((u - v) * Math.PI * 4 + fine(u, v) * 8)), 60) * 0.5
      return mix(mix([238, 237, 234], [218, 218, 216], cloud(u, v)), [120, 122, 128], Math.min(1, vein + hair))
    })
  },
}

/** Textures by pattern or picture, made once each. */
export class TextureLibrary {
  private readonly textures = new Map<string, THREE.Texture>()

  constructor(private readonly onLoad: () => void) {}

  get(t: MaterialTexture): THREE.Texture {
    const key = t.kind === 'Image' ? t.image! : t.kind
    let texture = this.textures.get(key)
    if (!texture) {
      if (t.kind === 'Image') {
        const image = new Image()
        texture = new THREE.Texture(image)
        image.onload = () => {
          texture!.needsUpdate = true
          this.onLoad()
        }
        image.src = t.image!
      } else {
        texture = new THREE.CanvasTexture(PATTERNS[t.kind]())
      }
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 8
      this.textures.set(key, texture)
    }
    return texture
  }
}

/** A small picture of a pattern, for the materials panel. */
export function patternPreview(kind: Exclude<TextureKind, 'Image'>): string {
  return PATTERNS[kind]().toDataURL('image/jpeg', 0.7)
}

/**
 * Texture coordinates by box mapping: each vertex takes the two world axes across its normal's main
 * axis, in repeats of the texture's size (`unitSize` is the texture's size in model units).
 */
export function addBoxUVs(geometry: THREE.BufferGeometry, unitSize: number, rotation: number): void {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  if (!position || !normal) return
  const uv = new Float32Array(position.count * 2)
  const cos = Math.cos((rotation * Math.PI) / 180)
  const sin = Math.sin((rotation * Math.PI) / 180)
  for (let i = 0; i < position.count; i++) {
    const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)]
    const [ax, ay, az] = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))]
    // Walls read their pattern upright: across along the wall, up along z.
    const [a, b] = az >= ax && az >= ay ? [x, y] : ax >= ay ? [y, z] : [x, z]
    const u = a / unitSize
    const v = b / unitSize
    uv[2 * i] = u * cos - v * sin
    uv[2 * i + 1] = u * sin + v * cos
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}
