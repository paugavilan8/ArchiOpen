import type { Document, Layer } from '../core/document'
import { DEFAULT_PRINT_WIDTH, LINETYPE_NAMES, PRINT_WIDTHS } from '../core/linetypes'
import { iconButton } from './icons'

export class LayersPanel {
  private readonly list = document.createElement('ul')
  /** Linetype and print width of the current layer. */
  private readonly details = document.createElement('div')

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly log: (text: string) => void,
  ) {
    const header = document.createElement('div')
    header.className = 'panel-toolbar'
    const hint = document.createElement('span')
    hint.className = 'panel-hint'
    hint.textContent = 'Click to make current'
    header.append(
      hint,
      iconButton('plus', 'New layer', () => doc.addLayer()),
      iconButton('minus', 'Delete current layer', () => this.removeCurrent()),
    )

    this.list.className = 'layer-list'
    // Delegated, because the click that precedes a double-click can re-render the rows.
    this.list.addEventListener('dblclick', (e) => {
      const label = (e.target as Element).closest<HTMLElement>('.layer-name')
      const layer = doc.layers.find((l) => String(l.id) === label?.dataset.layerId)
      if (label && layer) this.rename(layer, label)
    })
    this.details.className = 'properties layer-properties'
    container.append(header, this.list, this.details)

    doc.on((kind) => {
      if (kind !== 'selection') this.render()
    })
    this.render()
  }

  private removeCurrent(): void {
    const layer = this.doc.currentLayer
    if (!this.doc.removeLayer(layer.id)) this.log(`Cannot delete layer "${layer.name}": it is the only layer or it contains objects`)
  }

  private render(): void {
    const counts = new Map<number, number>()
    for (const obj of this.doc.objects.values()) counts.set(obj.layerId, (counts.get(obj.layerId) ?? 0) + 1)
    this.list.replaceChildren(...this.doc.layers.map((layer) => this.row(layer, counts.get(layer.id) ?? 0)))
    this.renderDetails()
  }

  private renderDetails(): void {
    const { doc } = this
    const layer = doc.currentLayer
    const section = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = `Layer ${layer.name}`
    const list = document.createElement('dl')
    const field = (label: string, input: HTMLElement) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.appendChild(input)
      list.append(dt, dd)
    }
    const linetype = document.createElement('select')
    for (const name of LINETYPE_NAMES) linetype.add(new Option(name, name, false, (layer.linetype ?? 'Continuous') === name))
    linetype.addEventListener('change', () => doc.updateLayer(layer.id, { linetype: linetype.value }))
    field('Linetype', linetype)
    const width = document.createElement('select')
    for (const w of PRINT_WIDTHS) {
      const label = w === 0 ? `Default (${DEFAULT_PRINT_WIDTH} mm)` : `${w} mm`
      width.add(new Option(label, String(w), false, (layer.printWidth ?? 0) === w))
    }
    width.addEventListener('change', () => doc.updateLayer(layer.id, { printWidth: Number(width.value) }))
    field('Print width', width)
    section.append(heading, list)
    this.details.replaceChildren(section)
  }

  private row(layer: Layer, count: number): HTMLLIElement {
    const { doc } = this
    const row = document.createElement('li')
    const isCurrent = layer.id === doc.currentLayerId
    row.classList.toggle('current', isCurrent)
    row.classList.toggle('hidden-layer', !layer.visible)
    row.addEventListener('click', () => doc.setCurrentLayer(layer.id))

    const current = document.createElement('span')
    current.className = 'layer-current'
    current.textContent = isCurrent ? '✓' : ''

    const color = document.createElement('input')
    color.type = 'color'
    color.value = layer.color
    color.dataset.tip = 'Layer color'
    color.addEventListener('click', (e) => e.stopPropagation())
    color.addEventListener('change', () => doc.updateLayer(layer.id, { color: color.value }))

    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = layer.name
    name.dataset.layerId = String(layer.id)
    name.dataset.tip = 'Double-click to rename'

    const objects = document.createElement('span')
    objects.className = 'layer-count'
    objects.textContent = count > 0 ? String(count) : ''

    const visible = iconButton(layer.visible ? 'eye' : 'eyeOff', layer.visible ? 'Hide layer' : 'Show layer', () =>
      doc.updateLayer(layer.id, { visible: !layer.visible }),
    )
    visible.classList.toggle('off', !layer.visible)
    const locked = iconButton(layer.locked ? 'lock' : 'unlock', layer.locked ? 'Unlock layer' : 'Lock layer', () =>
      doc.updateLayer(layer.id, { locked: !layer.locked }),
    )
    locked.classList.toggle('off', layer.locked)

    row.append(current, color, name, objects, visible, locked)
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
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(false)
      }
    })
  }
}
