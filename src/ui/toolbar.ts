import type { CommandRunner } from '../commands/runner'

interface Tool {
  macro: string
  title: string
  /** Path data for a 20×20 stroked icon. */
  icon: string
}

const GROUPS: Tool[][] = [
  [
    { macro: 'Line', title: 'Line', icon: 'M4 16 16 4' },
    { macro: 'Polyline', title: 'Polyline', icon: 'M3 15 8 6l4 6 5-8' },
    { macro: 'Circle', title: 'Circle', icon: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z' },
    { macro: 'Curve', title: 'Curve', icon: 'M3 15C6 3 10 21 17 5' },
  ],
  [
    { macro: 'Move', title: 'Move (M)', icon: 'M10 3v14M3 10h14M8 5l2-2 2 2M8 15l2 2 2-2M5 8l-2 2 2 2M15 8l2 2-2 2' },
    { macro: 'Copy', title: 'Copy', icon: 'M7 7h9v9H7ZM4 13V4h9' },
    { macro: 'Delete', title: 'Delete (Del)', icon: 'M5 5l10 10M15 5 5 15' },
  ],
  [
    { macro: 'Undo', title: 'Undo (Ctrl+Z)', icon: 'M7 5 4 8l3 3M4 8h8a4 4 0 0 1 0 8H8' },
    { macro: 'Redo', title: 'Redo (Ctrl+Y)', icon: 'M13 5l3 3-3 3M16 8H8a4 4 0 0 0 0 8h4' },
  ],
  [{ macro: 'Zoom All', title: 'Zoom extents, all viewports (ZEA)', icon: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4' }],
]

const SVG_NS = 'http://www.w3.org/2000/svg'

export function buildToolbar(container: HTMLElement, runner: CommandRunner): void {
  for (const group of GROUPS) {
    const wrapper = document.createElement('div')
    wrapper.className = 'tool-group'
    for (const tool of group) {
      const button = document.createElement('button')
      button.type = 'button'
      button.title = tool.title
      button.setAttribute('aria-label', tool.title)

      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 20 20')
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', tool.icon)
      svg.appendChild(path)
      button.appendChild(svg)

      button.addEventListener('click', () => void runner.run(tool.macro))
      wrapper.appendChild(button)
    }
    container.appendChild(wrapper)
  }
}
