import { describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import type { CommandContext, CommandRunner } from '../commands/runner'
import { ParametricSession } from './parametric'
import { paramDef } from './scripting'

/** A runner whose Point command adds a point object as one undo step. */
function setup() {
  const doc = new Document()
  const log: string[] = []
  const ctx = { doc, log: (t: string) => log.push(t) } as unknown as CommandContext
  const runner = {
    runWith: async (name: string, answers: string[]) => {
      doc.begin()
      const [x, y] = answers[0].split(',').map(Number)
      doc.add({ type: 'point', point: { x, y, z: 0, clone() { return this } } } as never)
      doc.commit()
    },
  } as unknown as CommandRunner
  return { doc, ctx, runner, log }
}

const SCRIPT = "const n = archi.param('Count', 3, { min: 1, max: 10 })\nfor (let i = 0; i < n; i++) await archi.command('Point', `${i},0`)"

describe('parametric scripts', () => {
  it('give each parameter a range from what the script asks', () => {
    expect(paramDef('Count', 3, { min: 1, max: 10 })).toEqual({ name: 'Count', value: 3, min: 1, max: 10, step: 1 })
    expect(paramDef('Height', 2.5)).toEqual({ name: 'Height', value: 2.5, min: 0, max: 5, step: 0.05 })
    expect(paramDef('Over', 50, { max: 10 }).value).toBe(10)
  })

  it('make their output again for each new value, each time as one undo step', async () => {
    const { doc, ctx, runner } = setup()
    const session = new ParametricSession('points.js', SCRIPT, ctx, runner)
    await session.run()
    expect(session.defs.map((d) => d.name)).toEqual(['Count'])
    expect(session.output).toHaveLength(3)
    expect(doc.objects.size).toBe(3)
    await session.set('Count', 7)
    expect(doc.objects.size).toBe(7)
    await session.set('Count', 2)
    expect(doc.objects.size).toBe(2)
    // Values outside the range are kept within it.
    await session.set('Count', 50)
    expect(doc.objects.size).toBe(10)
    // Undo goes back one value at a time.
    doc.undo()
    expect(doc.objects.size).toBe(2)
    doc.undo()
    expect(doc.objects.size).toBe(7)
  })

  it('bake to keep the output, or discard it', async () => {
    const { doc, ctx, runner } = setup()
    const kept = new ParametricSession('points.js', SCRIPT, ctx, runner)
    await kept.run()
    expect(kept.bake()).toHaveLength(3)
    await kept.set('Count', 5)
    expect(doc.objects.size).toBe(3)
    const dropped = new ParametricSession('points.js', SCRIPT, ctx, runner)
    await dropped.run()
    expect(doc.objects.size).toBe(6)
    dropped.discard()
    expect(doc.objects.size).toBe(3)
  })

  it('report errors and keep going', async () => {
    const { ctx, runner, log } = setup()
    const session = new ParametricSession('bad.js', "archi.param('A', 1)\nthrow new Error('nope')", ctx, runner)
    await session.run()
    expect(session.error).toMatch(/nope/)
    expect(session.defs).toHaveLength(1)
    expect(log.some((l) => l.includes('nope'))).toBe(true)
  })
})
