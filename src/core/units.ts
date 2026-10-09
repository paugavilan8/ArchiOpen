/** Length of one unit in meters, for the units a model is likely to use. */
export const METERS: Record<string, number> = {
  Microns: 1e-6,
  Millimeters: 1e-3,
  Centimeters: 1e-2,
  Decimeters: 0.1,
  Meters: 1,
  Kilometers: 1000,
  Inches: 0.0254,
  Feet: 0.3048,
  Yards: 0.9144,
  Miles: 1609.344,
}

/** Millimeters in one model unit. */
export const millimetersPer = (units: string): number => (METERS[units] ?? 1e-3) * 1000

const ABBREVIATIONS: Record<string, string> = {
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

/** Short name of a unit, e.g. "mm". */
export const unitAbbreviation = (units: string): string => ABBREVIATIONS[units] ?? units
