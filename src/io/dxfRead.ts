import { Matrix4, Vector3 } from 'three'
import { closestPoint, subCurve, transform } from '../core/curves'
import { ellipse } from '../core/curveTools'
import type { Layer } from '../core/document'
import type { AnnotationGeometry, AnyCurve, BlockDefinition, BlockObject, Geometry, MeshGeometry, SegmentGeometry } from '../core/geometry'
import { joinMeshes, makeMesh, weldMesh } from '../core/mesh'
import { LINETYPE_NAMES, PRINT_WIDTHS } from '../core/linetypes'
import { evalBSpline, interpolate } from '../math/nurbs'
import { textShape, LINE_SPACING } from '../text/strokeFont'
import { aciToHex } from './dxf'
import type { RhinoImport } from './rhino3dm'

/**
 * Reads ASCII DXF files (R12 to 2018) into model geometry: layers with their color, linetype,
 * lineweight and state; lines, polylines (with arcs), circles, arcs, ellipses, splines, texts,
 * dimensions, leaders, hatches, solids and 3D faces, in model space. Block references are exploded
 * into their contents. The result has the same shape as a .3dm import, so it merges the same way.
 */

type Pair = [number, string]

interface Rec {
  type: string
  pairs: Pair[]
  /** Vertices of an old-style POLYLINE, or attributes of an INSERT. */
  children: Rec[]
}

interface Block {
  name: string
  base: Vector3
  entities: Rec[]
}

interface DimStyle {
  height: number
  precision: number
  tick: boolean
}

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const Z = v(0, 0, 1)
const DEG = Math.PI / 180

// --- Low level -------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 22))
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error('Binary DXF files are not supported; save the drawing as ASCII DXF')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Files before AutoCAD 2007 are usually in the Windows code page.
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/)
  const pairs: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) continue
    pairs.push([code, lines[i + 1].replace(/\r$/, '')])
  }
  return pairs
}

const get = (r: Rec, code: number): string | undefined => r.pairs.find((p) => p[0] === code)?.[1]
const str = (r: Rec, code: number, fallback = ''): string => get(r, code)?.trim() ?? fallback
function num(r: Rec, code: number, fallback = 0): number {
  const value = get(r, code)
  const n = value === undefined ? NaN : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}
const point = (r: Rec, base: number, fallback = v(0, 0)): Vector3 =>
  get(r, base) === undefined ? fallback.clone() : v(num(r, base), num(r, base + 10), num(r, base + 20))

/** The axes of an entity's object coordinate system, from its extrusion direction (arbitrary axis algorithm). */
function ocs(r: Rec): { ax: Vector3; ay: Vector3; n: Vector3 } {
  const n = point(r, 210, Z).normalize()
  if (n.lengthSq() === 0) n.copy(Z)
  const ax = Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64 ? v(0, 1, 0).cross(n) : Z.clone().cross(n)
  ax.normalize()
  const ay = n.clone().cross(ax).normalize()
  return { ax, ay, n }
}

const toWcs = (o: ReturnType<typeof ocs>, p: Vector3) =>
  o.ax.clone().multiplyScalar(p.x).addScaledVector(o.ay, p.y).addScaledVector(o.n, p.z)

/** Splits the pairs into records, each starting at a code 0. */
function records(pairs: Pair[], from: number, until: (type: string) => boolean): { recs: Rec[]; end: number } {
  const recs: Rec[] = []
  let i = from
  while (i < pairs.length) {
    const [code, value] = pairs[i]
    if (code !== 0) {
      i++
      continue
    }
    const type = value.trim()
    if (until(type)) return { recs, end: i }
    const rec: Rec = { type, pairs: [], children: [] }
    i++
    while (i < pairs.length && pairs[i][0] !== 0) rec.pairs.push(pairs[i++])
    recs.push(rec)
  }
  return { recs, end: i }
}

/** Attaches VERTEX and ATTRIB records to the POLYLINE or INSERT they follow. */
function nest(recs: Rec[]): Rec[] {
  const out: Rec[] = []
  let owner: Rec | null = null
  for (const rec of recs) {
    if (owner && (rec.type === 'VERTEX' || rec.type === 'ATTRIB')) {
      owner.children.push(rec)
      continue
    }
    if (rec.type === 'SEQEND') {
      owner = null
      continue
    }
    owner = rec.type === 'POLYLINE' || (rec.type === 'INSERT' && num(rec, 66) === 1) ? rec : null
    out.push(rec)
  }
  return out
}

// --- Text ----------------------------------------------------------------------------

/** Control codes of single-line text: %%c, %%d and %%p, and \U+XXXX characters. */
function plainText(text: string): string {
  return text
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%')
}

