import type { Document, Layer } from '../core/document'

export class LayersPanel {
  private readonly list = document.createElement('ul')

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly log: (text: string) => void,
  ) {
    const section = document.createElement('section')
    section.className = 'panel'

    const header = document.createElement('header')
    const title = document.createElement('h2')
    title.textContent = 'Layers'
    header.append(title, this.button('+', 'New layer', () => doc.addLayer()), this.button('−', 'Delete current layer', () => this.removeCurrent()))

    this.list.className = 'layer-list'
    // Delegated, because the click that precedes a double-click can re-render the rows.
    this.list.addEventListener('dblclick', (e) => {
      const label = (e.target as Element).closest<HTMLElement>('.layer-name')
      const layer = doc.layers.find((l) => String(l.id) === label?.dataset.layerId)
      if (label && layer) this.rename(layer, label)
    })
    section.append(header, this.list)
    container.appendChild(section)

    doc.on((kind) => {
      if (kind === 'layers') this.render()
    })
    this.render()
  }

  private removeCurrent(): void {
    const layer = this.doc.currentLayer
    if (!this.doc.removeLayer(layer.id)) this.log(`Cannot delete layer "${layer.name}": it is the only layer or it contains objects`)
  }

  private render(): void {
    this.list.replaceChildren(...this.doc.layers.map((layer) => this.row(layer)))
  }

  private row(layer: Layer): HTMLLIElement {
    const { doc } = this
    const row = document.createElement('li')
    row.classList.toggle('current', layer.id === doc.currentLayerId)
    row.title = 'Click to make current, double-click the name to rename'
    row.addEventListener('click', () => doc.setCurrentLayer(layer.id))

    const current = document.createElement('span')
    current.className = 'layer-current'
    current.textContent = layer.id === doc.currentLayerId ? '✓' : ''

    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = layer.name
    name.dataset.layerId = String(layer.id)

    const visible = this.toggle(layer.visible ? 'On' : 'Off', 'Show or hide the layer', layer.visible, () =>
      doc.updateLayer(layer.id, { visible: !layer.visible }),
    )
    const locked = this.toggle(layer.locked ? 'Locked' : 'Free', 'Lock or unlock the layer', !layer.locked, () =>
      doc.updateLayer(layer.id, { locked: !layer.locked }),
    )

    const color = document.createElement('input')
    color.type = 'color'
    color.value = layer.color
    color.title = 'Layer color'
    color.addEventListener('click', (e) => e.stopPropagation())
    color.addEventListener('change', () => doc.updateLayer(layer.id, { color: color.value }))

    row.append(current, name, visible, locked, color)
    return row
  }

  private rename(layer: Layer, label: HTMLElement): void {
    const input = document.createElement('input')
    input.className = 'layer-rename'
    input.value = layer.name
    label.replaceWith(input)
    input.select()

    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name !== '' && name !== layer.name) this.doc.updateLayer(layer.id, { name })
      else this.render()
    }
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
  }

  private toggle(text: string, title: string, on: boolean, onClick: () => void): HTMLButtonElement {
    const button = this.button(text, title, onClick)
    button.classList.add('layer-toggle')
    button.classList.toggle('off', !on)
    return button
  }

  private button(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.title = title
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return button
  }
}
