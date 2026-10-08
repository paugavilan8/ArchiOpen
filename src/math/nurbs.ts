import { Vector3 } from 'three'

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

/** Evaluates a non-rational B-spline at parameter t using de Boor's algorithm. */
export function evalBSpline(points: Vector3[], degree: number, knots: number[], t: number): Vector3 {
  const n = points.length
  let k = degree
  while (k < n - 1 && t >= knots[k + 1]) k++

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
