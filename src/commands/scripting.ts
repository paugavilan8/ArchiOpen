import { runScript, scriptApi, scriptHost } from '../app/scripting'
import { ParametricSession } from '../app/parametric'
import { showParametricPanel } from '../ui/parametricPanel'
import type { Command } from './runner'

/**
 * RunScript: runs a JavaScript file that drives the modeler through the `archi` API (see the
 * README), once the command itself has ended, so the script can run commands. `Last` runs the last
 * script again.
 */

const memory: { last: { name: string; text: string } | null } = { last: null }

const runScriptCommand: Command = {
  name: 'RunScript',
  history: false,
  repeat: false,
  async run({ input, files, log }) {
    const host = scriptHost()
    if (!host) throw new Error('Scripts cannot run here')
    let script = memory.last
    if (script) {
      const option = await input.getOption(`Script to run <${script.name}>`, ['File', 'Last'])
      if (option !== null && option.toLowerCase().startsWith('file')) script = null
    }
    script ??= await files.pickScript()
    if (!script) return
    memory.last = script
    const { name, text } = script
    // After this command ends, so that the script can run commands of its own.
    setTimeout(async () => {
      log(`Running ${name}…`)
      const started = performance.now()
      try {
        await runScript(text, scriptApi(host.ctx, host.runner))
        log(`${name} finished in ${((performance.now() - started) / 1000).toFixed(1)} s`)
      } catch (error) {
        log(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  },
}

/**
 * Parametric: runs a script whose parameters (archi.param) get sliders; moving one makes what the
 * script made again with the new value. Bake keeps the result, Discard takes it away.
 */
const parametric: Command = {
  name: 'Parametric',
  history: false,
  repeat: false,
  async run({ input, files, log }) {
    const host = scriptHost()
    if (!host) throw new Error('Scripts cannot run here')
    let script = memory.last
    if (script) {
      const option = await input.getOption(`Parametric script <${script.name}>`, ['File', 'Last'])
      if (option !== null && option.toLowerCase().startsWith('file')) script = null
    }
    script ??= await files.pickScript()
    if (!script) return
    memory.last = script
    const session = new ParametricSession(script.name, script.text, host.ctx, host.runner)
    setTimeout(async () => {
      log(`Running ${script.name} with its parameters as sliders. Bake keeps what it makes`)
      showParametricPanel(session)
      await session.run()
      if (session.defs.length === 0) log(`${script.name} has no parameters: use archi.param(name, value, { min, max }) for sliders`)
    })
  },
}

export const scriptingCommands: Command[] = [runScriptCommand, parametric]
