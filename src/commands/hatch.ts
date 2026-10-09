import { Vector3 } from 'three'
import { AnyCurve, HatchGeometry, isClosed, isCurve, Plane, tessellate } from '../core/geometry'
import { hatchLines, PATTERN_NAMES } from '../core/hatch'
import { formatValue, isOption } from './helpers'
import type { Command, CommandContext } from './runner'

const memory: { pattern: string; scale: number | null; rotation: number } = { pattern: 'Lines', scale: null, rotation: 0 }

/** Plane of a closed planar curve (Newell's method), or null if it is not planar. */
function planeOf(curve: AnyCurve): { origin: Vector3; normal: Vector3 } | null {
  const pts = tessellate(curve)
  const normal = new Vector3()
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    normal.x += (a.y - b.y) * (a.z + b.z)
    normal.y += (a.z - b.z) * (a.x + b.x)
    normal.z += (a.x - b.x) * (a.y + b.y)
  }
  if (normal.length() < 1e-12) return null
  normal.normalize()
  const origin = pts[0]
  const size = Math.max(...pts.map((p) => p.distanceTo(origin)), 1e-9)
  if (pts.some((p) => Math.abs(p.clone().sub(origin).dot(normal)) > size * 1e-6 + 1e-9)) return null
  return { origin, normal }
}

/** A round scale (1, 2 or 5 times a power of ten) giving about 30 pattern lines across the region. */
function autoScale(curves: AnyCurve[]): number {
  const pts = curves.flatMap(tessellate)
  let size = 0
  for (const p of pts) size = Math.max(size, p.distanceTo(pts[0]))
  const target = Math.max(size, 1e-6) / 30
  const power = 10 ** Math.floor(Math.log10(target))
  return [1, 2, 5, 10].map((m) => m * power).reduce((best, s) => (Math.abs(Math.log(s / target)) < Math.abs(Math.log(best / target)) ? s : best))
}

/** Hatch axes: the construction plane's when it is parallel to the loops, otherwise any in their plane. */
function axesFor(normal: Vector3, cplane: Plane): { xaxis: Vector3; yaxis: Vector3 } {
  let xaxis = cplane.xaxis.clone().addScaledVector(normal, -cplane.xaxis.dot(normal))
  if (xaxis.length() < 1e-6) xaxis = cplane.yaxis.clone().addScaledVector(normal, -cplane.yaxis.dot(normal))
  xaxis.normalize()
  const yaxis = normal.clone().cross(xaxis).normalize()
  return { xaxis, yaxis }
}

const hatch: Command = {
  name: 'Hatch',
  async run(ctx: CommandContext) {
    const { doc, input, display, log } = ctx
    const ids = (await input.getObjects('Select closed planar curves to hatch')).filter((id) => {
      const g = doc.objects.get(id)?.geometry
      return g && isCurve(g) && isClosed(g)
    })
    if (ids.length === 0) throw new Error('Select closed curves')
    const curves = ids.map((id) => doc.objects.get(id)!.geometry as AnyCurve)
    const planes = curves.map(planeOf)
    if (planes.some((p) => !p)) throw new Error('Hatch boundaries must be planar')
    const base = planes[0]!
    const coplanar = planes.every((p) => Math.abs(Math.abs(p!.normal.dot(base.normal)) - 1) < 1e-6 && Math.abs(p!.origin.clone().sub(base.origin).dot(base.normal)) < 1e-6)
    // Coplanar loops make one hatch (inner loops are holes); others each get their own.
    const groups = coplanar ? [curves.map((c, i) => ({ c, p: planes[i]! }))] : curves.map((c, i) => [{ c, p: planes[i]! }])

    for (;;) {
      const scale = memory.scale ?? autoScale(curves)
      const option = await input.getOption('Hatch options. Press Enter to accept', [
        `Pattern=${memory.pattern}`,
        `Scale=${formatValue(scale)}`,
        `Rotation=${formatValue(memory.rotation)}`,
      ])
      if (option === null) break
      if (isOption(option, 'Pattern')) {
        memory.pattern = PATTERN_NAMES[(PATTERN_NAMES.indexOf(memory.pattern) + 1) % PATTERN_NAMES.length]
      } else if (isOption(option, 'Scale')) {
        const value = await input.getNumber('Pattern scale', scale)
        if (typeof value === 'number' && value > 0) memory.scale = value
      } else if (isOption(option, 'Rotation')) {
        const value = await input.getNumber('Pattern rotation in degrees', memory.rotation)
        if (typeof value === 'number') memory.rotation = value
      }
    }

    const scale = memory.scale ?? autoScale(curves)
    const created: number[] = []
    for (const group of groups) {
      const { origin, normal } = group[0].p
      const g: HatchGeometry = {
        type: 'hatch',
        loops: group.map((l) => l.c),
        pattern: memory.pattern,
        scale,
        rotation: (memory.rotation * Math.PI) / 180,
        origin: origin.clone(),
        ...axesFor(normal, display.active.cplane),
      }
      hatchLines(g) // Throws if the pattern is too dense to draw.
      created.push(doc.add(g).id)
    }
    doc.select(created)
    log(`${created.length} ${created.length === 1 ? 'hatch' : 'hatches'} created`)
  },
}

export const hatchCommands: Command[] = [hatch]
