/**
 * Writes polysurfaces in the binary form openNURBS uses for its objects (what ON_Brep::Write puts in a
 * .3dm archive), so they can go into Rhino files exactly. rhino3dm can read such bytes back into a
 * Brep (CommonObject.decode) but has no way to build trimmed ones itself.
 */

type Vec = [number, number, number]

/** A curve: NURBS (points in euclidean coordinates, 2 or 3 of them) or a circular arc. */
export type OnCurve =
  | { kind: 'nurbs'; dim: 2 | 3; degree: number; knots: number[]; points: number[][]; weights?: number[] }
  | { kind: 'arc'; center: Vec; xaxis: Vec; yaxis: Vec; radius: number; angles: [number, number] }

export type OnSurface =
  /** origin + u·xaxis + v·yaxis over the domain. */
  | { kind: 'plane'; origin: Vec; xaxis: Vec; yaxis: Vec; domain: [[number, number], [number, number]] }
  /** Points by rows of constant u. */
  | { kind: 'nurbs'; degreeU: number; degreeV: number; knotsU: number[]; knotsV: number[]; points: Vec[][]; weights?: number[][] }
  /** The curve (parameter v) turned about the axis by the angle u (radians). */
  | { kind: 'revolution'; axis: [Vec, Vec]; angles: [number, number]; curve: OnCurve; box: [Vec, Vec] }
  /** curves[0](u) + curves[1](v). */
  | { kind: 'sum'; curves: [OnCurve, OnCurve]; box: [Vec, Vec] }

/** openNURBS trim types and iso flags. */
export const TRIM = { boundary: 1, mated: 2, seam: 3, singular: 4 } as const
export const ISO = { none: 0, x: 1, y: 2, W: 3, S: 4, E: 5, N: 6 } as const

export interface OnBrep {
  curves2d: OnCurve[]
  curves3d: OnCurve[]
  surfaces: OnSurface[]
  vertices: { point: Vec; edges: number[]; tolerance: number }[]
  edges: { curve: number; vertices: [number, number]; trims: number[]; tolerance: number }[]
  trims: { curve: number; edge: number; vertices: [number, number]; reversed: boolean; type: number; iso: number; loop: number }[]
  loops: { trims: number[]; outer: boolean; face: number }[]
  faces: { loops: number[]; surface: number; reversed: boolean }[]
  box: [Vec, Vec]
}

// --- Archive --------------------------------------------------------------------------

const TCODE_CRC = 0x8000
const TCODE_ANONYMOUS_CHUNK = 0x40008000
const TCODE_OPENNURBS_CLASS = 0x00027ffa
const TCODE_OPENNURBS_CLASS_UUID = 0x0002fffb
const TCODE_OPENNURBS_CLASS_DATA = 0x0002fffc
const TCODE_OPENNURBS_CLASS_END = 0x80027fff

