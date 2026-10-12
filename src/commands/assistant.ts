import { assistantBridge } from '../app/assistantBridge'
import { isOption, valueOption } from './helpers'
import type { Command } from './runner'

/**
 * McpConnect: lets an AI assistant (Claude, or another MCP client) work in this model through the
 * ArchiOpen MCP server (see mcp/README.md). Connect waits for the server on this computer and stays
 * on (also after restarting the app) until Disconnect.
 */
const mcpConnect: Command = {
  name: 'McpConnect',
  history: false,
  repeat: false,
  async run({ input, log }) {
    const bridge = assistantBridge()
    if (!bridge) throw new Error('The assistant connection is not available here')
    const state = { off: 'off', waiting: 'waiting for the MCP server', connected: 'connected' }[bridge.state]
    const option = await input.getOption(`AI assistant: ${state}`, [bridge.state === 'off' ? 'Connect' : 'Disconnect', valueOption('Port', bridge.port)])
    if (option === null) return
    if (isOption(option, 'Port')) {
      const port = await input.getNumber('Port of the MCP server (on this computer)', bridge.port)
      if (typeof port === 'number' && Number.isInteger(port) && port > 1023 && port < 65536) bridge.enable(port)
      else log('The port must be a whole number from 1024 to 65535')
    } else if (isOption(option, 'Connect')) {
      bridge.enable()
      log(`Waiting for the ArchiOpen MCP server on port ${bridge.port}. Add it to Claude (see mcp/README.md); the app connects as soon as it runs`)
    } else {
      bridge.disable()
      log('AI assistant connection off')
    }
  },
}

export const assistantCommands: Command[] = [mcpConnect]
