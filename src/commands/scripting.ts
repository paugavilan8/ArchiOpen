import { runScript, scriptApi, scriptHost } from '../app/scripting'
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

export const scriptingCommands: Command[] = [runScriptCommand]