const CLASS_IDS = {
  brep: '60B5DBC5-E660-11d3-BFE4-0010830122F0',
  nurbsCurve: '4ED7D4DD-E947-11d3-BFE5-0010830122F0',
  arcCurve: 'CF33BE2A-09B4-11d4-BFFB-0010830122F0',
  nurbsSurface: '4ED7D4DE-E947-11d3-BFE5-0010830122F0',
  planeSurface: '4ED7D4DF-E947-11d3-BFE5-0010830122F0',
  revSurface: 'A16220D3-163B-11d4-8000-0010830122F0',
  sumSurface: 'C4CD5359-446D-4690-9FF5-29059732472B',
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** zlib's CRC-32, which openNURBS uses for its chunks. */
export function crc32(crc: number, bytes: Uint8Array): number {
  let c = ~crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/**
 * A version 6 openNURBS archive being written: little-endian values in nested chunks, each with an
 * 8-byte length and, for some typecodes, a CRC of the bytes written directly in it.
 */
class Archive {
  private buffer = new Uint8Array(4096)
  private view = new DataView(this.buffer.buffer)
  private length = 0
  private readonly chunks: { start: number; crc: number; checked: boolean }[] = []

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }

  private reserve(n: number) {
    if (this.length + n <= this.buffer.length) return
    const bigger = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n))
    bigger.set(this.buffer)
    this.buffer = bigger
    this.view = new DataView(bigger.buffer)
  }

  /** Bytes written at `from` onwards count towards the open chunk's CRC. */
  private written(from: number) {
    const chunk = this.chunks[this.chunks.length - 1]
    if (chunk?.checked) chunk.crc = crc32(chunk.crc, this.buffer.subarray(from, this.length))
  }

  int(...values: number[]) {
    this.reserve(4 * values.length)
    const from = this.length
    for (const v of values) {
      this.view.setInt32(this.length, v, true)
      this.length += 4
    }
    this.written(from)
  }

  double(...values: number[]) {
    this.reserve(8 * values.length)
    const from = this.length
    for (const v of values) {
      this.view.setFloat64(this.length, v, true)
      this.length += 8
    }
    this.written(from)
  }

  char(...values: number[]) {
    this.reserve(values.length)
    const from = this.length
    for (const v of values) this.buffer[this.length++] = v & 0xff
    this.written(from)
  }

  uuid(id: string) {
    const hex = id.replace(/-/g, '')
    const data1 = parseInt(hex.slice(0, 8), 16)
    this.reserve(16)
    const from = this.length
    this.view.setUint32(this.length, data1, true)
    this.view.setUint16(this.length + 4, parseInt(hex.slice(8, 12), 16), true)
    this.view.setUint16(this.length + 6, parseInt(hex.slice(12, 16), 16), true)
    for (let i = 0; i < 8; i++) this.buffer[this.length + 8 + i] = parseInt(hex.slice(16 + 2 * i, 18 + 2 * i), 16)
    this.length += 16
    this.written(from)
  }

  point(p: number[]) {
    this.double(p[0], p[1], p[2] ?? 0)
  }

  interval(a: number, b: number) {
    this.double(a, b)
  }

  intArray(values: number[]) {
    this.int(values.length, ...values)
  }

  /** Version byte inside a chunk: major·16 + minor. */
  version(major: number, minor: number) {
    this.char(major * 16 + minor)
  }

  /** Starts a chunk; its header is not part of the enclosing chunk's CRC. */
  begin(typecode: number) {
    this.reserve(12)
    this.view.setUint32(this.length, typecode >>> 0, true)
    this.view.setBigInt64(this.length + 4, 0n, true)
    this.length += 12
    this.chunks.push({ start: this.length, crc: 0, checked: (typecode & TCODE_CRC) !== 0 })
  }

  /** A chunk whose data starts with its major and minor version as two integers. */
  beginVersioned(typecode: number, major: number, minor: number) {
    this.begin(typecode)
    this.int(major, minor)
  }

  end() {
    const chunk = this.chunks[this.chunks.length - 1]
    if (chunk.checked) {
      this.reserve(4)
      this.view.setUint32(this.length, chunk.crc, true)
      this.length += 4
    }
    this.view.setBigInt64(chunk.start - 8, BigInt(this.length - chunk.start), true)
    this.chunks.pop()
  }

  /** A short chunk: typecode and value, nothing else. */
  short(typecode: number) {
    this.reserve(12)
    this.view.setUint32(this.length, typecode >>> 0, true)
    this.view.setBigInt64(this.length + 4, 0n, true)
    this.length += 12
  }

  /** An object as WriteObject saves it: its class id, then its data. */
  object(classId: string, write: () => void) {
    this.begin(TCODE_OPENNURBS_CLASS)
    this.begin(TCODE_OPENNURBS_CLASS_UUID)
    this.uuid(classId)
    this.end()
    this.begin(TCODE_OPENNURBS_CLASS_DATA)
    write()
    this.end()
    this.short(TCODE_OPENNURBS_CLASS_END)
    this.end()
  }
}

// --- Geometry -------------------------------------------------------------------------

const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** An unset bounding box, as openNURBS writes where it has none. */
const NO_BOX: [Vec, Vec] = [
  [1, 0, 0],
  [-1, 0, 0],
]

function writePlane(a: Archive, origin: Vec, xaxis: Vec, yaxis: Vec) {
  const z = cross(xaxis, yaxis)
  a.point(origin)
  a.point(xaxis)
  a.point(yaxis)
  a.point(z)
  a.double(z[0], z[1], z[2], -dot(z, origin))
}

/** The parameter interval a curve is defined on. */
export function curveDomain(c: OnCurve): [number, number] {
  if (c.kind === 'arc') return c.angles
  return [c.knots[c.degree - 1], c.knots[c.knots.length - c.degree]]
}

function writeCurve(a: Archive, c: OnCurve) {
  if (c.kind === 'arc') {
    a.object(CLASS_IDS.arcCurve, () => {
      a.version(1, 0)
      writePlane(a, c.center, c.xaxis, c.yaxis)
      a.double(c.radius)
      // Three points on the circle, which readers skip.
      for (const angle of [0, Math.PI / 2, Math.PI]) {
        const [cos, sin] = [Math.cos(angle) * c.radius, Math.sin(angle) * c.radius]
        a.point([0, 1, 2].map((i) => c.center[i] + cos * c.xaxis[i] + sin * c.yaxis[i]))
      }
      a.interval(...c.angles)
      a.interval(...c.angles)
      a.int(3)
    })
    return
  }
  a.object(CLASS_IDS.nurbsCurve, () => {
    a.version(1, 1)
    const rational = !!c.weights
    a.int(c.dim, rational ? 1 : 0, c.degree + 1, c.points.length, 0, 0)
    a.point(NO_BOX[0])
    a.point(NO_BOX[1])
    a.int(c.knots.length)
    a.double(...c.knots)
    a.int(c.points.length)
    c.points.forEach((p, i) => {
      const w = c.weights?.[i] ?? 1
      const cv = p.slice(0, c.dim).map((x) => x * w)
      if (rational) cv.push(w)
      a.double(...cv)
    })
    a.char(0) // not tagged as SubD friendly
  })
}

