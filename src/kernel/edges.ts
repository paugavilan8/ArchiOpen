import { Vector3 } from 'three'
import type * as R from 'replicad'
import { arcThrough, circleThrough } from '../core/curves'
import type { AnyCurve } from '../core/geometry'
import { interpolate } from '../math/nurbs'

const vec = (v: R.Vector) => new Vector3(v.x, v.y, v.z)

/** One edge as a curve: lines, circles and arcs exactly, anything else as a fitted cubic. */
export function edgeToCurve(edge: R.Edge): AnyCurve | null {
  const at = (t: number) => vec(edge.pointAt(t))
  const start = vec(edge.startPoint)
  const end = vec(edge.endPoint)
  switch (edge.geomType) {
    case 'LINE':
      return start.distanceTo(end) > 1e-12 ? { type: 'polyline', points: [start, end], closed: false } : null
    case 'CIRCLE':
      return edge.isClosed ? circleThrough(at(0), at(1 / 3), at(2 / 3)) : arcThrough(start, at(0.5), end)
    default: {
      const points: Vector3[] = []
      for (let i = 0; i <= 64; i++) points.push(at(i / 64))
      return { type: 'curve', ...interpolate(points, 3) }
    }
  }
}
