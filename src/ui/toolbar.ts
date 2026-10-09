import type { CommandRunner } from '../commands/runner'
import { iconButton, IconName } from './icons'

interface Tool {
  macro: string
  tip: string
  icon: IconName
}

/** Modeling tools, in the vertical toolbar on the left. */
const SIDE_TOOLS: Tool[][] = [
  [
    { macro: 'Line', tip: 'Line', icon: 'line' },
    { macro: 'Polyline', tip: 'Polyline', icon: 'polyline' },
    { macro: 'Rectangle', tip: 'Rectangle  (REC)', icon: 'rectangle' },
    { macro: 'Circle', tip: 'Circle', icon: 'circle' },
    { macro: 'Arc', tip: 'Arc: center, start, end  (A)', icon: 'arc' },
    { macro: 'Curve', tip: 'Control point curve', icon: 'curve' },
  ],
  [
    { macro: 'Move', tip: 'Move  (M)', icon: 'move' },
    { macro: 'Copy', tip: 'Copy', icon: 'copy' },
    { macro: 'Rotate', tip: 'Rotate  (RO)', icon: 'rotate' },
    { macro: 'Scale', tip: 'Scale  (SC)', icon: 'scale' },
    { macro: 'Mirror', tip: 'Mirror  (MI)', icon: 'mirror' },
    { macro: 'Array', tip: 'Rectangular array  (AR)', icon: 'array' },
    { macro: 'ArrayPolar', tip: 'Polar array  (AP)', icon: 'arrayPolar' },
  ],
  [
    { macro: 'Trim', tip: 'Trim  (TR)', icon: 'trim' },
    { macro: 'Split', tip: 'Split', icon: 'split' },
    { macro: 'Join', tip: 'Join  (J)', icon: 'join' },
    { macro: 'Explode', tip: 'Explode  (X)', icon: 'explode' },
    { macro: 'Offset', tip: 'Offset  (OF)', icon: 'offset' },
    { macro: 'Fillet', tip: 'Fillet two lines  (F)', icon: 'fillet' },
    { macro: 'FilletCorners', tip: 'Fillet the corners of polylines', icon: 'filletCorners' },
    { macro: 'Delete', tip: 'Delete  (Del)', icon: 'delete' },
  ],
  [
    { macro: 'Box', tip: 'Box', icon: 'box' },
    { macro: 'Cylinder', tip: 'Cylinder', icon: 'cylinder' },
    { macro: 'Sphere', tip: 'Sphere', icon: 'sphere' },
    { macro: 'ExtrudeCrv', tip: 'Extrude curve  (EXT)', icon: 'extrude' },
    { macro: 'Revolve', tip: 'Revolve  (REV)', icon: 'revolve' },
    { macro: 'Loft', tip: 'Loft', icon: 'loft' },
    { macro: 'PlanarSrf', tip: 'Planar surface from closed curves', icon: 'planarSrf' },
    { macro: 'Sweep1', tip: 'Sweep along one rail', icon: 'sweep' },
    { macro: 'FilletEdge', tip: 'Fillet edges  (FE)', icon: 'filletEdge' },
    { macro: 'Shell', tip: 'Shell: hollow a solid', icon: 'shell' },
    { macro: 'Section', tip: 'Section curves through a plane', icon: 'section' },
    { macro: 'Contour', tip: 'Contour curves at regular spacing', icon: 'contour' },
    { macro: 'BooleanUnion', tip: 'Boolean union  (BU)', icon: 'booleanUnion' },
    { macro: 'BooleanDifference', tip: 'Boolean difference  (BD)', icon: 'booleanDifference' },
    { macro: 'BooleanIntersection', tip: 'Boolean intersection  (BI)', icon: 'booleanIntersection' },
  ],
  [
    { macro: 'Make2D', tip: 'Make2D: 2D drawing of the selection', icon: 'make2d' },
    { macro: 'Text', tip: 'Text', icon: 'text' },
    { macro: 'Dim', tip: 'Linear dimension', icon: 'dimLinear' },
    { macro: 'DimAligned', tip: 'Aligned dimension', icon: 'dimAligned' },
    { macro: 'DimRadius', tip: 'Radius dimension', icon: 'dimRadius' },
    { macro: 'DimAngle', tip: 'Angle dimension', icon: 'dimAngle' },
    { macro: 'Leader', tip: 'Leader', icon: 'leader' },
  ],
]

/** File, history and view tools, in the horizontal bar under the command line. */
const STANDARD_TOOLS: Tool[][] = [
  [
    { macro: 'New', tip: 'New  (Ctrl+N)', icon: 'new' },
    { macro: 'Open', tip: 'Open  (Ctrl+O)', icon: 'open' },
    { macro: 'Save', tip: 'Save  (Ctrl+S)', icon: 'save' },
  ],
  [
    { macro: 'Undo', tip: 'Undo  (Ctrl+Z)', icon: 'undo' },
    { macro: 'Redo', tip: 'Redo  (Ctrl+Y)', icon: 'redo' },
  ],
  [{ macro: 'SelAll', tip: 'Select all  (Ctrl+A)', icon: 'selectAll' }],
  [
    { macro: 'Zoom All', tip: 'Zoom extents, all viewports  (ZEA)', icon: 'zoomExtents' },
    { macro: 'Zoom Selected', tip: 'Zoom selected  (ZS)', icon: 'zoomSelected' },
    { macro: 'MaxViewport', tip: 'Maximize or restore the active viewport', icon: 'fourViews' },
  ],
]

function build(container: HTMLElement, groups: Tool[][], runner: CommandRunner): void {
  for (const group of groups) {
    const wrapper = document.createElement('div')
    wrapper.className = 'tool-group'
    for (const tool of group) wrapper.appendChild(iconButton(tool.icon, tool.tip, () => void runner.run(tool.macro)))
    container.appendChild(wrapper)
  }
}

export function buildToolbars(side: HTMLElement, standard: HTMLElement, runner: CommandRunner): void {
  build(side, SIDE_TOOLS, runner)
  build(standard, STANDARD_TOOLS, runner)
}
