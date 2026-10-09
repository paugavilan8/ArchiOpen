import type { CommandRunner } from '../commands/runner'
import type { Document } from '../core/document'

/** A bar over the viewports while a block is edited in place, to finish or cancel the edit. */
export function installBlockEditBanner(container: HTMLElement, doc: Document, runner: CommandRunner): void {
  const bar = document.createElement('div')
  bar.className = 'block-edit-banner'
  bar.hidden = true
  const label = document.createElement('span')
  const button = (text: string, macro: string, primary = false) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    if (primary) b.className = 'primary'
    b.addEventListener('click', () => void runner.run(macro))
    return b
  }
  bar.append(label, button('Cancel', 'BlockEditCancel'), button('Finish', 'BlockEditFinish', true))
  container.appendChild(bar)
  const update = () => {
    const edit = doc.blockEdit
    bar.hidden = !edit
    if (edit) label.textContent = `Editing block “${edit.block}”`
  }
  doc.on(update)
  update()
}
