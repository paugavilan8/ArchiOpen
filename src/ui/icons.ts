/** Path data for the 20×20 stroked interface icons. */
export const ICONS = {
  new: 'M5 2.5h6.5L15 6v11.5H5ZM11.5 2.5V6H15',
  open: 'M2.5 15.5v-11h5L9 6h6.5v2.5M2.5 15.5l2.2-7h13l-2.2 7Z',
  save: 'M3.5 3.5h10l3 3v10h-13ZM6.5 3.5v3.5h6V3.5M6 16.5v-5h8v5',
  undo: 'M7 5 4 8l3 3M4 8h8a4 4 0 0 1 0 8H8',
  redo: 'M13 5l3 3-3 3M16 8H8a4 4 0 0 0 0 8h4',
  line: 'M4 16 16 4',
  polyline: 'M3 15 8 6l4 6 5-8',
  circle: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z',
  curve: 'M3 15C6 3 10 21 17 5',
  move: 'M10 3v14M3 10h14M8 5l2-2 2 2M8 15l2 2 2-2M5 8l-2 2 2 2M15 8l2 2-2 2',
  copy: 'M7 7h9v9H7ZM4 13V4h9',
  delete: 'M4.5 5.5h11M8 5.5V3.5h4v2M6 5.5l.8 11h6.4l.8-11',
  selectAll: 'M3 6V3h3M14 3h3v3M17 14v3h-3M6 17H3v-3M7 7h6v6H7Z',
  zoomExtents: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M7 10h6M10 7v6',
  zoomSelected: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M7.5 7.5h5v5h-5Z',
  fourViews: 'M3 3h6v6H3ZM11 3h6v6h-6ZM3 11h6v6H3ZM11 11h6v6h-6Z',
  maximize: 'M3 3h14v14H3ZM3 6.5h14',
  plus: 'M10 4v12M4 10h12',
  minus: 'M4 10h12',
  eye: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10ZM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  eyeOff: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10ZM3 17 17 3',
  lock: 'M5 9h10v8H5ZM7 9V6.5a3 3 0 0 1 6 0V9',
  unlock: 'M5 9h10v8H5ZM7 9V6.5a3 3 0 0 1 5.8-1',
  chevron: 'M6 8l4 4 4-4',
} as const

export type IconName = keyof typeof ICONS

const SVG_NS = 'http://www.w3.org/2000/svg'

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name])
  svg.appendChild(path)
  return svg
}

/** A borderless icon button with a tooltip. */
export function iconButton(name: IconName, tip: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-button'
  button.dataset.tip = tip
  button.setAttribute('aria-label', tip)
  button.appendChild(icon(name))
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return button
}
