import { annotationCommands } from './annotate'
import { curveEditCommands } from './curveEdit'
import { drawCommands } from './draw'
import { drawingCommands } from './drawing'
import { editCommands } from './edit'
import { fileCommands } from './file'
import { hatchCommands } from './hatch'
import { plotCommands } from './plot'
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
  SW: 'Sweep1',
  H: 'Hatch',
  PRINT: 'ExportPDF',
  U: 'Undo',
  S: 'Snap',
  O: 'Ortho',
  Z: 'Zoom',
  ZE: 'Zoom Extents',
  ZEA: 'Zoom All',
  ZS: 'Zoom Selected',
}

export function registerCommands(runner: CommandRunner): void {
  runner.register(...fileCommands, ...drawCommands, ...editCommands, ...transformCommands, ...curveEditCommands, ...solidCommands, ...drawingCommands, ...annotationCommands, ...hatchCommands, ...plotCommands, ...viewCommands)
  for (const [alias, macro] of Object.entries(ALIASES)) runner.alias(alias, macro)
}
