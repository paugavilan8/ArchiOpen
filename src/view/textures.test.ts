import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { addBoxUVs } from './textures'

describe('box mapping', () => {
  it('lays textures at their real size, walls upright', () => {
    // One vertex on a floor, one on a wall facing +y, one on a wall facing +x.
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([3, 4, 0, 3, 0, 2, 0, 4, 2], 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 0, 1, 0, 0], 3))
    // A 0.5 m pattern in a model in millimeters: 500 units per repeat.
    addBoxUVs(g, 500, 0)
    const uv = g.getAttribute('uv')
    const at = (i: number) => [uv.getX(i) * 500, uv.getY(i) * 500].map((x) => +x.toFixed(4))
    expect(at(0)).toEqual([3, 4])
    expect(at(1)).toEqual([3, 2])
    expect(at(2)).toEqual([4, 2])
    // Turned a quarter: u becomes -v.
    addBoxUVs(g, 1, 90)
    expect(g.getAttribute('uv').getX(0)).toBeCloseTo(-4, 9)
    expect(g.getAttribute('uv').getY(0)).toBeCloseTo(3, 9)
  })
})