/** MTEXT without its formatting codes; \P becomes a line break. */
export function mtextPlain(text: string): string {
  return plainText(
    text
      .replace(/\\\\/g, '\u0000')
      .replace(/\\[Pp]/g, '\n')
      .replace(/\\~/g, ' ')
      .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
      .replace(/\\[fFhHwWqQtTaAcCpP][^;]*;/g, '')
      .replace(/\\[lLoOkKnN]/g, '')
      .replace(/\\([{}])/g, '\u0001$1')
      .replace(/[{}]/g, '')
      .replace(/\u0001/g, '')
      .replace(/\u0000/g, '\\'),
  )
}

function textAnnotation(at: Vector3, xaxis: Vector3, normal: Vector3, text: string, height: number): AnnotationGeometry {
  return {
    type: 'annotation',
    kind: 'text',
    points: [at],
    xaxis: xaxis.clone().normalize(),
    yaxis: normal.clone().cross(xaxis).normalize(),
    text,
    height,
    arrow: 'arrow',
    precision: 2,
  }
}

// --- Curves ----------------------------------------------------------------------------

/** Arc from p1 to p2 with a polyline bulge (tan of a quarter of the angle; positive turns counterclockwise). */
function bulgeArc(p1: Vector3, p2: Vector3, bulge: number, n: Vector3): SegmentGeometry {
  const chord = p2.clone().sub(p1)
  const c = chord.length()
  const theta = 4 * Math.atan(Math.abs(bulge))
  const r = c / (2 * Math.sin(theta / 2))
  const s = (Math.abs(bulge) * c) / 2
  const left = n.clone().cross(chord).normalize()
  const side = bulge > 0 ? 1 : -1
  const center = p1.clone().add(p2).multiplyScalar(0.5).addScaledVector(left, side * (r - s))
  const xaxis = p1.clone().sub(center).normalize()
  const yaxis = n.clone().cross(xaxis).multiplyScalar(side).normalize()
  return { type: 'arc', center, xaxis, yaxis, radius: r, angle: theta }
}

/** A polyline with optional bulges: a plain polyline when every segment is straight. */
function bulgedPolyline(points: Vector3[], bulges: number[], closed: boolean, n: Vector3): AnyCurve | null {
  if (points.length < 2) return null
  if (!bulges.some((b) => Math.abs(b) > 1e-12)) return { type: 'polyline', points, closed: closed && points.length > 2 }
  const segments: SegmentGeometry[] = []
  const count = closed ? points.length : points.length - 1
  let run: Vector3[] = []
  for (let i = 0; i < count; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (a.distanceTo(b) < 1e-12) continue
    if (Math.abs(bulges[i] ?? 0) > 1e-12) {
      if (run.length > 1) segments.push({ type: 'polyline', points: run, closed: false })
      run = []
      segments.push(bulgeArc(a, b, bulges[i], n))
    } else {
      if (run.length === 0) run.push(a)
      run.push(b)
    }
  }
  if (run.length > 1) segments.push({ type: 'polyline', points: run, closed: false })
  return segments.length === 1 && segments[0].type !== 'polyline' ? segments[0] : { type: 'polycurve', segments }
}

/** A smooth curve through samples of a parametric curve. */
function sampled(at: (t: number) => Vector3, t0: number, t1: number, count: number): AnyCurve {
  const pts: Vector3[] = []
  for (let i = 0; i <= count; i++) pts.push(at(t0 + ((t1 - t0) * i) / count))
  return { type: 'curve', ...interpolate(pts, 3) }
}

function ellipseCurve(center: Vector3, major: Vector3, ratio: number, n: Vector3, u0: number, u1: number): AnyCurve {
  while (u1 <= u0 + 1e-12) u1 += Math.PI * 2
  const minor = n.clone().cross(major).multiplyScalar(ratio)
  const full = u1 - u0 >= Math.PI * 2 - 1e-9
  const r = major.length()
  if (Math.abs(ratio - 1) < 1e-9) {
    const xaxis = major.clone().normalize().multiplyScalar(Math.cos(u0)).addScaledVector(minor.clone().normalize(), Math.sin(u0))
    const yaxis = n.clone().cross(xaxis).normalize()
    if (full) return { type: 'circle', center, xaxis, yaxis, radius: r }
    return { type: 'arc', center, xaxis, yaxis, radius: r, angle: u1 - u0 }
  }
  // An exact (rational) ellipse; an elliptical arc is the piece between its end points.
  const exact = ellipse(center, major.clone().normalize(), minor.clone().normalize(), r, major.length() * ratio)
  if (full) return exact
  const at = (u: number) => center.clone().addScaledVector(major, Math.cos(u)).addScaledVector(minor, Math.sin(u))
  const piece = subCurve(exact, closestPoint(exact, at(u0)).t, closestPoint(exact, at(u1)).t)
  return piece ?? sampled(at, u0, u1, Math.max(16, Math.ceil((96 * (u1 - u0)) / (Math.PI * 2))))
}

