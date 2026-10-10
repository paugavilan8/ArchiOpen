import { Vector3 } from 'three'
import * as R from 'replicad'
import { describe, expect, it } from 'vitest'
import { inArena, lastJobObjects } from './arena'
import { kernelJob } from './client'
import { kernelMemoryBytes, loadOC } from './loadKernel'
import { shapeRef } from './wire'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

describe('kernel memory', () => {
  it('knows how much memory the kernel holds', async () => {
    await loadOC()
    expect(kernelMemoryBytes()).toBeGreaterThan(50e6)
  }, 60_000)

  it('frees the kernel objects a job makes once it is done', async () => {
    await loadOC()
    const oc = R.getOC() as unknown as { gp_Pnt: new (x: number, y: number, z: number) => { isDeleted(): boolean; X(): number } }
    let kept: { isDeleted(): boolean } | null = null
    const x = await inArena(async () => {
      const p = new oc.gp_Pnt(1, 2, 3)
      kept = p
      return p.X()
    })
    expect(x).toBe(1)
    expect(kept!.isDeleted()).toBe(true)
    // Whole jobs too: a box made through replicad leaves nothing behind.
    await kernelJob('box', v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1))
    expect(lastJobObjects).toBeGreaterThan(10)
  }, 60_000)

  it('cuts sections over and over without losing memory', async () => {
    const box = await kernelJob('box', v(0, 0), v(10, 0), v(0, 10), v(0, 0, 10))
    const planes = [{ origin: v(5, 5, 5), normal: v(0, 0, 1) }]
    for (let i = 0; i < 50; i++) await kernelJob('sections', shapeRef(box), planes)
    const before = kernelMemoryBytes()
    // Each section used to lose some 160 KB for good: 1500 of them, about 240 MB.
    for (let i = 0; i < 1500; i++) await kernelJob('sections', shapeRef(box), planes)
    expect(kernelMemoryBytes() - before).toBeLessThan(40e6)
  }, 120_000)
})
