import { applyCPlane, restoreView } from '../commands/viewSetup'
import type { CommandRunner } from '../commands/runner'
import type { Document } from '../core/document'
import type { Display } from '../view/display'
import { iconButton } from './icons'

/** Saved views and construction planes: click a name to bring it back. */
export class ViewsPanel {
  private readonly views = document.createElement('ul')
  private readonly planes = document.createElement('ul')
  private frame = 0

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly display: Display,
    runner: CommandRunner,
  ) {
    const section = (title: string, tip: string, macro: string, list: HTMLUListElement) => {
      const header = document.createElement('div')
      header.className = 'panel-toolbar'
      const label = document.createElement('span')
      label.className = 'panel-hint'
      label.textContent = title
      header.append(label, iconButton('plus', tip, () => void runner.run(macro)))
      list.className = 'layer-list named-list'
      return [header, list]
    }
    container.append(
      ...section('Named views', 'Save the active view  (NamedView)', 'NamedView Save', this.views),
      ...section('Named construction planes', 'Save the active construction plane  (NamedCPlane)', 'NamedCPlane Save', this.planes),
    )
    doc.on((kind) => {
      if (kind !== 'selection' && !this.frame) this.frame = requestAnimationFrame(() => this.render())
    })
    this.render()
  }

  private render(): void {
    this.frame = 0
    const { doc, display } = this
    this.fill(
      this.views,
      doc.namedViews.map((v) => v.name),
      'No saved views. The + button names the active view.',
      (name) => restoreView(display, name, doc.namedViews),
      (name) => doc.setNamedViews(doc.namedViews.filter((v) => v.name !== name)),
    )
    this.fill(
      this.planes,
      doc.namedCPlanes.map((p) => p.name),
      'No saved construction planes.',
      (name) => applyCPlane(display, doc.namedCPlanes.find((p) => p.name === name)!),
      (name) => doc.setNamedCPlanes(doc.namedCPlanes.filter((p) => p.name !== name)),
    )
  }

  private fill(list: HTMLUListElement, names: string[], emptyText: string, use: (name: string) => void, remove: (name: string) => void): void {
    if (names.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'panel-empty'
      empty.textContent = emptyText
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(
      ...names.map((name) => {
        const row = document.createElement('li')
        const label = document.createElement('span')
        label.className = 'layer-name'
        label.textContent = name
        label.dataset.tip = 'Click to restore'
        label.addEventListener('click', () => use(name))
        row.append(label, iconButton('minus', 'Delete', () => remove(name)))
        return row
      }),
    )
  }
}