/** A NURBS curve from control points, knots and weights; exact when it is clamped and not rational. */
function splineCurve(degree: number, ctrl: Vector3[], knots: number[], weights: number[], fit: Vector3[]): AnyCurve | null {
  if (ctrl.length < 2 || knots.length !== ctrl.length + degree + 1) {
    return fit.length >= 2 ? { type: 'curve', ...interpolate(fit, 3) } : null
  }
  const rational = weights.length === ctrl.length && weights.some((w) => Math.abs(w - weights[0]) > 1e-12)
  const clamped =
    knots.slice(0, degree + 1).every((k) => k === knots[0]) && knots.slice(-degree - 1).every((k) => k === knots[knots.length - 1])
  // Clamped curves come through exactly, rational ones (ellipses, conics) with their weights.
  if (clamped) return { type: 'curve', degree, points: ctrl, knots, ...(rational ? { weights } : {}) }
  const w = weights.length === ctrl.length ? weights : ctrl.map(() => 1)
  const numer = ctrl.map((p, i) => p.clone().multiplyScalar(w[i]))
  const denom = w.map((x) => v(x, 0))
  const at = (t: number) => evalBSpline(numer, degree, knots, t).divideScalar(evalBSpline(denom, degree, knots, t).x)
  return sampled(at, knots[degree], knots[ctrl.length], Math.max(32, ctrl.length * 8))
}

// --- Hatches ---------------------------------------------------------------------------

/** AutoCAD patterns mapped to ArchiOpen ones, with the size of their spacing at scale 1. */
const PATTERNS: Record<string, [string, number]> = {
  SOLID: ['Solid', 1],
  ANSI31: ['Lines', 3.175],
  ANSI32: ['Lines', 3.175],
  ANSI33: ['Lines', 3.175],
  ANSI37: ['Cross', 3.175],
  ANSI38: ['Cross', 3.175],
  NET: ['Grid', 3.175],
  NET3: ['Grid', 3.175],
  SQUARE: ['Grid', 3.175],
  BRICK: ['Brick', 6.35],
  'AR-B816': ['Brick', 203.2],
  'AR-B88': ['Brick', 203.2],
  'AR-BRSTD': ['Brick', 67.7],
  DASH: ['Dashes', 3.175],
}

/** Walks a record's pairs in order, for entities whose codes repeat (hatch boundaries, polylines). */
class Cursor {
  i = 0
  constructor(private readonly pairs: Pair[]) {}
  /** The value of the next pair with this code, skipping others; undefined at the end. */
  take(code: number): string | undefined {
    while (this.i < this.pairs.length) {
      const [c, value] = this.pairs[this.i++]
      if (c === code) return value
    }
    return undefined
  }
  num(code: number): number {
    return parseFloat(this.take(code) ?? '0')
  }
  peek(): number | undefined {
    return this.pairs[this.i]?.[0]
  }
}

function hatchLoops(r: Rec): AnyCurve[] {
  const c = new Cursor(r.pairs)
  const pathCount = c.num(91)
  const loops: AnyCurve[] = []
  for (let p = 0; p < pathCount; p++) {
    const flags = c.num(92)
    if (flags & 2) {
      const hasBulge = c.num(72) !== 0
      c.num(73)
      const count = c.num(93)
      const pts: Vector3[] = []
      const bulges: number[] = []
      for (let k = 0; k < count; k++) {
        pts.push(v(c.num(10), c.num(20)))
        bulges.push(hasBulge ? c.num(42) : 0)
      }
      const loop = bulgedPolyline(pts, bulges, true, Z)
      if (loop) loops.push(loop)
    } else {
      const count = c.num(93)
      const segments: SegmentGeometry[] = []
      for (let k = 0; k < count; k++) {
        const kind = c.num(72)
        if (kind === 1) {
          segments.push({ type: 'polyline', points: [v(c.num(10), c.num(20)), v(c.num(11), c.num(21))], closed: false })
        } else if (kind === 2) {
          const center = v(c.num(10), c.num(20))
          const radius = c.num(40)
          let a0 = c.num(50) * DEG
          let a1 = c.num(51) * DEG
          const ccw = c.num(73) !== 0
          // Clockwise arcs are stored with their angles mirrored.
          if (!ccw) [a0, a1] = [-a0, -a1]
          let sweep = ccw ? a1 - a0 : a0 - a1
          while (sweep <= 1e-12) sweep += Math.PI * 2
          const xaxis = v(Math.cos(a0), Math.sin(a0))
          const yaxis = Z.clone().cross(xaxis).multiplyScalar(ccw ? 1 : -1)
          segments.push({ type: 'arc', center, xaxis, yaxis, radius, angle: Math.min(sweep, Math.PI * 2) })
        } else if (kind === 3) {
          const center = v(c.num(10), c.num(20))
          const major = v(c.num(11), c.num(21))
          const ratio = c.num(40)
          let u0 = c.num(50) * DEG
          let u1 = c.num(51) * DEG
          const ccw = c.num(73) !== 0
          if (!ccw) [u0, u1] = [-u0, -u1]
          const curve = ccw ? ellipseCurve(center, major, ratio, Z, u0, u1) : ellipseCurve(center, major, ratio, Z.clone().negate(), -u0, -u1)
          segments.push(...asSegments(curve))
        } else if (kind === 4) {
          const degree = c.num(94)
          const rational = c.num(73) !== 0
          c.num(74)
          const nk = c.num(95)
          const nc = c.num(96)
          const knots: number[] = []
          for (let j = 0; j < nk; j++) knots.push(c.num(40))
          const ctrl: Vector3[] = []
          const weights: number[] = []
          for (let j = 0; j < nc; j++) {
            ctrl.push(v(c.num(10), c.num(20)))
            if (rational) weights.push(c.num(42))
          }
          const curve = splineCurve(degree, ctrl, knots, weights, [])
          if (curve) segments.push(...asSegments(curve))
        } else {
          break
        }
      }
      if (segments.length > 0) loops.push(segments.length === 1 && segments[0].type !== 'polyline' ? segments[0] : { type: 'polycurve', segments })
    }
    // Skip the references to boundary objects.
    const refs = c.peek() === 97 ? c.num(97) : 0
    for (let k = 0; k < refs; k++) c.take(330)
  }
  return loops
}

