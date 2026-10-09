/** Render materials: physically based, with a few presets to start from. */

export interface Material {
  name: string
  /** Base color, as #rrggbb. */
  color: string
  /** 0 is a mirror finish, 1 fully matte. */
  roughness: number
  /** 0 for paint, plastic, stone or wood; 1 for bare metal. */
  metalness: number
  /** How much light passes through, 0 to 1 (glass is near 1). */
  transparency: number
}

export const MATERIAL_PRESETS: Material[] = [
  { name: 'White plaster', color: '#f2efe9', roughness: 0.9, metalness: 0, transparency: 0 },
  { name: 'Concrete', color: '#a9a69f', roughness: 0.85, metalness: 0, transparency: 0 },
  { name: 'Wood', color: '#a8723f', roughness: 0.6, metalness: 0, transparency: 0 },
  { name: 'Brick', color: '#9c4a32', roughness: 0.9, metalness: 0, transparency: 0 },
  { name: 'Glossy plastic', color: '#c8323c', roughness: 0.25, metalness: 0, transparency: 0 },
  { name: 'Rubber', color: '#222426', roughness: 0.95, metalness: 0, transparency: 0 },
  { name: 'Ceramic', color: '#fafafa', roughness: 0.08, metalness: 0, transparency: 0 },
  { name: 'Brushed steel', color: '#c4c7cc', roughness: 0.35, metalness: 1, transparency: 0 },
  { name: 'Chrome', color: '#e8eaee', roughness: 0.03, metalness: 1, transparency: 0 },
  { name: 'Gold', color: '#e6b85c', roughness: 0.2, metalness: 1, transparency: 0 },
  { name: 'Copper', color: '#d08a5e', roughness: 0.3, metalness: 1, transparency: 0 },
  { name: 'Glass', color: '#e9f2f2', roughness: 0.02, metalness: 0, transparency: 0.95 },
  { name: 'Frosted glass', color: '#eef4f4', roughness: 0.45, metalness: 0, transparency: 0.85 },
  { name: 'Water', color: '#4f8fa8', roughness: 0.05, metalness: 0, transparency: 0.7 },
]

/** The material objects get when none is assigned: their layer color, as matte paint. */
export const layerMaterial = (color: string): Material => ({ name: '', color, roughness: 0.7, metalness: 0, transparency: 0 })

const clamp01 = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback)

/** A material read from a file, with anything missing or out of range set to a sensible value. */
export function materialFromJSON(j: Partial<Material>): Material | null {
  if (!j || typeof j.name !== 'string' || !j.name) return null
  return {
    name: j.name,
    color: typeof j.color === 'string' && /^#[0-9a-f]{6}$/i.test(j.color) ? j.color : '#cccccc',
    roughness: clamp01(j.roughness, 0.7),
    metalness: clamp01(j.metalness, 0),
    transparency: clamp01(j.transparency, 0),
  }
}

/** Sun and backdrop for rendered views and renders. */
export interface RenderSettings {
  /** Compass direction the sun shines from, in degrees (0 is north, +Y; 90 is east, +X). */
  sunAzimuth: number
  /** Height of the sun above the horizon, in degrees. */
  sunAltitude: number
  sunIntensity: number
  background: 'Studio' | 'White' | 'Sky'
  /** Shadows on a ground plane under the model. */
  groundShadows: boolean
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = { sunAzimuth: 230, sunAltitude: 40, sunIntensity: 2.5, background: 'Studio', groundShadows: true }

export function renderSettingsFromJSON(j: Partial<RenderSettings> | undefined): RenderSettings {
  const d = DEFAULT_RENDER_SETTINGS
  if (!j) return { ...d }
  return {
    sunAzimuth: typeof j.sunAzimuth === 'number' ? j.sunAzimuth : d.sunAzimuth,
    sunAltitude: typeof j.sunAltitude === 'number' ? Math.min(90, Math.max(1, j.sunAltitude)) : d.sunAltitude,
    sunIntensity: typeof j.sunIntensity === 'number' ? Math.max(0, j.sunIntensity) : d.sunIntensity,
    background: j.background === 'White' || j.background === 'Sky' ? j.background : 'Studio',
    groundShadows: j.groundShadows !== false,
  }
}
