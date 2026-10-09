import { annotationCommands } from './annotate'
import { blockCommands } from './blocks'
import { curveEditCommands } from './curveEdit'
import { drawCommands } from './draw'
import { curveCommands } from './drawCurves'
import { drawingCommands } from './drawing'
import { editCommands } from './edit'
import { fileCommands } from './file'
import { hatchCommands } from './hatch'
import { layoutCommands } from './layouts'
import { organizeCommands } from './organize'
import { plotCommands } from './plot'
import { solidCommands } from './solids'
import { surfaceCommands } from './surfaces'
import { transformCommands } from './transform'
import type { CommandRunner } from './runner'
import { viewCommands } from './view'
import { viewSetupCommands } from './viewSetup'
import { meshCommands } from './meshes'
import { analyzeCommands } from './analyze'
import { analysisDisplayCommands } from './analysisDisplay'

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
  EL: 'Ellipse',
  POL: 'Polygon',
  CHA: 'Chamfer',
  EX: 'Extend',
  A: 'Arc',
  EXT: 'ExtrudeCrv',
  REV: 'Revolve',
  BU: 'BooleanUnion',
  BD: 'BooleanDifference',
  BI: 'BooleanIntersection',
  FE: 'FilletEdge',
  SW: 'Sweep1',
  H: 'Hatch',
  B: 'Block',
  I: 'Insert',
  G: 'Group',
  UG: 'Ungroup',
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
  runner.register(...fileCommands, ...drawCommands, ...curveCommands, ...editCommands, ...transformCommands, ...curveEditCommands, ...solidCommands, ...surfaceCommands, ...drawingCommands, ...annotationCommands, ...hatchCommands, ...plotCommands, ...blockCommands, ...layoutCommands, ...organizeCommands, ...viewSetupCommands, ...meshCommands, ...analyzeCommands, ...analysisDisplayCommands, ...viewCommands)
  for (const [alias, macro] of Object.entries(ALIASES)) runner.alias(alias, macro)
}
