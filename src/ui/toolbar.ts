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
    { macro: 'Circle', tip: 'Circle', icon: 'circle' },
    { macro: 'Curve', tip: 'Control point curve', icon: 'curve' },
  ],
  [
    { macro: 'Move', tip: 'Move  (M)', icon: 'move' },
    { macro: 'Copy', tip: 'Copy', icon: 'copy' },
    { macro: 'Delete', tip: 'Delete  (Del)', icon: 'delete' },
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
