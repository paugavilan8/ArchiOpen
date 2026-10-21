import { describe, expect, it } from 'vitest'
import server from '../../mcp/server.mjs?raw'

/**
 * What scripts, macros and the AI assistant rely on, as it was at 1.0: command names, aliases,
 * the script API and the assistant's tools. Things can be added; nothing here may go away or be
 * renamed (that would break someone's scripts), so a failure here means putting it back.
 */

const COMMANDS = [
  'AddToGroup', 'Align', 'Angle', 'Arc', 'Area', 'Array', 'ArrayCrv', 'ArrayPolar', 'Autosave',
  'Bend', 'BlendCrv', 'BlendSrf', 'Block', 'BlockEdit', 'BlockEditCancel', 'BlockEditFinish',
  'BooleanDifference', 'BooleanIntersection', 'BooleanUnion', 'BoundingBox', 'Box', 'CageEdit',
  'Cap', 'Chamfer', 'ChamferEdge', 'Check', 'CheckForUpdates', 'Circle', 'ClippingPlane', 'Column',
  'Cone', 'Contour', 'Copy', 'CopyToClipboard', 'CPlane', 'CurtainWall', 'CurvatureGraphOff',
  'CurvatureGraphOn', 'Curve', 'CurveBoolean', 'Cut', 'Cylinder', 'Delete', 'Dim', 'DimAligned',
  'DimAngle', 'DimDiameter', 'DimRadius', 'DisableClippingPlanes', 'Distance', 'Distribute',
  'Divide', 'Door', 'DraftAngleAnalysis', 'DraftAngleAnalysisOff', 'DrawingSet', 'DupBorder',
  'DupEdge', 'EdgeSrf', 'EditLink', 'Elevations', 'Ellipse', 'EnableClippingPlanes', 'Example',
  'Explode', 'Export', 'ExportDXF', 'ExportGLTF', 'ExportIFC', 'ExportOBJ', 'ExportPDF',
  'ExportQuantities', 'ExportSTEP', 'ExportSTL', 'Extend', 'ExtendSrf', 'ExtractSrf', 'ExtrudeCrv',
  'ExtrudeSrf', 'Fillet', 'FilletCorners', 'FilletEdge', 'FilletSrf', 'FillMeshHoles', 'Flip',
  'Floor', 'Flow', 'Furniture', 'Group', 'Hatch', 'Helix', 'Hide', 'HideSwap', 'History',
  'HistoryPurge', 'Import', 'ImportSTEP', 'Insert', 'InterpCrv', 'Intersect', 'Invert', 'Isolate',
  'Join', 'Language', 'Layout', 'Leader', 'Length', 'Level', 'Line', 'Link', 'Lock', 'Loft',
  'Make2D', 'MatchSrf', 'MaxViewport', 'McpConnect', 'Mesh', 'MeshBox', 'MeshCylinder',
  'MeshPlane', 'MeshSphere', 'MeshToNURB', 'Mirror', 'ModelView', 'Move', 'NamedCPlane',
  'NamedView', 'NetworkSrf', 'New', 'NewFromTemplate', 'Offset', 'OffsetSrf', 'Open', 'Orient',
  'Orient3Pt', 'Ortho', 'Osnap', 'Parametric', 'Paste', 'Patch', 'Pipe', 'PlanarSrf', 'Point',
  'Points', 'PointsOff', 'PointsOn', 'Polygon', 'Polyline', 'Project', 'ProjectFolder',
  'ProjectToCPlane', 'Pull', 'Purge', 'Pyramid', 'Radius', 'Railing', 'RailRevolve', 'Rebuild',
  'Rectangle', 'Redo', 'RemoveFromGroup', 'Render', 'ReturnToHost', 'Revolve', 'Roof', 'Room',
  'Rotate', 'RunScript', 'Save', 'SaveAs', 'SaveAsTemplate', 'Scale', 'Scale1D', 'Scale2D',
  'Schedule', 'Section', 'SelAll', 'SelAnnotation', 'SelBadObjects', 'SelBlockInstance',
  'SelChildren', 'SelClosedPolysrf', 'SelCrv', 'SelDim', 'SelDup', 'SelHatch', 'SelLast',
  'SelLayer', 'SelMesh', 'SelNone', 'SelOpenPolysrf', 'SelParents', 'SelPolysrf', 'SelPrev',
  'SelPt', 'SelSrf', 'SelText', 'SetDisplayMode', 'SetObjectMaterial', 'Shell', 'Show',
  'ShowEdges', 'Skirting', 'Slab', 'Snap', 'Sphere', 'Split', 'SrfPt', 'Stair', 'StairOpening',
  'Sun', 'Sweep1', 'Sweep2', 'Tags', 'Taper', 'TCone', 'Terrain', 'Text', 'Torus', 'Trim', 'Twist',
  'Undo', 'Ungroup', 'UnifyMeshNormals', 'Unisolate', 'Units', 'Unlink', 'Unlock', 'UnrollSrf',
  'Untrim', 'Unweld', 'UpdateDrawings', 'UpdateLinks', 'ViewCaptureToFile', 'Volume', 'Wall',
  'WallDimensions', 'WallType', 'Weld', 'What', 'Window', 'Zebra', 'ZebraOff', 'Zoom',
]

