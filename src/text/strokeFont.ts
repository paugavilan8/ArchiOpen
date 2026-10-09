import { SIMPLEX } from './hersheySimplex'

/**
 * Single-stroke text: every character is a few polylines, so text draws, snaps, exports and plots
 * like any other line work. Units here are the cap height: capitals are 1 tall, the baseline of the
 * first line is at y = 0 and y points up.
 */

type Stroke = [number, number][]

interface Glyph {
  strokes: Stroke[]
  advance: number
}

const UNIT = 21
const BASELINE = 22
const SPACE = 16
/** Distance between baselines, in cap heights. */
export const LINE_SPACING = 1.6

function parse(d: string): Stroke[] {
  return d
    .split('M')
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/L/g, ' ')
        .trim()
        .split(/\s+/)
        .map((xy) => xy.split(',').map(Number) as [number, number]),
    )
}

const ascii = new Map<string, Glyph>()
SIMPLEX.forEach(([d, advance], i) => ascii.set(String.fromCharCode(33 + i), { strokes: parse(d), advance }))
ascii.set(' ', { strokes: [], advance: SPACE })

// Marks for the accented letters, in font units, centered on x = 0 and above the x-height (y = 8)
// or the cap line (y = 1).
const dot = (x: number, y: number): Stroke => [[x - 1, y], [x, y + 1], [x + 1, y], [x, y - 1], [x - 1, y]]
const MARKS: Record<string, (top: number) => Stroke[]> = {
  acute: (top) => [[[-1, top - 2], [2, top - 5]]],
  grave: (top) => [[[1, top - 2], [-2, top - 5]]],
  circumflex: (top) => [[[-3, top - 2], [0, top - 5], [3, top - 2]]],
  diaeresis: (top) => [dot(-3, top - 3), dot(3, top - 3)],
  tilde: (top) => [[[-4, top - 2], [-3, top - 4], [-1, top - 4], [1, top - 2], [3, top - 2], [4, top - 4]]],
}

const ACCENTED: Record<string, [string, keyof typeof MARKS]> = {}
const addAccents = (letters: string, bases: string, mark: keyof typeof MARKS) => {
  for (let i = 0; i < letters.length; i++) ACCENTED[letters[i]] = [bases[i], mark]
}
addAccents('áéíóúýÁÉÍÓÚÝ', 'aeiouyAEIOUY', 'acute')
addAccents('àèìòùÀÈÌÒÙ', 'aeiouAEIOU', 'grave')
addAccents('âêîôûÂÊÎÔÛ', 'aeiouAEIOU', 'circumflex')
addAccents('äëïöüÄËÏÖÜ', 'aeiouAEIOU', 'diaeresis')
addAccents('ñãõÑÃÕ', 'naoNAO', 'tilde')

const map = (strokes: Stroke[], f: (p: [number, number]) => [number, number]) => strokes.map((s) => s.map(f))

function accented(base: Glyph, mark: keyof typeof MARKS, upper: boolean): Glyph {
  const center = base.advance / 2
  // The dotless i takes the accent in place of its dot.
  const strokes = upper || base !== ascii.get('i') ? base.strokes : base.strokes.slice(1)
  return { strokes: [...strokes, ...map(MARKS[mark](upper ? 1 : 8), ([x, y]) => [x + center, y])], advance: base.advance }
}

/** Turned upside down about the middle of the x-height, for ¿ and ¡. */
const inverted = (g: Glyph): Glyph => ({ strokes: map(g.strokes, ([x, y]) => [g.advance - x, 30 - y]), advance: g.advance })

function circle(cx: number, cy: number, r: number): Stroke {
  const s: Stroke = []
  for (let i = 0; i <= 12; i++) s.push([cx + r * Math.cos((i * Math.PI) / 6), cy + r * Math.sin((i * Math.PI) / 6)])
  return s
}

/** Smaller and raised, for ² and ³. */
const superscript = (g: Glyph): Glyph => ({
  strokes: map(g.strokes, ([x, y]) => [x * 0.6, 1 + (y - 1) * 0.6]),
  advance: g.advance * 0.6,
})

function special(ch: string): Glyph | null {
  const g = (c: string) => ascii.get(c)!
  switch (ch) {
    case '°':
    case 'º':
      return { strokes: [circle(7, 5, 3.5)], advance: 14 }
    case 'ª':
      return { strokes: [circle(7, 5, 3.5), [[3, 11], [11, 11]]], advance: 14 }
    case 'Ø':
    case 'ø':
    case '⌀': {
      const o = g(ch === 'ø' ? 'o' : 'O')
      const top = ch === 'ø' ? 7 : -1
      return { strokes: [...o.strokes, [[o.advance - 2, top], [2, 23]]], advance: o.advance }
    }
    case '±':
      return { strokes: [[[13, 4], [13, 16]], [[4, 10], [22, 10]], [[4, 20], [22, 20]]], advance: 26 }
    case '×':
      return { strokes: [[[6, 8], [20, 22]], [[20, 8], [6, 22]]], advance: 26 }
    case '¿':
      return inverted(g('?'))
    case '¡':
      return inverted(g('!'))
    case 'ç':
    case 'Ç': {
      const c = g(ch === 'ç' ? 'c' : 'C')
      const x = c.advance / 2
      return { strokes: [...c.strokes, [[x, 22], [x, 24], [x + 2, 25], [x, 27], [x - 2, 27]]], advance: c.advance }
    }
    case '²':
      return superscript(g('2'))
    case '³':
      return superscript(g('3'))
    case '€':
      return {
        strokes: [...g('C').strokes, [[1, 10], [13, 10]], [[1, 14], [12, 14]]],
        advance: g('C').advance,
      }
  }
  const accent = ACCENTED[ch]
  if (accent) return accented(g(accent[0]), accent[1], accent[0] === accent[0].toUpperCase())
  return null
}

const cache = new Map<string, Glyph>()

function glyph(ch: string): Glyph {
  let g = ascii.get(ch) ?? cache.get(ch)
  if (!g) {
    g = special(ch) ?? ascii.get('?')!
    cache.set(ch, g)
  }
  return g
}

export interface TextShape {
  /** Polylines in cap heights, from the left end of the first baseline. */
  strokes: Stroke[]
  /** Width of each line, in cap heights. */
  widths: number[]
}

/** The strokes of a (possibly multi-line) text, every line starting at x = 0. */
export function textShape(text: string): TextShape {
  const strokes: Stroke[] = []
  const widths: number[] = []
  text.split('\n').forEach((line, row) => {
    let x = 0
    const base = -row * LINE_SPACING
    for (const ch of line) {
      const g = glyph(ch)
      for (const s of g.strokes) strokes.push(s.map(([gx, gy]) => [(x + gx) / UNIT, base + (BASELINE - gy) / UNIT]))
      x += g.advance
    }
    widths.push(x / UNIT)
  })
  return { strokes, widths }
}