function writeSurface(a: Archive, s: OnSurface) {
  switch (s.kind) {
    case 'plane':
      a.object(CLASS_IDS.planeSurface, () => {
        a.version(1, 1)
        writePlane(a, s.origin, s.xaxis, s.yaxis)
        // Domain and extents alike: the parameters are distances along the axes.
        a.interval(...s.domain[0])
        a.interval(...s.domain[1])
        a.interval(...s.domain[0])
        a.interval(...s.domain[1])
      })
      return
    case 'nurbs':
      a.object(CLASS_IDS.nurbsSurface, () => {
        a.version(1, 0)
        const rational = !!s.weights
        a.int(3, rational ? 1 : 0, s.degreeU + 1, s.degreeV + 1, s.points.length, s.points[0].length, 0, 0)
        a.point(NO_BOX[0])
        a.point(NO_BOX[1])
        a.int(s.knotsU.length)
        a.double(...s.knotsU)
        a.int(s.knotsV.length)
        a.double(...s.knotsV)
        a.int(s.points.length * s.points[0].length)
        s.points.forEach((row, i) =>
          row.forEach((p, j) => {
            const w = s.weights?.[i][j] ?? 1
            if (rational) a.double(p[0] * w, p[1] * w, p[2] * w, w)
            else a.double(...p)
          }),
        )
      })
      return
    case 'revolution':
      a.object(CLASS_IDS.revSurface, () => {
        a.version(2, 0)
        a.point(s.axis[0])
        a.point(s.axis[1])
        a.interval(...s.angles)
        // The angle is the parameter itself.
        a.interval(...s.angles)
        a.point(s.box[0])
        a.point(s.box[1])
        a.int(0) // not transposed: u turns, v runs along the curve
        a.char(1)
        writeCurve(a, s.curve)
      })
      return
    case 'sum':
      a.object(CLASS_IDS.sumSurface, () => {
        a.version(1, 0)
        a.point([0, 0, 0])
        a.point(s.box[0])
        a.point(s.box[1])
        writeCurve(a, s.curves[0])
        writeCurve(a, s.curves[1])
      })
  }
}

/** A random version 4 UUID. */
function randomUuid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** An array of objects in an anonymous chunk, as ON_CurveArray and ON_SurfaceArray write them. */
function objectArray<T>(a: Archive, items: T[], write: (item: T) => void) {
  a.begin(TCODE_ANONYMOUS_CHUNK)
  a.version(1, 0)
  a.int(items.length)
  for (const item of items) {
    a.int(1)
    write(item)
  }
  a.end()
}

function componentArray<T>(a: Archive, items: T[], write: (item: T, index: number) => void, minor = 0) {
  a.begin(TCODE_ANONYMOUS_CHUNK)
  a.version(1, minor)
  a.int(items.length)
  items.forEach(write)
}

/** The bytes of an ON_Brep object (class id and data), as in a version 6 archive. */
export function writeBrep(brep: OnBrep): Uint8Array {
  const a = new Archive()
  a.object(CLASS_IDS.brep, () => {
    a.version(3, 3)
    objectArray(a, brep.curves2d, (c) => writeCurve(a, c))
    objectArray(a, brep.curves3d, (c) => writeCurve(a, c))
    objectArray(a, brep.surfaces, (s) => writeSurface(a, s))

    componentArray(a, brep.vertices, (v, i) => {
      a.int(i)
      a.point(v.point)
      a.intArray(v.edges)
      a.double(v.tolerance)
    })
    a.end()

    componentArray(a, brep.edges, (e, i) => {
      const domain = curveDomain(brep.curves3d[e.curve])
      a.int(i, e.curve, 0)
      a.interval(...domain)
      a.int(...e.vertices)
      a.intArray(e.trims)
      a.double(e.tolerance)
      a.interval(...domain)
    })
    a.end()

    componentArray(a, brep.trims, (t, i) => {
      const domain = curveDomain(brep.curves2d[t.curve])
      a.int(i, t.curve)
      a.interval(...domain)
      a.int(t.edge, ...t.vertices, t.reversed ? 1 : 0, t.type, t.iso, t.loop)
      a.double(0, 0)
      a.interval(...domain)
      a.char(...new Array(32).fill(0))
      a.double(0, 0)
    })
    a.end()

    componentArray(a, brep.loops, (l, i) => {
      a.int(i)
      a.intArray(l.trims)
      a.int(l.outer ? 1 : 2, l.face)
    })
    a.end()

    componentArray(
      a,
      brep.faces,
      (f, i) => {
        a.int(i)
        a.intArray(f.loops)
        a.int(f.surface, f.reversed ? 1 : 0, 0)
      },
      1,
    )
    for (let i = 0; i < brep.faces.length; i++) a.uuid(randomUuid())
    a.end()

    a.point(brep.box[0])
    a.point(brep.box[1])
    // No render or analysis meshes: Rhino makes its own.
    for (let pass = 0; pass < 2; pass++) {
      a.begin(TCODE_ANONYMOUS_CHUNK)
      a.char(...new Array(brep.faces.length).fill(0))
      a.end()
    }
    a.int(0) // solidity unknown: Rhino works it out
    a.beginVersioned(TCODE_ANONYMOUS_CHUNK, 1, 1)
    a.char(0) // no region topology
    a.end()
  })
  return a.bytes()
}

