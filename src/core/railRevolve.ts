import { Matrix4, Vector3 } from 'three'
import { transform } from './curves'
import { endPoint, isClosed, samples, startPoint, type AnyCurve } from './geometry'

/**
 * RailRevolve: a profile turned about an axis while it follows a rail curve. At each angle the
 * profile is turned there and stretched away from the axis (only across it, never along it) so
 * that its end on the rail lands on the rail. Sections at even angles over the rail's sweep are
 * returned, to be lofted into the surface.
 */

/** The part of p - origin across the axis (its unit direction). */
const across = (p: Vector3, origin: Vector3, axis: Vector3) => {
  const d = p.clone().sub(origin)
  return d.addScaledVector(axis, -d.dot(axis))
}

export function railRevolveSections(profile: AnyCurve, rail: AnyCurve, origin: Vector3, axisDirection: Vector3, count = 48): AnyCurve[] {
  const axis = axisDirection.clone().normalize()
  // The profile's end that runs along the rail: the one nearer to it.
  const railPoints = samples(rail).points
  const nearness = (p: Vector3) => Math.min(...railPoints.map((q) => q.distanceTo(p)))
  const end = nearness(startPoint(profile)) <= nearness(endPoint(profile)) ? startPoint(profile) : endPoint(profile)
  const radial = across(end, origin, axis)
  const radius = radial.length()
  if (radius < 1e-9) throw new Error('The end of the profile on the rail must be off the axis')
  const u = radial.clone().normalize()
  const w = axis.clone().cross(u)

  // The rail around the axis: its angle from the profile (made continuous) and its distance.
  const turns: { angle: number; radius: number }[] = []
  for (const q of railPoints) {
    const r = across(q, origin, axis)
    let angle = Math.atan2(r.dot(w), r.dot(u))
    const last = turns[turns.length - 1]
    if (last) while (angle - last.angle > Math.PI) angle -= 2 * Math.PI
    if (last) while (angle - last.angle < -Math.PI) angle += 2 * Math.PI
    turns.push({ angle, radius: r.length() })
  }
  if (turns.some((t) => t.radius < 1e-9)) throw new Error('The rail must not touch the axis')
  const first = turns[0].angle
  const sweep = turns[turns.length - 1].angle - first
  if (Math.abs(sweep) < 1e-6) throw new Error('The rail must go around the axis')
  const closed = isClosed(rail)

  // The rail's distance from the axis at an angle, between the samples around it.
  const radiusAt = (angle: number) => {
    for (let i = 1; i < turns.length; i++) {
      const [a, b] = [turns[i - 1], turns[i]]
      const lo = Math.min(a.angle, b.angle)
      const hi = Math.max(a.angle, b.angle)
      if (angle >= lo - 1e-12 && angle <= hi + 1e-12) {
        const f = hi === lo ? 0 : (angle - a.angle) / (b.angle - a.angle)
        return a.radius + (b.radius - a.radius) * f
      }
    }
    return turns[angle < first === sweep > 0 ? 0 : turns.length - 1].radius
  }

  const sections: AnyCurve[] = []
  const n = Math.max(4, count)
  for (let i = 0; i <= n; i++) {
    const angle = first + (sweep * i) / n
    // Stretch across the axis (along u, about the axis line), then turn.
    const k = radiusAt(angle) / radius
    const stretch = new Matrix4().set(
      1 + (k - 1) * u.x * u.x, (k - 1) * u.x * u.y, (k - 1) * u.x * u.z, 0,
      (k - 1) * u.y * u.x, 1 + (k - 1) * u.y * u.y, (k - 1) * u.y * u.z, 0,
      (k - 1) * u.z * u.x, (k - 1) * u.z * u.y, 1 + (k - 1) * u.z * u.z, 0,
      0, 0, 0, 1,
    )
    const m = new Matrix4()
      .makeTranslation(origin.x, origin.y, origin.z)
      .multiply(new Matrix4().makeRotationAxis(axis, angle))
      .multiply(stretch)
      .multiply(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
    // A closed rail comes back to where it started: the last section is the first one.
    sections.push(closed && i === n ? sections[0] : transform(profile, m))
  }
  return sections
}
