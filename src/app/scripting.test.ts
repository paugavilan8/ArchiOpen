import { describe, expect, it } from 'vitest'
import { compileScript, runScript, type ScriptApi } from './scripting'

const fakeApi = (log: string[]): ScriptApi =>
  ({
    log: (...v: unknown[]) => log.push(v.join(' ')),
    command: async (name: string, ...answers: unknown[]) => {
      log.push(`${name}(${answers.join(',')})`)
      if (name === 'Fail') throw new Error('Error in Fail: no')
      return [1]
    },
    v: (x: number, y: number, z = 0) => ({ x, y, z }),
  }) as unknown as ScriptApi

describe('scripts', () => {
  it('run as async functions with archi in scope, awaiting commands in order', async () => {
    const log: string[] = []
    await runScript("const ids = await archi.command('Wall', '0,0', '10,0', '')\narchi.log('made', ids.length)\nfor (const n of [1, 2]) await archi.command('Column', `${n},0`)", fakeApi(log))
    expect(log).toEqual(['Wall(0,0,10,0,)', 'made 1', 'Column(1,0)', 'Column(2,0)'])
  })

  it('report errors with the line of the script they happen on', async () => {
    const log: string[] = []
    await expect(runScript("archi.log('one')\n\nawait archi.command('Fail')", fakeApi(log))).rejects.toThrow(/Error in Fail: no/)
    await expect(runScript('const a = 1\nundefinedThing.go()', fakeApi(log))).rejects.toThrow(/line 2/)
    expect(() => compileScript('let = ;')).toThrow()
  })
})
