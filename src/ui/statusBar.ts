import type { Document } from '../core/document'
import type { Settings, SnapKind, ToggleKey } from '../core/settings'

const SNAPS: [SnapKind, string][] = [
  ['end', 'End'],
  ['near', 'Near'],
  ['mid', 'Mid'],
  ['cen', 'Cen'],
  ['quad', 'Quad'],
]

const TOGGLES: [ToggleKey, string, string][] = [
  ['gridSnap', 'Grid Snap', 'F9'],
  ['ortho', 'Ortho', 'F8'],
  ['osnap', 'Osnap', 'F3'],
  ['gumball', 'Gumball', ''],
]

/** Bottom bar: cursor coordinates, current layer, selection, object snaps and drawing aids. */
export class StatusBar {
  private readonly coords = document.createElement('span')
  private readonly swatch = document.createElement('i')
  private readonly layerName = document.createElement('span')
  private readonly selection = document.createElement('span')
  private readonly units = document.createElement('span')

  constructor(
    bar: HTMLElement,
    private readonly doc: Document,
    private readonly settings: Settings,
  ) {
    const coordsGroup = this.group('status-coords')
    const cplane = document.createElement('span')
    cplane.className = 'status-label'
    cplane.textContent = 'CPlane'
    this.coords.className = 'status-value'
    this.units.className = 'status-label'
    coordsGroup.append(cplane, this.coords, this.units)

    const layerGroup = this.group('status-layer')
    layerGroup.dataset.tip = 'Current layer'
    layerGroup.append(this.swatch, this.layerName)

    this.selection.className = 'status-selection'

    const snapGroup = this.group('status-snaps')
    for (const [kind, text] of SNAPS) snapGroup.appendChild(this.snapChip(kind, text))

    const toggleGroup = this.group('status-toggles')
    for (const [key, text, shortcut] of TOGGLES) toggleGroup.appendChild(this.toggle(key, text, shortcut))

    const spacer = document.createElement('span')
    spacer.className = 'status-spacer'
    bar.append(coordsGroup, layerGroup, this.selection, spacer, snapGroup, toggleGroup)

    doc.on(() => this.renderDocument())
    settings.onChange(() => bar.classList.toggle('osnap-off', !settings.osnap))
    bar.classList.toggle('osnap-off', !settings.osnap)
    this.setCoords(0, 0, 0)
    this.renderDocument()
  }

  setCoords(x: number, y: number, z: number): void {
    this.coords.textContent = `${fmt(x)}  ${fmt(y)}  ${fmt(z)}`
  }

  private group(className: string): HTMLElement {
    const el = document.createElement('div')
    el.className = `status-group ${className}`
    return el
  }

  private snapChip(kind: SnapKind, text: string): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'snap-chip'
    chip.textContent = text
    chip.dataset.tip = `${text} object snap`
    chip.setAttribute('aria-pressed', 'false')
    chip.addEventListener('click', () => this.settings.setSnap(kind, !this.settings.snaps[kind]))
    const sync = () => {
      chip.classList.toggle('on', this.settings.snaps[kind])
      chip.setAttribute('aria-pressed', String(this.settings.snaps[kind]))
    }
    this.settings.onChange(sync)
    sync()
    return chip
  }

  private toggle(key: ToggleKey, text: string, shortcut: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'status-toggle'
    button.textContent = text
    button.dataset.tip = shortcut ? `${text}  (${shortcut})` : text
    button.addEventListener('click', () => this.settings.toggle(key))
    const sync = () => {
      button.classList.toggle('on', this.settings[key])
      button.setAttribute('aria-pressed', String(this.settings[key]))
    }
    this.settings.onChange(sync)
    sync()
    return button
  }

  private renderDocument(): void {
    const layer = this.doc.currentLayer
    this.swatch.style.background = layer.color
    this.layerName.textContent = layer.name
    const n = this.doc.selection.size
    const points = this.doc.selectedPointCount
    this.selection.textContent = points > 0 ? `${points} point${points === 1 ? '' : 's'} selected` : n === 0 ? '' : `${n} selected`
    this.units.textContent = UNIT_ABBREVIATIONS[this.doc.units] ?? this.doc.units
  }
}

const UNIT_ABBREVIATIONS: Record<string, string> = {
  Microns: 'µm',
  Millimeters: 'mm',
  Centimeters: 'cm',
  Decimeters: 'dm',
  Meters: 'm',
  Kilometers: 'km',
  Inches: 'in',
  Feet: 'ft',
  Yards: 'yd',
  Miles: 'mi',
}

/** Fixed width so the numbers do not jitter as the cursor moves. */
function fmt(n: number): string {
  return n.toFixed(3).padStart(10, ' ')
}