const ALIASES = [
  'a', 'ap', 'ar', 'b', 'bd', 'bi', 'bu', 'cha', 'el', 'ex', 'ext', 'f', 'fe', 'g', 'h', 'i', 'j',
  'm', 'mi', 'o', 'of', 'pol', 'print', 'rec', 'rev', 'ro', 's', 'sc', 'sw', 'tr', 'u', 'ug', 'x',
  'z', 'ze', 'zea', 'zs',
]

const SCRIPT_API = ['add', 'apiVersion', 'command', 'doc', 'levels', 'log', 'objects', 'param', 'remove', 'select', 'setLevel', 'setParams', 'step', 'v']

const ASSISTANT_TOOLS = ['get_model', 'list_commands', 'list_objects', 'run_command', 'run_script', 'view', 'export', 'open_model', 'new_model', 'set_params', 'delete_objects', 'undo']

const noop = () => {}

/** The commands and aliases as the app registers them (with just enough of a browser to load). */
async function registry() {
  Object.assign(globalThis, { window: { addEventListener: noop }, document: { addEventListener: noop } })
  const { CommandRunner } = await import('../commands/runner')
  const { registerCommands } = await import('../commands/index')
  const runner = new CommandRunner({ input: {} } as never)
  registerCommands(runner)
  return runner
}

describe('stable API', () => {
  it('keeps every command and alias', async () => {
    const runner = await registry()
    const names = new Set(runner.names)
    expect(COMMANDS.filter((name) => !names.has(name))).toEqual([])
    expect(ALIASES.filter((alias) => runner.resolve(alias) === null)).toEqual([])
  })

  it('keeps the script API', async () => {
    const { scriptApi, SCRIPT_API_VERSION } = await import('./scripting')
    const api = scriptApi({ doc: {}, log: noop } as never, {} as never)
    expect(SCRIPT_API.filter((key) => !(key in api))).toEqual([])
    expect(api.apiVersion).toBe(SCRIPT_API_VERSION)
    expect(SCRIPT_API_VERSION).toBeGreaterThanOrEqual(1)
  })

  it("keeps the assistant's tools, in the server and in the app", async () => {
    const served = [...server.matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((m) => m[1])
    expect(ASSISTANT_TOOLS.filter((tool) => !served.includes(tool))).toEqual([])
    const { toolHandlers } = await import('./assistantBridge')
    const handlers = toolHandlers({ doc: {}, log: noop } as never, {} as never, null)
    expect(served.filter((tool) => !(tool in handlers))).toEqual([])
  })
})
