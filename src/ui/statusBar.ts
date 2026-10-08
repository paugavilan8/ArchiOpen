import type { Document } from '../core/document'
import type { Settings, SnapKind, ToggleKey } from '../core/settings'

const SNAPS: [SnapKind, string][] = [
  ['end', 'End'],
  ['near', 'Near'],
  ['mid', 'Mid'],
  ['cen', 'Cen'],
  ['quad', 'Quad'],
]

const TOGGLES: [ToggleKey, string][] = [
  ['gridSnap', 'Grid Snap'],
  ['ortho', 'Ortho'],
  ['osnap', 'Osnap'],
]

/** Object snap checkboxes plus the bottom bar with coordinates, current layer and mode toggles. */
export class StatusBar {
  private readonly coords = document.createElement('span')
  private readonly layer = document.createElement('span')
  private readonly swatch = document.createElement('i')
  private readonly layerName = document.createElement('span')

  constructor(
    private readonly doc: Document,
    private readonly settings: Settings,
  ) {
    this.buildSnapBar(document.getElementById('osnap-bar')!)
    this.buildStatusBar(document.getElementById('status-bar')!)
    doc.on((kind) => {
      if (kind === 'layers') this.renderLayer()
    })
    this.setCoords(0, 0, 0)
    this.renderLayer()
  }

  setCoords(x: number, y: number, z: number): void {
    this.coords.textContent = `x ${x.toFixed(3)}   y ${y.toFixed(3)}   z ${z.toFixed(3)}`
  }

  private buildSnapBar(bar: HTMLElement): void {
    for (const [kind, text] of SNAPS) {
      const label = document.createElement('label')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = this.settings.snaps[kind]
      box.addEventListener('change', () => this.settings.setSnap(kind, box.checked))
      label.append(box, text)
      bar.appendChild(label)
    }
  }

  private buildStatusBar(bar: HTMLElement): void {
    const cplane = document.createElement('span')
    cplane.textContent = 'CPlane'
    this.coords.className = 'status-coords'
    const units = document.createElement('span')
    units.textContent = 'Millimeters'
    this.layer.className = 'status-layer'
    this.layer.append(this.swatch, this.layerName)
    bar.append(cplane, this.coords, units, this.layer)

    for (const [key, text] of TOGGLES) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'status-toggle'
      button.textContent = text
      button.addEventListener('click', () => this.settings.toggle(key))
      const sync = () => button.classList.toggle('on', this.settings[key])
      this.settings.onChange(sync)
      sync()
      bar.appendChild(button)
    }
  }

  private renderLayer(): void {
    const layer = this.doc.currentLayer
    this.swatch.style.background = layer.color
    this.layerName.textContent = layer.name
  }
}
