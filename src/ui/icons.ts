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
  rectangle: 'M3 5h14v10H3Z',
  arc: 'M3 15A7 7 0 0 1 17 15M10 15h.01',
  trim: 'M5 3.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4ZM5 12.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4ZM6.8 6.5 17 14M6.8 13.5 17 6',
  split: 'M3 10h5M12 10h5M10 3.5v13',
  join: 'M3 16 10 5l7 11M8.5 3.5h3v3h-3Z',
  explode: 'M10 3v4M10 13v4M3 10h4M13 10h4M5 5l2.5 2.5M12.5 12.5 15 15M5 15l2.5-2.5M12.5 7.5 15 5',
  offset: 'M3 10.5C6 4.5 14 4.5 17 10.5M3 16C6 10 14 10 17 16',
  fillet: 'M4 3.5V10a6 6 0 0 0 6 6h6.5',
  filletCorners: 'M3 7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z',
  rotate: 'M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.5h-3.5',
  scale: 'M3 11h6v6H3ZM3 7V3h14v14h-4M11 9l5-5M12.5 4H16v3.5',
  mirror: 'M10 2.5v15M7.5 5 3 15h4.5ZM12.5 5 17 15h-4.5Z',
  array: 'M3 3h4v4H3ZM13 3h4v4h-4ZM3 13h4v4H3ZM13 13h4v4h-4Z',
  arrayPolar: 'M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M4.7 4.7l2.1 2.1M13.2 13.2l2.1 2.1M4.7 15.3l2.1-2.1M13.2 6.8l2.1-2.1',
  box: 'M3 7l7-4 7 4v7l-7 4-7-4ZM3 7l7 4 7-4M10 11v7',
  cylinder: 'M4 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5-6-1.1-6-2.5ZM4 5.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9',
  sphere: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM3 10c0 1.7 3.1 3 7 3s7-1.3 7-3',
  extrude: 'M4 15h9l3-3H7ZM7 12V4h9v8M4 15V7l3-3M13 15V7M4 7h9l3-3',
  revolve: 'M10 2.5v15M6 5c-2 1-3 2.6-3 5s1 4 3 5M14 5c2 1 3 2.6 3 5s-1 4-3 5M15.5 13.5 14 15l1.5 1.5',
  loft: 'M3 15c2-2 5-2 7 0s5 2 7 0M5 5c1.5-1.5 3.5-1.5 5 0s3.5 1.5 5 0M3 15 5 5M17 15l-2-10',
  planarSrf: 'M3 13l4-8h10l-4 8ZM6 11h7M8 7h7',
  booleanUnion: 'M7.5 4.5a5 5 0 1 0 0 10M12.5 5.5a5 5 0 1 1 0 10M7.5 4.5c1.7 0 3.2.9 4.1 2.2M12.5 15.5c-1.7 0-3.2-.9-4.1-2.2',
  booleanDifference: 'M7.5 4.5a5 5 0 1 0 0 10 5 5 0 0 0 1-.1 5 5 0 0 1 0-9.8 5 5 0 0 0-1-.1ZM12.5 5.5a5 5 0 1 1 0 10',
  booleanIntersection: 'M10 6a5 5 0 0 1 0 8 5 5 0 0 1 0-8ZM7.5 4.5a5 5 0 1 0 0 10M12.5 5.5a5 5 0 1 1 0 10',
  filletEdge: 'M3 17V9a6 6 0 0 1 6-6h8M3 17h8a6 6 0 0 0 6-6V3',
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
