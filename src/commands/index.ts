import { curveEditCommands } from './curveEdit'
import { drawCommands } from './draw'
import { editCommands } from './edit'
import { fileCommands } from './file'
import { solidCommands } from './solids'
import { transformCommands } from './transform'
import type { CommandRunner } from './runner'
import { viewCommands } from './view'

// Short aliases, following the conventions most NURBS modelers share.
const ALIASES: Record<string, string> = {
  M: 'Move',
  RO: 'Rotate',
  SC: 'Scale',
  MI: 'Mirror',
  AR: 'Array',
  AP: 'ArrayPolar',
  TR: 'Trim',
  J: 'Join',
  X: 'Explode',
  OF: 'Offset',
  F: 'Fillet',
  REC: 'Rectangle',
  A: 'Arc',
  EXT: 'ExtrudeCrv',
  REV: 'Revolve',
  BU: 'BooleanUnion',
  BD: 'BooleanDifference',
  BI: 'BooleanIntersection',
  FE: 'FilletEdge',
  U: 'Undo',
  S: 'Snap',
  O: 'Ortho',
  Z: 'Zoom',
  ZE: 'Zoom Extents',
  ZEA: 'Zoom All',
  ZS: 'Zoom Selected',
}

export function registerCommands(runner: CommandRunner): void {
  runner.register(...fileCommands, ...drawCommands, ...editCommands, ...transformCommands, ...curveEditCommands, ...solidCommands, ...viewCommands)
  for (const [alias, macro] of Object.entries(ALIASES)) runner.alias(alias, macro)
}
