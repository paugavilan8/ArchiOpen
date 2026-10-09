import { Vector2, Vector3 } from 'three'
import { textShape } from '../text/strokeFont'
import type { AnnotationGeometry } from './geometry'

/**
 * Layout of texts, dimensions and leaders as plain line work. Everything is computed in the
 * annotation's own plane (2D coordinates along `xaxis` and `yaxis` from the first point) and then
 * placed back in the model, so annotations work in any construction plane.
 */

type Line2 = Vector2[]

const v2 = (x: number, y: number) => new Vector2(x, y)
const TWO_PI = Math.PI * 2

/** The measured value of a dimension, in model units or degrees. */
export function measure(g: AnnotationGeometry): number {
  const p = planar(g)
  switch (g.kind) {
    case 'linear':
    case 'aligned': {
      const { d } = linearAxes(g, p)
      return Math.abs(p[1].clone().sub(p[0]).dot(d))
    }
    case 'radius':
      return p[1].distanceTo(p[0])
    case 'diameter':
      return 2 * p[1].distanceTo(p[0])
    case 'angle':
      return (angleSweep(p).sweep * 180) / Math.PI
    default:
      return 0
  }
}

const PREFIX: Partial<Record<AnnotationGeometry['kind'], string>> = { radius: 'R', diameter: 'Ø' }

/** The text shown: the user's text, where `<>` stands for the measured value. */
export function displayText(g: AnnotationGeometry): string {
  if (g.kind === 'text' || g.kind === 'leader') return g.text
  const value = `${PREFIX[g.kind] ?? ''}${measure(g).toFixed(g.precision)}${g.kind === 'angle' ? '°' : ''}`
  return (g.text || '<>').replace(/<>/g, value)
}

/** The defining points in plane coordinates. */
function planar(g: AnnotationGeometry): Vector2[] {
  const o = g.points[0]
  return g.points.map((p) => {
    const d = p.clone().sub(o)
    return v2(d.dot(g.xaxis), d.dot(g.yaxis))
  })
}

/** Direction measured by a linear dimension, and the perpendicular towards its dimension line. */
function linearAxes(g: AnnotationGeometry, p: Vector2[]): { d: Vector2; e: Vector2 } {
  let d = v2(1, 0)
  if (g.kind === 'aligned') {
    const span = p[1].clone().sub(p[0])
    if (span.length() > 1e-12) d = span.normalize()
  }
  return { d, e: v2(-d.y, d.x) }
}

/** Start angle and sweep of an angle dimension: the sector between the two rays that holds the arc point. */
function angleSweep(p: Vector2[]): { start: number; sweep: number; radius: number } {
  const [vertex, a, b, q] = p
  const angle = (x: Vector2) => Math.atan2(x.y - vertex.y, x.x - vertex.x)
  const ccw = (from: number, to: number) => (((to - from) % TWO_PI) + TWO_PI) % TWO_PI
  const a1 = angle(a)
  const a2 = angle(b)
  const sweep = ccw(a1, a2)
  const radius = q.distanceTo(vertex)
  return ccw(a1, angle(q)) <= sweep ? { start: a1, sweep, radius } : { start: a2, sweep: TWO_PI - sweep, radius }
}

/**
 * Text strokes placed at `at` and running along `dir`. `h` (0 left, 1 right) and `v` (0 last
 * baseline, 1 top) say which point of the text block sits at `at`. Text is turned so that it never
 * reads upside down.
 */
function placeText(text: string, at: Vector2, dir: Vector2, height: number, h: number, v: number): Line2[] {
  let x = dir.clone().normalize()
  if (x.x < -1e-9 || (Math.abs(x.x) <= 1e-9 && x.y < 0)) x = x.negate()
  const y = v2(-x.y, x.x)
  const { strokes, widths } = textShape(text)
  const width = Math.max(0, ...widths)
  // The block spans from the top of the first line to the baseline of the last.
  const top = 1
  const bottom = -(widths.length - 1) * 1.6
  const ox = -h * width
  const oy = -(bottom + v * (top - bottom))
  return strokes.map((s) => s.map(([sx, sy]) => at.clone().addScaledVector(x, (sx + ox) * height).addScaledVector(y, (sy + oy) * height)))
}

/** An arrowhead with its tip at `tip`, its body along `back` (unit). */
function arrowhead(g: AnnotationGeometry, tip: Vector2, back: Vector2): Line2[] {
  const size = g.height
  if (g.arrow === 'tick') {
    // An architectural tick: a short slash across the line.
    const slash = back.clone().add(v2(-back.y, back.x)).normalize().multiplyScalar(size * 0.5)
    return [[tip.clone().sub(slash), tip.clone().add(slash)]]
  }
  const side = v2(-back.y, back.x).multiplyScalar(size / 6)
  const base = tip.clone().addScaledVector(back, size)
  return [[tip, base.clone().add(side), base.clone().sub(side), tip.clone()]]
}

