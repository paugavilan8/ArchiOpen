import { Vector3 } from 'three'

/**
 * A B-spline curve: control points, degree and a clamped knot vector. With `weights` (one per
 * control point) it is rational, a NURBS curve, which draws exact circles, ellipses and conics.
 */
export interface BSpline {
  degree: number
  points: Vector3[]
  knots: number[]
  weights?: number[]
}

/** True when the curve has weights that are not all equal (equal weights draw the same curve). */
export const isRational = (c: BSpline): boolean => !!c.weights && c.weights.some((w) => Math.abs(w - c.weights![0]) > 1e-12)

/** Control points multiplied by their weights, and the weights as a curve of their own (in x). */
function homogeneous(c: BSpline): { numer: Vector3[]; denom: Vector3[] } {
  const w = c.weights!
  return { numer: c.points.map((p, i) => p.clone().multiplyScalar(w[i])), denom: w.map((x) => new Vector3(x, 0, 0)) }
}

/** Evaluates a B-spline or NURBS curve at t. */
export function evalCurve(c: BSpline, t: number): Vector3 {
  if (!isRational(c)) return evalBSpline(c.points, c.degree, c.knots, t)
  const { numer, denom } = homogeneous(c)
  return evalBSpline(numer, c.degree, c.knots, t).divideScalar(evalBSpline(denom, c.degree, c.knots, t).x)
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

/** First derivative at t, from the derivative curve's control points (with the quotient rule for NURBS). */
export function derivBSpline(c: BSpline, t: number): Vector3 {
  if (isRational(c)) {
    const { numer, denom } = homogeneous(c)
    const plain = { degree: c.degree, knots: c.knots }
    const w = evalBSpline(denom, c.degree, c.knots, t).x
    const dw = derivBSpline({ ...plain, points: denom }, t).x
    const point = evalBSpline(numer, c.degree, c.knots, t).divideScalar(w)
    return derivBSpline({ ...plain, points: numer }, t).addScaledVector(point, -dw).divideScalar(w)
  }
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
  if (c.weights) {
    // In homogeneous coordinates: the weighted points and the weights get the same new knot.
    const { numer, denom } = homogeneous(c)
    const a = insertKnot({ degree: c.degree, knots: c.knots, points: numer }, t)
    const b = insertKnot({ degree: c.degree, knots: c.knots, points: denom }, t)
    const weights = b.points.map((p) => p.x)
    return { degree: c.degree, knots: a.knots, points: a.points.map((p, i) => p.divideScalar(weights[i])), weights }
  }
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
  const { points: Q, knots: U, weights: W } = curve
  // With t repeated p times, the control point just before its first occurrence lies on the curve at t.
  const a = U.indexOf(t)
  const left: BSpline = { degree: p, points: Q.slice(0, a).map((q) => q.clone()), knots: [...U.slice(0, a + p), t] }
  const right: BSpline = { degree: p, points: Q.slice(a - 1).map((q) => q.clone()), knots: [t, ...U.slice(a)] }
  if (W) {
    left.weights = W.slice(0, a)
    right.weights = W.slice(a - 1)
  }
  return [left, right]
}

/** Reverses the direction of a curve while keeping its shape and domain. */
export function reverseBSpline(c: BSpline): BSpline {
  const [t0, t1] = domainOf(c)
  return {
    degree: c.degree,
    points: [...c.points].reverse().map((q) => q.clone()),
    knots: [...c.knots].reverse().map((u) => t0 + t1 - u),
    ...(c.weights ? { weights: [...c.weights].reverse() } : {}),
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

/** Every basis function N[0..count-1] of a degree-p B-spline at t (zero outside their span). */
export function basisAt(count: number, p: number, knots: number[], t: number): number[] {
  const row = new Array<number>(count).fill(0)
  const span = findSpan(count, p, knots, t)
  basisFunctions(span, t, p, knots).forEach((v, j) => (row[span - p + j] = v))
  return row
}

/**
 * The degree-p B-spline with `count` control points that best fits the points in the least-squares
 * sense, passing exactly through the first and last (The NURBS Book, 9.4.1). The domain is [0, 1].
 */
export function approximate(points: Vector3[], count: number, degree = 3, params?: number[]): BSpline {
  const m = points.length - 1
  const n = Math.max(1, Math.min(count, points.length) - 1)
  const p = Math.min(degree, n)
  if (n <= p) return interpolate(points.length === n + 1 ? points : [points[0], points[m]], p)
  // Chord-length parameters (unless given), and knots that put about the same number of points in every span.
  const chords = [0]
  for (let i = 1; i <= m; i++) chords.push(chords[i - 1] + points[i].distanceTo(points[i - 1]))
  const u = params ?? chords.map((c) => c / (chords[m] || 1))
  const knots: number[] = [...new Array(p + 1).fill(0)]
  const d = (m + 1) / (n - p + 1)
  for (let j = 1; j <= n - p; j++) {
    const i = Math.floor(j * d)
    const a = j * d - i
    knots.push((1 - a) * u[i - 1] + a * u[i])
  }
  knots.push(...new Array(p + 1).fill(1))

  // Normal equations for the inner control points, with the ends fixed.
  const size = n - 1
  const A = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  const B = Array.from({ length: size }, () => new Vector3())
  for (let k = 1; k < m; k++) {
    const N = basisAt(n + 1, p, knots, u[k])
    const r = points[k].clone().addScaledVector(points[0], -N[0]).addScaledVector(points[m], -N[n])
    for (let i = 1; i < n; i++) {
      if (N[i] === 0) continue
      B[i - 1].addScaledVector(r, N[i])
      for (let j = 1; j < n; j++) A[i - 1][j - 1] += N[i] * N[j]
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < size; c++) {
    let pivot = c
    for (let r = c + 1; r < size; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r
    ;[A[c], A[pivot]] = [A[pivot], A[c]]
    ;[B[c], B[pivot]] = [B[pivot], B[c]]
    const diag = A[c][c] || 1e-300
    for (let r = c + 1; r < size; r++) {
      const f = A[r][c] / diag
      if (f === 0) continue
      for (let k = c; k < size; k++) A[r][k] -= f * A[c][k]
      B[r].addScaledVector(B[c], -f)
    }
  }
  const P = new Array<Vector3>(size)
  for (let r = size - 1; r >= 0; r--) {
    const v = B[r].clone()
    for (let k = r + 1; k < size; k++) v.addScaledVector(P[k], -A[r][k])
    P[r] = v.divideScalar(A[r][r] || 1e-300)
  }
  return { degree: p, points: [points[0].clone(), ...P, points[m].clone()], knots }
}