function asSegments(g: AnyCurve): SegmentGeometry[] {
  if (g.type === 'polycurve') return g.segments
  if (g.type === 'circle') return [{ type: 'arc', center: g.center, xaxis: g.xaxis, yaxis: g.yaxis, radius: g.radius, angle: Math.PI * 2 }]
  return [g]
}

// --- Reader ----------------------------------------------------------------------------

const INSUNITS: Record<number, string> = { 1: 'Inches', 2: 'Feet', 3: 'Miles', 4: 'Millimeters', 5: 'Centimeters', 6: 'Meters', 7: 'Kilometers', 10: 'Yards', 13: 'Microns', 14: 'Decimeters' }

function linetypeOf(name: string): string {
  const n = name.toUpperCase()
  const known = LINETYPE_NAMES.find((t) => t.toUpperCase() === n)
  if (known) return known
  if (n.startsWith('HIDDEN')) return 'Hidden'
  if (n.startsWith('CENTER') || n.startsWith('PHANTOM')) return 'Center'
  if (n.startsWith('DASHDOT')) return 'DashDot'
  if (n.startsWith('DOT')) return 'Dots'
  if (n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK' || n === '') return 'Continuous'
  return 'Dashed'
}

/** The nearest offered print width for a lineweight in hundredths of a millimeter. */
function widthOf(lineweight: number): number {
  if (lineweight <= 0) return 0
  const mm = lineweight / 100
  return PRINT_WIDTHS.filter((w) => w > 0).reduce((best, w) => (Math.abs(w - mm) < Math.abs(best - mm) ? w : best))
}

const SKIP_SILENTLY = new Set(['VIEWPORT', 'ATTDEF', 'SEQEND', 'ENDBLK', 'BLOCK', 'XLINE', 'RAY', 'DICTIONARY'])
const SKIPPED_NAMES: Record<string, [string, string]> = {
  POINT: ['point', 'points'],
  MLINE: ['multiline', 'multilines'],
  MULTILEADER: ['multileader', 'multileaders'],
  '3DSOLID': ['3D solid', '3D solids'],
  REGION: ['region', 'regions'],
  BODY: ['body', 'bodies'],
  SURFACE: ['surface', 'surfaces'],
  MESH: ['mesh', 'meshes'],
  POLYMESH: ['polygon mesh', 'polygon meshes'],
  IMAGE: ['image', 'images'],
  WIPEOUT: ['wipeout', 'wipeouts'],
  ACAD_TABLE: ['table', 'tables'],
}

export function readDxf(bytes: Uint8Array, fallbackUnits: string): RhinoImport {
  const pairs = readPairs(decode(bytes))
  const header = new Map<string, string>()
  const layers: Omit<Layer, 'id'>[] = []
  const layerIndex = new Map<string, number>()
  const dimStyles = new Map<string, DimStyle>()
  const blocks = new Map<string, Block>()
  let entities: Rec[] = []

  // Sections.
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] !== 0 || pairs[i][1].trim() !== 'SECTION') continue
    const name = pairs[i + 1]?.[1].trim()
    const { recs, end } = records(pairs, i + 2, (t) => t === 'ENDSEC')
    if (name === 'HEADER') {
      // Header variables are one record: 9 $NAME, then its value codes.
      const start = i + 2
      for (let j = start; j < end; j++) if (pairs[j][0] === 9 && pairs[j + 1]) header.set(pairs[j][1].trim(), pairs[j + 1][1].trim())
    } else if (name === 'TABLES') {
      for (const r of recs) {
        if (r.type === 'LAYER') {
          const layerName = str(r, 2, '0')
          const color = num(r, 62, 7)
          const flags = num(r, 70)
          const trueColor = get(r, 420)
          layerIndex.set(layerName.toUpperCase(), layers.length)
          layers.push({
            name: layerName,
            color: trueColor ? `#${(parseInt(trueColor, 10) & 0xffffff).toString(16).padStart(6, '0')}` : aciToHex(color),
            visible: color >= 0 && !(flags & 1),
            locked: !!(flags & 4),
            linetype: linetypeOf(str(r, 6, 'CONTINUOUS')),
            printWidth: widthOf(num(r, 370, -3)),
          })
        } else if (r.type === 'DIMSTYLE') {
          const scale = num(r, 40, 1) || 1
          dimStyles.set(str(r, 2).toUpperCase(), { height: num(r, 140, 2.5) * scale, precision: num(r, 271, 2), tick: num(r, 142) > 0 })
        }
      }
    } else if (name === 'BLOCKS') {
      let current: Block | null = null
      let body: Rec[] = []
      for (const r of recs) {
        if (r.type === 'BLOCK') {
          current = { name: str(r, 2), base: point(r, 10), entities: [] }
          body = []
          blocks.set(str(r, 2).toUpperCase(), current)
        } else if (r.type === 'ENDBLK') {
          if (current) current.entities = nest(body)
          current = null
        } else if (current) {
          body.push(r)
        }
      }
    } else if (name === 'ENTITIES') {
      entities = nest(recs)
    }
    i = end
  }

  const units = INSUNITS[parseInt(header.get('$INSUNITS') ?? '0', 10)] ?? fallbackUnits
  const objects: RhinoImport['objects'] = []
  const skipped = new Map<string, number>()
  const skip = (type: string): void => {
    skipped.set(type, (skipped.get(type) ?? 0) + 1)
  }

  const layerOf = (name: string): number => {
    const key = (name || '0').toUpperCase()
    let index = layerIndex.get(key)
    if (index === undefined) {
      index = layers.length
      layerIndex.set(key, index)
      layers.push({ name: name || '0', color: '#000000', visible: true, locked: false })
    }
    return index
  }
  const defaultStyle = dimStyles.get('STANDARD') ?? dimStyles.get('ISO-25') ?? { height: 2.5, precision: 2, tick: false }
  const styleOf = (r: Rec) => dimStyles.get(str(r, 3).toUpperCase()) ?? defaultStyle

  type Emit = (g: Geometry, layerName: string) => void
  const toModel: Emit = (g, layerName) => objects.push({ layer: layerOf(layerName), geometry: g })

  // Block definitions, converted the first time a reference needs them.
  const definitions = new Map<string, BlockDefinition | null>()
  const definitionOf = (key: string, depth: number): BlockDefinition | null => {
    if (definitions.has(key)) return definitions.get(key)!
    const block = blocks.get(key)
    if (!block || depth > 16) return null
    definitions.set(key, null) // A block that refers to itself gets nothing.
    const toBase = new Matrix4().makeTranslation(-block.base.x, -block.base.y, -block.base.z)
    const objects: BlockObject[] = []
    for (const child of block.entities) add(child, (g, layerName) => objects.push({ layerId: layerOf(layerName), geometry: transform(g, toBase) }), depth + 1)
    const definition = { name: block.name, objects: joinFaces(objects, (o) => o.layerId) }
    definitions.set(key, definition)
    return definition
  }

  /** Converts an entity and hands the result (geometry and layer name) to `emit`. */
  const add = (r: Rec, emit: Emit, depth: number): void => {
    if (num(r, 67) === 1) return // Paper space.
    const layerName = str(r, 8, '0')
    const out = (g: Geometry | null) => {
      if (g) emit(g, layerName)
    }

    if (r.type === 'INSERT') {
      // Block references stay blocks; MINSERT grids make one reference per cell.
      const definition = definitionOf(str(r, 2).toUpperCase(), depth)
      for (const attrib of r.children) if (!(num(attrib, 70) & 1)) add({ ...attrib, type: 'TEXT' }, emit, depth)
      if (!definition || definition.objects.length === 0) return
      const o = ocs(r)
      const basis = new Matrix4().makeBasis(o.ax, o.ay, o.n)
      const at = point(r, 10)
      const sx = num(r, 41, 1) || 1
      // Without a Z scale, 2D blocks scale uniformly, so their circles stay circles.
      const scale = v(sx, num(r, 42, 1) || 1, get(r, 43) === undefined ? Math.abs(sx) : num(r, 43, 1) || 1)
      const rotation = new Matrix4().makeRotationZ(num(r, 50) * DEG)
      const cols = Math.max(1, num(r, 70, 1))
      const rows = Math.max(1, num(r, 71, 1))
      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          const local = basis
            .clone()
            .multiply(new Matrix4().makeTranslation(at.x, at.y, at.z))
            .multiply(rotation)
            .multiply(new Matrix4().makeTranslation(ci * num(r, 44), ri * num(r, 45), 0))
            .multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z))
          out({ type: 'instance', definition, matrix: local.toArray() })
        }
      }
      return
    }

    switch (r.type) {
      case 'LINE': {
        const a = point(r, 10)
        const b = point(r, 11)
        if (a.distanceTo(b) > 1e-12) out({ type: 'polyline', points: [a, b], closed: false })
        return
      }
      case 'LWPOLYLINE': {
        const o = ocs(r)
        const z = num(r, 38)
        const pts: Vector3[] = []
        const bulges: number[] = []
        const c = new Cursor(r.pairs)
        for (let x = c.take(10); x !== undefined; x = c.take(10)) {
          const y = parseFloat(c.take(20) ?? '0')
          pts.push(v(parseFloat(x), y, z))
          bulges.push(0)
          // Optional widths and bulge before the next vertex.
          while (c.peek() !== undefined && c.peek() !== 10) {
            const [code, value] = r.pairs[c.i++]
            if (code === 42) bulges[bulges.length - 1] = parseFloat(value)
          }
        }
        const curve = bulgedPolyline(pts, bulges, !!(num(r, 70) & 1), Z)
        out(curve && transform(curve, new Matrix4().makeBasis(o.ax, o.ay, o.n)))
        return
      }
      case 'POLYLINE': {
        const flags = num(r, 70)
        if (flags & (16 | 64)) {
          skip('POLYMESH')
          return
        }
        const vertices = r.children.filter((c) => !(num(c, 70) & 16))
        const three = !!(flags & 8)
        const o = ocs(r)
        const z = point(r, 10).z
        const pts = vertices.map((c) => (three ? point(c, 10) : v(num(c, 10), num(c, 20), z)))
        const curve = bulgedPolyline(pts, three ? [] : vertices.map((c) => num(c, 42)), !!(flags & 1), Z)
        out(curve && (three ? curve : transform(curve, new Matrix4().makeBasis(o.ax, o.ay, o.n))))
        return
      }
      case 'CIRCLE':
      case 'ARC': {
        const o = ocs(r)
        const center = toWcs(o, point(r, 10))
        const radius = num(r, 40)
        if (radius <= 0) return
        if (r.type === 'CIRCLE') return out({ type: 'circle', center, xaxis: o.ax, yaxis: o.ay, radius })
        const a0 = num(r, 50) * DEG
        let sweep = num(r, 51) * DEG - a0
        while (sweep <= 1e-12) sweep += Math.PI * 2
        const xaxis = o.ax.clone().multiplyScalar(Math.cos(a0)).addScaledVector(o.ay, Math.sin(a0))
        return out({ type: 'arc', center, xaxis, yaxis: o.n.clone().cross(xaxis), radius, angle: sweep })
      }
      case 'ELLIPSE':
        return out(ellipseCurve(point(r, 10), point(r, 11), num(r, 40, 1), point(r, 210, Z).normalize(), num(r, 41), num(r, 42, Math.PI * 2)))
      case 'SPLINE':
      case 'HELIX': {
        const c = new Cursor(r.pairs)
        const knots: number[] = []
        const weights: number[] = []
        const ctrl: Vector3[] = []
        const fit: Vector3[] = []
        for (const [code, value] of r.pairs) {
          if (code === 40) knots.push(parseFloat(value))
          else if (code === 41) weights.push(parseFloat(value))
        }
        for (let x = c.take(10); x !== undefined; x = c.take(10)) ctrl.push(v(parseFloat(x), parseFloat(c.take(20) ?? '0'), parseFloat(c.take(30) ?? '0')))
        const f = new Cursor(r.pairs)
        for (let x = f.take(11); x !== undefined; x = f.take(11)) fit.push(v(parseFloat(x), parseFloat(f.take(21) ?? '0'), parseFloat(f.take(31) ?? '0')))
        return out(splineCurve(num(r, 71, 3), ctrl, knots, weights, fit))
      }
      case 'TEXT':
      case 'ATTRIB': {
        const text = plainText(get(r, 1) ?? '')
        if (!text.trim()) return
        const o = ocs(r)
        const h = num(r, 40, 2.5) || 2.5
        const angle = num(r, 50) * DEG
        const x = o.ax.clone().multiplyScalar(Math.cos(angle)).addScaledVector(o.ay, Math.sin(angle))
        const y = o.n.clone().cross(x)
        const hAlign = num(r, 72)
        const vAlign = num(r, 73)
        const aligned = (hAlign !== 0 && hAlign !== 3 && hAlign !== 5) || vAlign !== 0
        const anchor = toWcs(o, aligned ? point(r, 11) : point(r, 10))
        const width = textShape(text).widths[0] * h
        const dx = hAlign === 1 || hAlign === 4 ? -width / 2 : hAlign === 2 ? -width : 0
        const dy = vAlign === 2 || hAlign === 4 ? -h / 2 : vAlign === 3 ? -h : 0
        return out(textAnnotation(anchor.addScaledVector(x, dx).addScaledVector(y, dy), x, o.n, text, h))
      }
      case 'MTEXT': {
        const raw = r.pairs.filter(([code]) => code === 3).map(([, value]) => value).join('') + (get(r, 1) ?? '')
        const text = mtextPlain(raw)
        if (!text.trim()) return
        const n = point(r, 210, Z).normalize()
        const h = num(r, 40, 2.5) || 2.5
        let x = get(r, 11) !== undefined ? point(r, 11) : null
        if (!x || x.lengthSq() < 1e-18) {
          const o = ocs(r)
          const angle = num(r, 50) * DEG
          x = o.ax.clone().multiplyScalar(Math.cos(angle)).addScaledVector(o.ay, Math.sin(angle))
        }
        x.addScaledVector(n, -x.dot(n)).normalize()
        const y = n.clone().cross(x)
        const { widths } = textShape(text)
        const width = Math.max(...widths) * h
        const block = h + (widths.length - 1) * LINE_SPACING * h
        const attach = Math.min(9, Math.max(1, num(r, 71, 1))) - 1
        const col = attach % 3
        const row = Math.floor(attach / 3)
        const at = point(r, 10)
          .addScaledVector(x, (-col * width) / 2)
          // Our anchor is the last baseline, the bottom of the block (descenders aside).
          .addScaledVector(y, row === 0 ? -block : row === 1 ? -block / 2 : 0)
        return out(textAnnotation(at, x, n, text, h))
      }
      case 'DIMENSION': {
        const dim = dimension(r, styleOf(r))
        if (dim) return out(dim)
        // Other kinds (ordinate) are drawn from their block, which is in model coordinates.
        const block = blocks.get(str(r, 2).toUpperCase())
        if (block && depth < 16) for (const child of block.entities) add(child, emit, depth + 1)
        return
      }
      case 'LEADER': {
        const pts: Vector3[] = []
        const c = new Cursor(r.pairs)
        for (let x = c.take(10); x !== undefined; x = c.take(10)) pts.push(v(parseFloat(x), parseFloat(c.take(20) ?? '0'), parseFloat(c.take(30) ?? '0')))
        if (pts.length < 2) return
        const style = styleOf(r)
        const o = ocs(r)
        return out({ type: 'annotation', kind: 'leader', points: pts, xaxis: o.ax, yaxis: o.ay, text: '', height: style.height, arrow: style.tick ? 'tick' : 'arrow', precision: style.precision })
      }
      case 'HATCH': {
        const o = ocs(r)
        const loops = hatchLoops(r)
        if (loops.length === 0) return
        const elevation = point(r, 10).z
        const basis = new Matrix4().makeBasis(o.ax, o.ay, o.n).multiply(new Matrix4().makeTranslation(0, 0, elevation))
        const solid = num(r, 70) === 1
        const [pattern, unit] = solid ? PATTERNS.SOLID : (PATTERNS[str(r, 2).toUpperCase()] ?? ['Lines', 3.175])
        // Pattern angle and scale come after the boundary data, which starts with the hatch style (75).
        const tail = r.pairs.slice(Math.max(0, r.pairs.findIndex(([code]) => code === 75)))
        const angle = tail.find(([code]) => code === 52)?.[1] ?? '0'
        const scale = tail.find(([code]) => code === 41)?.[1] ?? '1'
        return out({
          type: 'hatch',
          loops: loops.map((l) => transform(l, basis)),
          pattern,
          scale: (parseFloat(scale) || 1) * unit,
          rotation: parseFloat(angle) * DEG,
          origin: toWcs(o, v(0, 0, elevation)),
          xaxis: o.ax,
          yaxis: o.ay,
        })
      }
      case 'SOLID':
      case 'TRACE': {
        const o = ocs(r)
        const [a, b, c, d] = [10, 11, 12, 13].map((code) => toWcs(o, point(r, code)))
        const pts = c.distanceTo(d) < 1e-12 ? [a, b, c] : [a, b, d, c]
        return out({ type: 'hatch', loops: [{ type: 'polyline', points: pts, closed: true }], pattern: 'Solid', scale: 1, rotation: 0, origin: a.clone(), xaxis: o.ax, yaxis: o.ay })
      }
      case 'POINT':
        // Points are in world coordinates.
        return out({ type: 'point', point: point(r, 10) })
      case '3DFACE': {
        const pts = [10, 11, 12, 13].map((code) => point(r, code)).filter((p, i, all) => i === 0 || p.distanceTo(all[i - 1]) > 1e-12)
        if (pts.length > 2 && pts[pts.length - 1].distanceTo(pts[0]) < 1e-12) pts.pop()
        // Faces become meshes; the faces of a layer are put together into one mesh at the end.
        if (pts.length >= 3) out(makeMesh(pts.flatMap((p) => [p.x, p.y, p.z]), [pts.map((_, i) => i)]))
        return
      }
      default:
        if (!SKIP_SILENTLY.has(r.type)) skip(r.type)
    }
  }

  for (const r of entities) add(r, toModel, 0)
  objects.splice(0, objects.length, ...joinFaces(objects, (o) => o.layer))

  const skippedNamed = new Map<[string, string], number>()
  for (const [type, count] of skipped) skippedNamed.set(SKIPPED_NAMES[type] ?? [`${type.toLowerCase()} entity`, `${type.toLowerCase()} entities`], count)
  if (layers.length === 0) layers.push({ name: '0', color: '#000000', visible: true, locked: false })
  return { units, layers, objects, breps: [], tolerance: 0, skipped: skippedNamed }
}

