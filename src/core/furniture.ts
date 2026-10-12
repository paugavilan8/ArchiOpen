/**
 * A small library of furniture and fittings, each a few simple solids (boxes and cylinders) made
 * into a block the first time it is used. Sizes are in millimeters. Each item stands on the floor
 * with its back against a wall: x across it (centred on the insertion point), y from its back (0)
 * to its front, z up.
 */

export type FurnitureCategory = 'furniture' | 'sanitary' | 'kitchen'

/** A box from its corner (x, y, z) by its size (dx, dy, dz), or an upright cylinder on a centre. */
export type Primitive = { box: [number, number, number, number, number, number] } | { cylinder: [number, number, number, number, number] }

export interface FurnitureItem {
  /** Name to type (no spaces). */
  key: string
  /** Name shown and used for its block. */
  label: string
  category: FurnitureCategory
  parts: Primitive[]
}

const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number): Primitive => ({ box: [x, y, z, dx, dy, dz] })
/** A box centred across x. */
const cbox = (width: number, y: number, z: number, depth: number, height: number): Primitive => box(-width / 2, y, z, width, depth, height)
const cyl = (x: number, y: number, z: number, radius: number, height: number): Primitive => ({ cylinder: [x, y, z, radius, height] })

/** Four legs under a top: at its corners, inset. */
function legs(width: number, depth: number, height: number, size: number, inset = 40): Primitive[] {
  const xs = [-width / 2 + inset, width / 2 - inset - size]
  const ys = [inset, depth - inset - size]
  return xs.flatMap((x) => ys.map((y) => box(x, y, 0, size, size, height)))
}

function bed(width: number): Primitive[] {
  return [
    cbox(width, 0, 0, 2050, 300), // frame
    cbox(width - 40, 50, 300, 1980, 200), // mattress
    cbox(width, 0, 300, 60, 600), // headboard
    ...(width >= 1200 ? [box(-width / 2 + 60, 120, 500, width / 2 - 100, 400, 120), box(40, 120, 500, width / 2 - 100, 400, 120)] : [cbox(width - 200, 120, 500, 400, 120)]),
  ]
}

export const FURNITURE: FurnitureItem[] = [
  { key: 'DoubleBed', label: 'Double bed', category: 'furniture', parts: bed(1500) },
  { key: 'SingleBed', label: 'Single bed', category: 'furniture', parts: bed(900) },
  {
    key: 'Sofa',
    label: 'Sofa',
    category: 'furniture',
    parts: [cbox(2000, 0, 0, 900, 420), cbox(2000, 0, 420, 200, 380), box(-1000, 0, 420, 180, 900, 220), box(820, 0, 420, 180, 900, 220)],
  },
  {
    key: 'Armchair',
    label: 'Armchair',
    category: 'furniture',
    parts: [cbox(900, 0, 0, 850, 420), cbox(900, 0, 420, 180, 400), box(-450, 0, 420, 150, 850, 220), box(300, 0, 420, 150, 850, 220)],
  },
  { key: 'DiningTable', label: 'Dining table', category: 'furniture', parts: [cbox(1600, 0, 720, 900, 40), ...legs(1600, 900, 720, 60)] },
  { key: 'Chair', label: 'Chair', category: 'furniture', parts: [cbox(450, 0, 430, 450, 30), ...legs(450, 450, 430, 35, 20), cbox(450, 0, 460, 30, 420)] },
  { key: 'Desk', label: 'Desk', category: 'furniture', parts: [cbox(1400, 0, 720, 700, 30), box(-700, 0, 0, 30, 700, 720), box(670, 0, 0, 30, 700, 720)] },
  { key: 'Wardrobe', label: 'Wardrobe', category: 'furniture', parts: [cbox(1200, 0, 0, 600, 2200)] },
  {
    key: 'KitchenCounter',
    label: 'Kitchen counter',
    category: 'kitchen',
    parts: [cbox(2400, 0, 100, 560, 760), cbox(2400, 0, 860, 620, 40), cbox(2400, 0, 0, 500, 100), cbox(800, 0, 1450, 350, 700)],
  },
  { key: 'Fridge', label: 'Fridge', category: 'kitchen', parts: [cbox(600, 0, 0, 650, 1850)] },
  { key: 'WC', label: 'WC', category: 'sanitary', parts: [cbox(380, 0, 0, 180, 800), cyl(0, 430, 0, 180, 400), cbox(240, 180, 0, 250, 380)] },
  { key: 'Washbasin', label: 'Washbasin', category: 'sanitary', parts: [cbox(600, 0, 700, 460, 150), cbox(160, 0, 0, 160, 700)] },
  { key: 'Bathtub', label: 'Bathtub', category: 'sanitary', parts: [cbox(1700, 0, 0, 750, 550)] },
  { key: 'ShowerTray', label: 'Shower tray', category: 'sanitary', parts: [cbox(900, 0, 0, 900, 50)] },
]

export const furnitureItem = (name: string): FurnitureItem | undefined => {
  const n = name.toLowerCase().replace(/[\s_-]+/g, '')
  return FURNITURE.find((f) => f.key.toLowerCase() === n || f.label.toLowerCase().replace(/\s+/g, '') === n)
}

/** An item's extent: its width, depth and height. */
export function furnitureSize(item: FurnitureItem): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of item.parts) {
    const [x0, y0, z0, x1, y1, z1] = 'box' in p ? [p.box[0], p.box[1], p.box[2], p.box[0] + p.box[3], p.box[1] + p.box[4], p.box[2] + p.box[5]] : [p.cylinder[0] - p.cylinder[3], p.cylinder[1] - p.cylinder[3], p.cylinder[2], p.cylinder[0] + p.cylinder[3], p.cylinder[1] + p.cylinder[3], p.cylinder[2] + p.cylinder[4]]
    ;[x0, y0, z0].forEach((v, i) => (lo[i] = Math.min(lo[i], v)))
    ;[x1, y1, z1].forEach((v, i) => (hi[i] = Math.max(hi[i], v)))
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
}
