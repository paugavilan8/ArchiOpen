/**
 * Linetypes, as dash patterns in millimeters on paper: positive lengths are drawn, negative ones
 * are gaps and zeros are dots. They keep the same size whatever the drawing scale, as on a plotter.
 */
export const LINETYPES: Record<string, number[]> = {
  Continuous: [],
  Dashed: [3, -1.5],
  Hidden: [1.5, -1],
  Center: [8, -1.5, 1.5, -1.5],
  DashDot: [4, -1.2, 0, -1.2],
  Dots: [0, -1],
}

export const LINETYPE_NAMES = Object.keys(LINETYPES)

/** Pen widths in millimeters offered for printing; 0 is the default thin line. */
export const PRINT_WIDTHS = [0, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1]

/** Width used when a layer has none set, in millimeters. */
export const DEFAULT_PRINT_WIDTH = 0.18

export const dashesOf = (linetype: string | undefined): number[] => LINETYPES[linetype ?? 'Continuous'] ?? []
