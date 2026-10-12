import { describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import type { CommandContext, CommandRunner } from '../commands/runner'
import { toolHandlers } from './assistantBridge'

/** The app's parts the tools need, with a runner that logs what it runs. */
function setup() {
  const doc = new Document()
  const history: string[] = []
  const ran: string[] = []
  const ctx = { doc, log: (t: string) => history.push(t) } as unknown as CommandContext
  const runner = {
    names: ['Box', 'Wall', 'WallType'],
    runWith: async (name: string, answers: string[]) => {
      ran.push(`${name} ${answers.join(' ')}`.trim())
      if (name === 'Fail') throw new Error('Error in Fail: no')
      ctx.log(`Command: ${name}`)
      const id = doc.add({ type: 'point', point: { x: 1, y: 2, z: 3 } } as never).id
      doc.select([id])
    },
  } as unknown as CommandRunner
  return { doc, ctx, history, ran, tools: toolHandlers(ctx, runner, null) }
}

describe('assistant tools', () => {
  it('run commands with their answers, answering with what they wrote and selected', async () => {
    const { ctx, history, ran, tools, doc } = setup()
    const before = ctx.log
    const result = await tools.run_command({ name: 'Wall', answers: ['0,0', '10,0', ''] })
    expect(ran).toEqual(['Wall 0,0 10,0'])
    expect(result).toEqual({ log: ['Command: Wall'], selected: [...doc.selection], objects: 1 })
    // The app's history got the lines too, and logging is as it was.
    expect(history).toEqual(['Command: Wall'])
    expect(ctx.log).toBe(before)
    await expect(tools.run_command({ name: 'Fail' })).rejects.toThrow('Error in Fail: no')
    expect(ctx.log).toBe(before)
  })

  it('describe the model, its commands and objects', async () => {
    const { tools } = setup()
    await tools.run_command({ name: 'Point' })
    const model = (await tools.get_model()) as { units: string; objects: Record<string, number>; levels: unknown[] }
    expect(model.units).toBe('Millimeters')
    expect(model.objects).toEqual({ point: 1 })
    expect(model.levels).toHaveLength(1)
    expect(await tools.list_commands({ filter: 'wall' })).toEqual(['Wall', 'WallType'])
    expect(await tools.list_objects({ type: 'point' })).toEqual([{ id: 1, type: 'point', layer: 'Default' }])
    expect(await tools.list_objects({ type: 'brep' })).toEqual([])
  })

  it('run scripts through the same runner', async () => {
    const { tools, ran } = setup()
    const result = (await tools.run_script({ code: "await archi.command('Box', '0,0', '1,1')\narchi.log('done')" })) as { log: string[] }
    expect(ran).toEqual(['Box 0,0 1,1'])
    expect(result.log).toEqual(['Command: Box', 'done'])
  })

  it('change parameters through construction history, delete, and keep unsaved work', async () => {
    const { doc, ctx, tools } = setup()
    const remade: unknown[] = []
    ;(ctx as { history?: unknown }).history = { remakeStep: async (id: number, record: unknown) => remade.push([id, record]) }
    ;(ctx as { files?: unknown }).files = { restore: () => {}, archiData: () => new TextEncoder().encode('{}') }
    const id = doc.add({ type: 'point', point: { x: 0, y: 0, z: 0 } } as never).id
    doc.setHistory(id, { command: 'Wall', inputs: [], params: { thickness: 200, height: 3000 } })
    await tools.set_params({ id, params: { thickness: 300 } })
    expect(remade).toEqual([[id, { command: 'Wall', inputs: [], params: { thickness: 300, height: 3000 } }]])
    await expect(tools.set_params({ id: 999, params: {} })).rejects.toThrow(/no parameters/)
    // Unsaved changes are kept unless the assistant says to drop them.
    doc.modified = true
    await expect(tools.new_model({})).rejects.toThrow(/unsaved changes/)
    expect(await tools.delete_objects({ ids: [id, 12345] })).toEqual({ deleted: [id], objects: 0 })
    await expect(tools.delete_objects({ ids: [12345] })).rejects.toThrow()
    expect(await tools.new_model({ discard_changes: true })).toEqual({ objects: 0 })
    // Exports the model itself; unknown formats are refused.
    expect(((await tools.export({ format: 'archi' })) as { data: string }).data).toBe(btoa('{}'))
    await expect(tools.export({ format: 'dwg' })).rejects.toThrow(/format/)
  })
})
