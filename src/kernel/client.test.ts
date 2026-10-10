import { Box3, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { AnyCurve } from '../core/geometry'
import { kernelBusy, kernelJob, KernelFailure, onKernelBusy } from './client'
import { decode, encode, shapeRef } from './wire'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('kernel jobs', () => {
  it('carries vectors and boxes across as Three.js objects', () => {
    const value = { at: v(1, 2, 3), list: [v(4, 5, 6)], box: new Box3(v(0, 0, 0), v(1, 1, 1)), numbers: [1, 2, 3], bytes: new Uint8Array([7]) }
    const copy = decode(structuredClone(encode(value))) as typeof value
    expect(copy.at).toBeInstanceOf(Vector3)
    expect(copy.at.toArray()).toEqual([1, 2, 3])
    expect(copy.list[0].toArray()).toEqual([4, 5, 6])
    expect(copy.box).toBeInstanceOf(Box3)
    expect(copy.box.max.toArray()).toEqual([1, 1, 1])
    expect(copy.numbers).toEqual([1, 2, 3])
    expect([...copy.bytes]).toEqual([7])
  })

  it('makes solids from document geometry and works on them by reference', async () => {
    const busy: boolean[] = []
    const stop = onKernelBusy((b) => busy.push(b))
    const solid = await kernelJob('box', v(0, 0), v(2, 0), v(0, 3), v(0, 0, 4))
    expect(solid.type).toBe('brep')
    expect(solid.kind).toBe('solid')
    expect(busy).toEqual([true, false])
    expect(kernelBusy()).toBe(false)
    stop()
    const volume = await kernelJob('shapeVolume', shapeRef(solid))
    expect(volume.value).toBeCloseTo(24, 6)
    expect(volume.centroid).toBeInstanceOf(Vector3)
    expect(volume.centroid.toArray().map((x) => +x.toFixed(6))).toEqual([1, 1.5, 2])
    const bounds = await kernelJob('shapeBounds', shapeRef(solid))
    expect(
      bounds
        .getSize(new Vector3())
        .toArray()
        .map((x) => +x.toFixed(6)),
    ).toEqual([2, 3, 4])
    // Several shapes back at once, each as geometry.
    const faces = await kernelJob('explodeShape', shapeRef(solid))
    expect(faces).toHaveLength(6)
    expect(faces.every((f) => f.type === 'brep' && f.kind === 'surface')).toBe(true)
  }, 60_000)

  it('tells our own errors from kernel failures', async () => {
    // Ours: an Error that says what is wrong.
    await expect(kernelJob('rebuild', 'NoSuchCommand', [], {})).rejects.toThrow('No history for NoSuchCommand')
    // The kernel's: a failure the command turns into "Could not …".
    const open: AnyCurve = { type: 'polyline', points: [v(0, 0), v(1, 0)], closed: false }
    const failure = await kernelJob('loftCurves', [open]).catch((e) => e)
    expect(failure).toBeInstanceOf(KernelFailure)
    expect(failure).not.toBeInstanceOf(Error)
  }, 60_000)
})