// --- Trim flags -----------------------------------------------------------------------

const SQRT_EPSILON = 1.490116119385e-8
const ZERO_TOLERANCE = 2.3283064365386963e-10

function parameterTolerance(t0: number, t1: number, t: number): [number, number] {
  const dt = (t1 - t0) * 8 * SQRT_EPSILON + (Math.abs(t0) + Math.abs(t1)) * ZERO_TOLERANCE
  return [t - dt, t + dt]
}

/** Bounding box of a 2D curve as openNURBS takes it: that of its control points (or the arc). */
function box2d(c: OnCurve): [number, number, number, number] {
  const pts =
    c.kind === 'nurbs'
      ? c.points
      : Array.from({ length: 65 }, (_, i) => {
          const t = c.angles[0] + ((c.angles[1] - c.angles[0]) * i) / 64
          return [0, 1].map((k) => c.center[k] + c.radius * (Math.cos(t) * c.xaxis[k] + Math.sin(t) * c.yaxis[k]))
        })
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of pts) {
    x0 = Math.min(x0, p[0])
    x1 = Math.max(x1, p[0])
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
  }
  return [x0, y0, x1, y1]
}

/**
 * Whether a trim runs along a parameter line of its surface, and which side if it is on one, worked
 * out as openNURBS checks it (ON_Surface::IsIsoparametric), since a reader rejects flags that differ.
 */
export function isoFlag(c: OnCurve, domain: [[number, number], [number, number]]): number {
  const [x0, y0, x1, y1] = box2d(c)
  const [s0, s1] = domain[0]
  const [t0, t1] = domain[1]
  const ds = x1 - x0
  const dt = y1 - y0
  const stol = (s1 - s0) / 32
  const ttol = (t1 - t0) / 32
  if (!(s0 < s1 && t0 < t1 && (ds <= stol || dt <= ttol))) return ISO.none
  if (ds * (t1 - t0) <= dt * (s1 - s0)) {
    // A u = constant line: straight within the width of its box.
    if (!isLinear(c, ds < ZERO_TOLERANCE && ZERO_TOLERANCE * 1024 <= dt ? ZERO_TOLERANCE : ds)) return ISO.none
    const within = ([a, b]: [number, number]) => a <= x0 && x1 <= b
    if (x1 <= s0 + stol && within(parameterTolerance(s0, s1, s0))) return ISO.W
    if (x0 >= s1 - stol && within(parameterTolerance(s0, s1, s1))) return ISO.E
    return within(parameterTolerance(s0, s1, (x0 + x1) / 2)) ? ISO.x : ISO.none
  }
  if (!isLinear(c, dt < ZERO_TOLERANCE && ZERO_TOLERANCE * 1024 <= ds ? ZERO_TOLERANCE : dt)) return ISO.none
  const within = ([a, b]: [number, number]) => a < y0 && y1 <= b
  if (y1 <= t0 + ttol && within(parameterTolerance(t0, t1, t0))) return ISO.S
  if (y0 >= t1 - ttol && within(parameterTolerance(t0, t1, t1))) return ISO.N
  return within(parameterTolerance(t0, t1, (y0 + y1) / 2)) ? ISO.y : ISO.none
}

/** True if the control points lie within `tolerance` of the line between the curve's ends. */
function isLinear(c: OnCurve, tolerance: number): boolean {
  if (c.kind !== 'nurbs') return false
  const [a, b] = [c.points[0], c.points[c.points.length - 1]]
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return false
  return c.points.every((p) => Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len <= Math.max(tolerance, ZERO_TOLERANCE))
}
