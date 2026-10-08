import { Vector3 } from 'three'

/** A non-rational B-spline curve: control points, degree and a clamped knot vector. */
export interface BSpline {
  degree: number
  points: Vector3[]
  knots: number[]
}

/** Clamped knot vector with uniform interior knots, for `count` control points. */
export function clampedKnots(count: number, degree: number): number[] {
  const knots: number[] = []
  const spans = count - degree
  for (let i = 0; i < count + degree + 1; i++) {
    if (i <= degree) knots.push(0)
    else if (i >= count) knots.push(spans)
    else knots.push(i - degree)
  }
  return knots
}

/** Index k of the knot span [knots[k], knots[k+1]) that holds t, clamped to the valid range. */
function findSpan(count: number, degree: number, knots: number[], t: number): number {
  let k = degree
  while (k < count - 1 && t >= knots[k + 1]) k++
  return k
}

/** Evaluates a non-rational B-spline at parameter t using de Boor's algorithm. */
export function evalBSpline(points: Vector3[], degree: number, knots: number[], t: number): Vector3 {
  const k = findSpan(points.length, degree, knots, t)
  const d: Vector3[] = []
  for (let j = 0; j <= degree; j++) d.push(points[k - degree + j].clone())

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j
      const denom = knots[i + degree - r + 1] - knots[i]
      const a = denom === 0 ? 0 : (t - knots[i]) / denom
      d[j].lerpVectors(d[j - 1], d[j], a)
    }
  }
  return d[degree]
}

export function domainOf(c: BSpline): [number, number] {
  return [c.knots[c.degree], c.knots[c.points.length]]
}

/** First derivative at t, from the derivative curve's control points. */
export function derivBSpline(c: BSpline, t: number): Vector3 {
  const { degree: p, points: P, knots: U } = c
  if (p === 0 || P.length < 2) return new Vector3()
  const Q: Vector3[] = []
  for (let i = 0; i < P.length - 1; i++) {
    const denom = U[i + p + 1] - U[i + 1]
    Q.push(denom === 0 ? new Vector3() : P[i + 1].clone().sub(P[i]).multiplyScalar(p / denom))
  }
  return evalBSpline(Q, p - 1, U.slice(1, -1), t)
}

/** Inserts the knot t once (Boehm's algorithm). The curve's shape does not change. */
export function insertKnot(c: BSpline, t: number): BSpline {
  const { degree: p, points: P, knots: U } = c
  const k = findSpan(P.length, p, U, t)
  const Q: Vector3[] = []
  for (let i = 0; i <= P.length; i++) {
    if (i <= k - p) Q.push(P[i].clone())
    else if (i <= k) {
      const denom = U[i + p] - U[i]
      const a = denom === 0 ? 0 : (t - U[i]) / denom
      Q.push(P[i - 1].clone().lerp(P[i], a))
    } else Q.push(P[i - 1].clone())
  }
  return { degree: p, points: Q, knots: [...U.slice(0, k + 1), t, ...U.slice(k + 1)] }
}

/** Splits the curve at t into two clamped curves, or returns null if t is not inside the domain. */
export function splitBSpline(c: BSpline, t: number): [BSpline, BSpline] | null {
  const [t0, t1] = domainOf(c)
  if (!(t > t0 && t < t1)) return null
  const p = c.degree
  let curve = c
  let multiplicity = c.knots.filter((u) => u === t).length
  while (multiplicity < p) {
    curve = insertKnot(curve, t)
    multiplicity++
  }
  const { points: Q, knots: U } = curve
  // With t repeated p times, the control point just before its first occurrence lies on the curve at t.
  const a = U.indexOf(t)
  const left: BSpline = { degree: p, points: Q.slice(0, a).map((q) => q.clone()), knots: [...U.slice(0, a + p), t] }
  const right: BSpline = { degree: p, points: Q.slice(a - 1).map((q) => q.clone()), knots: [t, ...U.slice(a)] }
  return [left, right]
}

/** Reverses the direction of a curve while keeping its shape and domain. */
export function reverseBSpline(c: BSpline): BSpline {
  const [t0, t1] = domainOf(c)
  return {
    degree: c.degree,
    points: [...c.points].reverse().map((q) => q.clone()),
    knots: [...c.knots].reverse().map((u) => t0 + t1 - u),
  }
}

/** Non-zero basis functions N[span-p..span] at t (The NURBS Book, A2.2). */
function basisFunctions(span: number, t: number, p: number, U: number[]): number[] {
  const N = [1]
  const left: number[] = []
  const right: number[] = []
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[span + 1 - j]
    right[j] = U[span + j] - t
    let saved = 0
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r])
      N[r] = saved + right[r + 1] * temp
      saved = left[j - r] * temp
    }
    N[j] = saved
  }
  return N
}

/**
 * A curve of the given degree that passes through every point, using chord-length parameters and
 * averaged knots (The NURBS Book, 9.2.1). The domain is [0, total chord length].
 */
export function interpolate(points: Vector3[], degree = 3): BSpline {
  const n = points.length
  const p = Math.min(degree, n - 1)
  const chords = [0]
  for (let i = 1; i < n; i++) chords.push(chords[i - 1] + points[i].distanceTo(points[i - 1]))
  const total = chords[n - 1] || 1
  const params = chords.map((d) => d / total)

  const knots: number[] = []
  for (let i = 0; i <= p; i++) knots.push(0)
  for (let j = 1; j < n - p; j++) {
    let sum = 0
    for (let i = j; i < j + p; i++) sum += params[i]
    knots.push(sum / p)
  }
  for (let i = 0; i <= p; i++) knots.push(1)

  // Dense solve of N·P = Q; the matrix is banded but the point counts here are small.
  const A = params.map((t) => {
    const row = new Array<number>(n).fill(0)
    const span = findSpan(n, p, knots, t)
    basisFunctions(span, t, p, knots).forEach((value, i) => (row[span - p + i] = value))
    return row
  })
  const solved = solve(A, points.map((q) => [q.x, q.y, q.z]))
  return {
    degree: p,
    points: solved.map(([x, y, z]) => new Vector3(x, y, z)),
    knots: knots.map((u) => u * total),
  }
}

/** Gaussian elimination with partial pivoting, for several right-hand sides at once. */
function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length
  const M = A.map((row, i) => [...row, ...B[i]])
  const width = M[0].length
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    const d = M[col][col] || 1e-300
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / d
      if (f === 0) continue
      for (let c = col; c < width; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row.slice(n).map((v) => v / row[i]))
}