function linearLayout(g: AnnotationGeometry, p: Vector2[], text: string): Line2[] {
  const [p1, p2, p3] = p
  const { d, e } = linearAxes(g, p)
  const s = p3.dot(e)
  const a = p1.clone().addScaledVector(e, s - p1.dot(e))
  const b = p2.clone().addScaledVector(e, s - p2.dot(e))
  const gap = g.height * 0.5
  const lines: Line2[] = []
  // Extension lines, from just off the measured points to just past the dimension line.
  for (const [from, to] of [[p1, a], [p2, b]]) {
    const out = to.clone().sub(from)
    if (out.length() <= gap) continue
    const u = out.clone().normalize()
    lines.push([from.clone().addScaledVector(u, gap), to.clone().addScaledVector(u, gap)])
  }
  const span = b.clone().sub(a)
  const length = span.length()
  const u = length > 1e-12 ? span.clone().normalize() : d.clone()
  // Arrows go inside when they fit, outside otherwise.
  const inside = g.arrow === 'tick' || length > g.height * 2.5
  if (inside) {
    lines.push([a, b])
    lines.push(...arrowhead(g, a, u), ...arrowhead(g, b, u.clone().negate()))
  } else {
    lines.push([a.clone().addScaledVector(u, -g.height * 2), b.clone().addScaledVector(u, g.height * 2)])
    lines.push(...arrowhead(g, a, u.clone().negate()), ...arrowhead(g, b, u))
  }
  // Text centered above the dimension line, as read (see placeText).
  const mid = a.clone().add(b).multiplyScalar(0.5)
  let up = v2(-u.y, u.x)
  if (u.x < -1e-9 || (Math.abs(u.x) <= 1e-9 && u.y < 0)) up = up.negate()
  lines.push(...placeText(text, mid.addScaledVector(up, g.height * 0.4), u, g.height, 0.5, 0))
  return lines
}

/** A short horizontal landing at the end of a leader line, then the text. */
function landing(g: AnnotationGeometry, end: Vector2, from: Vector2, text: string): Line2[] {
  const sign = end.x >= from.x ? 1 : -1
  const tail = end.clone().add(v2(sign * g.height, 0))
  const at = tail.clone().add(v2(sign * g.height * 0.4, 0))
  return [[end, tail], ...placeText(text, at, v2(1, 0), g.height, sign > 0 ? 0 : 1, 0.5)]
}

function radialLayout(g: AnnotationGeometry, p: Vector2[], text: string): Line2[] {
  const [c, onCircle, at] = p
  const r = onCircle.distanceTo(c)
  let u = at.clone().sub(c)
  if (u.length() < 1e-12) u = onCircle.clone().sub(c)
  u.normalize()
  const tip = c.clone().addScaledVector(u, r)
  const outside = at.distanceTo(c) > r
  const lines: Line2[] = []
  if (g.kind === 'diameter') {
    const opposite = c.clone().addScaledVector(u, -r)
    lines.push([opposite, outside ? at : tip], ...arrowhead(g, tip, u.clone().negate()), ...arrowhead(g, opposite, u))
  } else {
    lines.push(outside ? [tip, at] : [c, tip], ...arrowhead(g, tip, outside ? u : u.clone().negate()))
  }
  lines.push(...landing(g, at, c, text))
  return lines
}

function angleLayout(g: AnnotationGeometry, p: Vector2[], text: string): Line2[] {
  const [vertex] = p
  const { start, sweep, radius } = angleSweep(p)
  const at = (t: number, r = radius) => vertex.clone().add(v2(Math.cos(t) * r, Math.sin(t) * r))
  const arc: Line2 = []
  const count = Math.max(8, Math.ceil((64 * sweep) / TWO_PI))
  for (let i = 0; i <= count; i++) arc.push(at(start + (sweep * i) / count))
  const lines: Line2[] = [arc]
  // Extension lines along the rays when the arc lies beyond the picked points.
  const gap = g.height * 0.5
  for (const [t, ray] of [[start, p[1]], [start + sweep, p[2]]] as [number, Vector2][]) {
    const reach = ray.distanceTo(vertex)
    if (radius > reach + gap) lines.push([at(t, reach + gap), at(t, radius + gap)])
  }
  const tangent = (t: number) => v2(-Math.sin(t), Math.cos(t))
  lines.push(...arrowhead(g, at(start), tangent(start)), ...arrowhead(g, at(start + sweep), tangent(start + sweep).negate()))
  const mid = start + sweep / 2
  lines.push(...placeText(text, at(mid, radius + g.height * 0.4), tangent(mid).negate(), g.height, 0.5, 0))
  return lines
}

function leaderLayout(g: AnnotationGeometry, p: Vector2[]): Line2[] {
  const lines: Line2[] = [p]
  if (p.length < 2) return lines
  lines.push(...arrowhead(g, p[0], p[1].clone().sub(p[0]).normalize()))
  if (g.text) lines.push(...landing(g, p[p.length - 1], p[p.length - 2], g.text))
  return lines
}

/** The line work that draws an annotation, in model coordinates. */
export function annotationLines(g: AnnotationGeometry): Vector3[][] {
  const p = planar(g)
  const text = displayText(g)
  let lines: Line2[]
  switch (g.kind) {
    case 'text':
      lines = placeText(g.text, p[0], v2(1, 0), g.height, 0, 0)
      break
    case 'linear':
    case 'aligned':
      lines = linearLayout(g, p, text)
      break
    case 'radius':
    case 'diameter':
      lines = radialLayout(g, p, text)
      break
    case 'angle':
      lines = angleLayout(g, p, text)
      break
    case 'leader':
      lines = leaderLayout(g, p)
      break
  }
  const o = g.points[0]
  return lines.map((line) => line.map((q) => o.clone().addScaledVector(g.xaxis, q.x).addScaledVector(g.yaxis, q.y)))
}
