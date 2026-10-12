import { Vector3 } from 'three'
import { textShape } from '../text/strokeFont'
import type { AnnotationGeometry, AnyCurve, Geometry } from './geometry'

/**
 * Heights on elevations and sections, as architects mark them: a level mark (a small triangle on a
 * line, with the level's name and height, ±0.00 at zero) at each level and at the top of the
 * building on the left, and on the right two chains of vertical dimensions: an inner one through
 * the sills and heads of the openings seen, and an outer one from level to level.
 *
 * Drawings lie in their own plane: x along the drawing, y up (the model's height).
 */

export interface HeightsInView {
  /** The levels to mark, by name and height. */
  levels: { name: string; z: number }[]
  /** Bottoms and tops of the openings seen. */
  openings: { sill: number; head: number }[]
}

/** A height in meters, signed, with two decimals: +3.00, ±0.00, -0.45. */
export function formatHeight(z: number, toMeters: number): string {
  const m = Math.round(z * toMeters * 100) / 100
  if (m === 0) return '±0.00'
  return `${m > 0 ? '+' : '-'}${Math.abs(m).toFixed(2)}`
}

/** Heights closer than `tolerance` taken as one, sorted. */
export function distinctHeights(values: number[], tolerance: number): number[] {
  const out: number[] = []
  for (const v of [...values].sort((a, b) => a - b)) if (out.length === 0 || v - out[out.length - 1] > tolerance) out.push(v)
  return out
}

const text = (t: string, at: Vector3, height: number): AnnotationGeometry => ({
  type: 'annotation',
  kind: 'text',
  points: [at],
  xaxis: new Vector3(1, 0, 0),
  yaxis: new Vector3(0, 1, 0),
  text: t,
  height,
  arrow: 'arrow',
  precision: 0,
})

const dimension = (from: number, to: number, x: number, height: number): AnnotationGeometry => ({
  type: 'annotation',
  kind: 'aligned',
  points: [new Vector3(x, from, 0), new Vector3(x, to, 0), new Vector3(x, from, 0)],
  xaxis: new Vector3(1, 0, 0),
  yaxis: new Vector3(0, 1, 0),
  text: '',
  height,
  arrow: 'tick',
  precision: 0,
})

/**
 * The marks and dimensions for a drawing spanning `left` to `right` (in its x) and up to `top`.
 * `toMeters` turns model units into meters for the level marks.
 */
export function heightMarks(heights: HeightsInView, left: number, right: number, top: number, textHeight: number, toMeters: number): Geometry[] {
  const out: Geometry[] = []
  const tolerance = textHeight * 0.05
  const marks = [...heights.levels]
  if (!marks.some((l) => Math.abs(l.z - top) < tolerance)) marks.push({ name: '', z: top })
  const labels = marks.map(({ name, z }) => `${name ? name + '  ' : ''}${formatHeight(z, toMeters)}`)
  // Level marks on the left, clear of the drawing: a triangle standing on a line, the text on it.
  const size = textHeight * 0.9
  const gap = textHeight
  const x0 = left - gap - size * 2 - Math.max(...labels.map((l) => Math.max(...textShape(l).widths) * textHeight))
  marks.forEach(({ z }, i) => {
    out.push({ type: 'polyline', points: [new Vector3(x0, z, 0), new Vector3(left - gap * 0.3, z, 0)], closed: false } as AnyCurve)
    const tip = x0 + size * 0.6
    out.push({ type: 'polyline', points: [new Vector3(tip, z, 0), new Vector3(tip - size * 0.6, z + size, 0), new Vector3(tip + size * 0.6, z + size, 0)], closed: true } as AnyCurve)
    out.push(text(labels[i], new Vector3(x0 + size * 1.6, z + textHeight * 0.35, 0), textHeight))
  })
  // Dimension chains on the right: openings (inner), then levels and the top (outer).
  const levelHeights = distinctHeights(
    marks.map((m) => m.z),
    tolerance,
  )
  const inner = distinctHeights([...levelHeights, ...heights.openings.flatMap((o) => [o.sill, o.head])], tolerance)
  const chain = (hs: number[], x: number) => {
    for (let i = 1; i < hs.length; i++) out.push(dimension(hs[i - 1], hs[i], x, textHeight))
  }
  const both = inner.length > levelHeights.length
  if (both) chain(inner, right + textHeight * 3)
  chain(levelHeights, right + textHeight * (both ? 7 : 3))
  return out
}

/** How far marks reach past a drawing on the left and on the right, for spacing drawings apart. */
export function marksReach(heights: HeightsInView, textHeight: number): { left: number; right: number } {
  const longest = Math.max(...heights.levels.map((l) => `${l.name}  +00.00`).map((t) => Math.max(...textShape(t).widths) * textHeight), Math.max(...textShape('+00.00').widths) * textHeight)
  return { left: longest + textHeight * 3, right: textHeight * 9 }
}
