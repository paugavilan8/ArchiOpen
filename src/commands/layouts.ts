import { newLayout } from '../core/layout'
import type { Command } from './runner'

const layout: Command = {
  name: 'Layout',
  async run({ doc, display, log }) {
    const id = doc.layouts.reduce((max, l) => Math.max(max, l.id), 0) + 1
    let n = doc.layouts.length + 1
    while (doc.layouts.some((l) => l.name === `Sheet ${n}`)) n++
    const sheet = newLayout(doc, id, `Sheet ${n}`)
    doc.setLayouts([...doc.layouts, sheet])
    display.showLayout(id)
    log(`Layout "${sheet.name}" made (${sheet.paper} landscape). Drag the detail to move it, its corners to resize it, and Shift+drag to pan the view in it`)
  },
}

const model: Command = {
  name: 'ModelView',
  history: false,
  repeat: false,
  async run({ display }) {
    display.showLayout(null)
  },
}

export const layoutCommands: Command[] = [layout, model]