/** Puts the meshes of each layer together into one welded mesh, where the first of them was. */
function joinFaces<T extends { geometry: Geometry }>(list: T[], layerOf: (item: T) => number): T[] {
  const byLayer = new Map<number, T[]>()
  for (const item of list) {
    if (item.geometry.type !== 'mesh') continue
    const group = byLayer.get(layerOf(item))
    if (group) group.push(item)
    else byLayer.set(layerOf(item), [item])
  }
  if (byLayer.size === 0) return list
  const out: T[] = []
  for (const item of list) {
    if (item.geometry.type !== 'mesh') out.push(item)
    else {
      const group = byLayer.get(layerOf(item))
      if (group?.[0] !== item) continue
      out.push({ ...item, geometry: weldMesh(joinMeshes(group.map((g) => g.geometry as MeshGeometry))) })
    }
  }
  return out
}

/** A dimension as a live ArchiOpen dimension, or null for kinds drawn from their block. */
function dimension(r: Rec, style: DimStyle): AnnotationGeometry | null {
  const kind = num(r, 70) & 7
  const o = ocs(r)
  const override = get(r, 1) ?? ''
  const base = { type: 'annotation' as const, text: override === '<>' ? '' : plainText(mtextPlain(override)), height: style.height, arrow: style.tick ? ('tick' as const) : ('arrow' as const), precision: style.precision }
  const p10 = point(r, 10)
  const p13 = point(r, 13)
  const p14 = point(r, 14)
  const p15 = point(r, 15)
  const textAt = get(r, 11) !== undefined ? toWcs(o, point(r, 11)) : p15.clone()
  switch (kind) {
    case 0: {
      const angle = num(r, 50) * DEG
      const xaxis = o.ax.clone().multiplyScalar(Math.cos(angle)).addScaledVector(o.ay, Math.sin(angle))
      return { ...base, kind: 'linear', points: [p13, p14, p10], xaxis, yaxis: o.n.clone().cross(xaxis) }
    }
    case 1:
      return { ...base, kind: 'aligned', points: [p13, p14, p10], xaxis: o.ax, yaxis: o.ay }
    case 3:
      return { ...base, kind: 'diameter', points: [p15.clone().add(p10).multiplyScalar(0.5), p15, textAt], xaxis: o.ax, yaxis: o.ay }
    case 4:
      return { ...base, kind: 'radius', points: [p10, p15, textAt], xaxis: o.ax, yaxis: o.ay }
    case 2: {
      // Two lines (13–14 and 10–15) and a point on the arc (16): the sector holding that point.
      const d1 = p14.clone().sub(p13)
      const d2 = p15.clone().sub(p10)
      const n = o.n
      const denom = d1.clone().cross(d2).dot(n)
      if (Math.abs(denom) < 1e-12) return null
      const vertex = p13.clone().addScaledVector(d1, p10.clone().sub(p13).cross(d2).dot(n) / denom)
      const q = point(r, 16).sub(vertex)
      const cross = (a: Vector3, b: Vector3) => a.clone().cross(b).dot(n)
      for (const s1 of [1, -1]) {
        for (const s2 of [1, -1]) {
          const r1 = d1.clone().multiplyScalar(s1)
          const r2 = d2.clone().multiplyScalar(s2)
          if (cross(r1, q) * cross(r1, r2) >= 0 && cross(r2, q) * cross(r2, r1) >= 0) {
            return { ...base, kind: 'angle', points: [vertex, vertex.clone().add(r1), vertex.clone().add(r2), point(r, 16)], xaxis: o.ax, yaxis: o.ay }
          }
        }
      }
      return null
    }
    case 5:
      return { ...base, kind: 'angle', points: [p15, p13, p14, p10], xaxis: o.ax, yaxis: o.ay }
    default:
      return null
  }
}
