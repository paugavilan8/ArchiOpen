import { drawCommands } from './draw'
import { editCommands } from './edit'
import type { CommandRunner } from './runner'
import { viewCommands } from './view'

// Short aliases, following the conventions most NURBS modelers share.
const ALIASES: Record<string, string> = {
  M: 'Move',
  U: 'Undo',
  S: 'Snap',
  O: 'Ortho',
  Z: 'Zoom',
  ZE: 'Zoom Extents',
  ZEA: 'Zoom All',
  ZS: 'Zoom Selected',
}

export function registerCommands(runner: CommandRunner): void {
  runner.register(...drawCommands, ...editCommands, ...viewCommands)
  for (const [alias, macro] of Object.entries(ALIASES)) runner.alias(alias, macro)
}
