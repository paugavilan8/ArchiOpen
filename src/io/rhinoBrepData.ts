/**
 * A Rhino polysurface read from a .3dm file, as plain data. The file reader produces it without the
 * geometry kernel; the kernel turns it into an exact shape later (see kernel/fromRhino.ts).
 */

/** NURBS curve with euclidean control points, weights and a full (clamped) knot vector. */
export interface NurbsCurveData {
  degree: number
  points: number[][]
  weights: number[] | null
  knots: number[]
  /** Points along the curve, for an approximation when the exact data cannot be used. */
  samples: number[][]
}

/** NURBS surface; points[u][v] with euclidean coordinates. */
export interface NurbsSurfaceData {
  degreeU: number
  degreeV: number
  points: number[][][]
  weights: number[][] | null
  knotsU: number[]
  knotsV: number[]
}

export interface BrepLoopData {
  outer: boolean
  /** Edges around the loop in order; -1 marks a collapsed (singular) side, like a sphere's pole. */
  trims: { edge: number; reversed: boolean }[]
}

export interface BrepFaceData {
  surface: NurbsSurfaceData
  reversed: boolean
  loops: BrepLoopData[]
}

export interface RhinoBrepData {
  faces: BrepFaceData[]
  edges: NurbsCurveData[]
  solid: boolean
}
