import { Vector3 } from 'three'
import { AreaResult, boundingBox, curveArea, hatchArea, meshAreaCentroid, meshVolumeCentroid } from '../core/analysis'
import { closestPoint, length } from '../core/curves'
import { curvatureAt } from '../core/curveTools'
import type { CadObject } from '../core/document'
import { AnyCurve, Geometry, isCurve, tangentAt, typeName } from '../core/geometry'
import { faceCount, isClosedMesh, meshPieces, nakedEdges, vertexCount } from '../core/mesh'
import { unitAbbreviation } from '../core/units'
import { box as boxShape, shapeOf, toBrep } from '../kernel/brep'
import { checkShape, shapeArea, shapeBounds, shapeVolume } from '../kernel/measure'
import { geometryRows } from '../ui/propertiesPanel'
import { isOption, plural } from './helpers'
import type { Command, CommandContext } from './runner'
import { kernel } from './solids'

/** Measuring and checking: distances, lengths, angles, areas, volumes, bounding boxes. */

/** A measured value with up to six decimals, without trailing zeros. */
export const num = (x: number): string => String(Number(x.toFixed(6)))
const unit = (ctx: CommandContext) => unitAbbreviation(ctx.doc.units)
const pointText = (p: Vector3) => `(${num(p.x)}, ${num(p.y)}, ${num(p.z)})`
const degrees = (radians: number) => `${num((radians * 180) / Math.PI)}°`

const distance: Command = {
  name: 'Distance',
  history: false,
  async run(ctx) {
    const { input, log } = ctx
    const first = await input.getPoint({ prompt: 'First point for distance' })
    if (first.kind !== 'point') return
    const second = await input.getPoint({ prompt: 'Second point for distance', base: first.point })
    if (second.kind !== 'point') return
    const d = second.point.clone().sub(first.point)
    // Deltas and angles in the construction plane, as they read on screen.
    const { xaxis, yaxis, normal } = first.viewport.cplane
    const [dx, dy, dz] = [d.dot(xaxis), d.dot(yaxis), d.dot(normal)]
    const u = unit(ctx)
    log(
      `Distance = ${num(d.length())} ${u}. Angle in the construction plane ${degrees(Math.atan2(dy, dx))}, elevation ${degrees(Math.atan2(dz, Math.hypot(dx, dy)))}. ` +
        `dx = ${num(dx)}, dy = ${num(dy)}, dz = ${num(dz)}`,
    )
  },
}

const lengthCommand: Command = {
  name: 'Length',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const curves = (await input.getObjects('Select curves to measure'))
      .map((id) => doc.objects.get(id)!.geometry)
      .filter(isCurve)
    if (curves.length === 0) throw new Error('Select curves')
    const lengths = curves.map(length)
    const total = lengths.reduce((a, b) => a + b, 0)
    const u = unit(ctx)
    log(curves.length === 1 ? `Length = ${num(total)} ${u}` : `Total length of ${plural('curve', curves.length)} = ${num(total)} ${u} (${lengths.slice(0, 8).map(num).join(', ')}${curves.length > 8 ? ', …' : ''})`)
  },
}

/** Direction of a curve where it was picked. */
const directionAt = (g: AnyCurve, p: Vector3): Vector3 => tangentAt(g, closestPoint(g, p).t)

const angle: Command = {
  name: 'Angle',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const r = await input.getPoint({ prompt: 'Corner of the angle', options: ['TwoLines'] })
    if (r.kind === 'option') {
      // The angle between two picked lines or curves, at the picked spots.
      const directions: Vector3[] = []
      for (const prompt of ['Select the first line', 'Select the second line']) {
        const pick = await input.getPick(prompt)
        if (pick.kind !== 'pick') return
        const g = doc.objects.get(pick.id)?.geometry
        if (!g || !isCurve(g)) throw new Error('Select lines or curves')
        directions.push(directionAt(g, pick.point))
      }
      const a = directions[0].angleTo(directions[1])
      log(`Angle = ${degrees(Math.min(a, Math.PI - a))} (and ${degrees(Math.max(a, Math.PI - a))})`)
      return
    }
    if (r.kind !== 'point') return
    const corner = r.point
    const first = await input.getPoint({ prompt: 'Point on the first side', base: corner })
    if (first.kind !== 'point') return
    const second = await input.getPoint({ prompt: 'Point on the second side', base: corner, preview: (p) => [[first.point, corner, p]] })
    if (second.kind !== 'point') return
    const a = first.point.clone().sub(corner).angleTo(second.point.clone().sub(corner))
    log(`Angle = ${degrees(a)}`)
  },
}

const radius: Command = {
  name: 'Radius',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const pick = await input.getPick('Select a circle, arc or curve where to measure its radius')
    if (pick.kind !== 'pick') return
    const g = doc.objects.get(pick.id)?.geometry
    if (!g || !isCurve(g)) throw new Error('Select a curve')
    const u = unit(ctx)
    const segment = g.type === 'polycurve' ? closestSegment(g, pick.point) : g
    if (segment.type === 'circle' || segment.type === 'arc') {
      log(`Radius = ${num(segment.radius)} ${u}, diameter = ${num(2 * segment.radius)} ${u}`)
      return
    }
    const k = curvatureAt(segment, closestPoint(segment, pick.point).t).length()
    log(k < 1e-12 ? 'The curve is straight there' : `Radius of curvature = ${num(1 / k)} ${u} (curvature ${num(k)})`)
  },
}

function closestSegment(g: Extract<AnyCurve, { type: 'polycurve' }>, p: Vector3): AnyCurve {
  let best = g.segments[0] as AnyCurve
  let distance = Infinity
  for (const s of g.segments) {
    const d = closestPoint(s, p).distance
    if (d < distance) [best, distance] = [s, d]
  }
  return best
}

/** Area of one object, or null with a reason when it has none. */
async function areaOf(ctx: CommandContext, g: Geometry): Promise<AreaResult | string> {
  if (isCurve(g)) return curveArea(g) ?? 'open or not flat'
  if (g.type === 'hatch') return hatchArea(g)
  if (g.type === 'mesh') return meshAreaCentroid(g)
  if (g.type === 'brep') {
    await kernel(ctx)
    const m = shapeArea(shapeOf(g))
    return { area: m.value, centroid: m.centroid }
  }
  return 'no area'
}

/** Totals and the weighted centroid of several measurements. */
function combine(results: { value: number; centroid: Vector3 }[]): { value: number; centroid: Vector3 } {
  const value = results.reduce((s, r) => s + r.value, 0)
  const centroid = new Vector3()
  for (const r of results) centroid.addScaledVector(r.centroid, r.value)
  return { value, centroid: value > 0 ? centroid.divideScalar(value) : centroid }
}

const area: Command = {
  name: 'Area',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select closed curves, hatches, surfaces, solids or meshes')
    const measured: { value: number; centroid: Vector3 }[] = []
    let skipped = 0
    for (const id of ids) {
      const r = await areaOf(ctx, doc.objects.get(id)!.geometry)
      if (typeof r === 'string') skipped++
      else measured.push({ value: r.area, centroid: r.centroid })
    }
    if (measured.length === 0) throw new Error('Nothing selected has an area: curves must be closed and flat')
    const { value, centroid } = combine(measured)
    const u = unit(ctx)
    const each = measured.length > 1 ? ` (${measured.slice(0, 8).map((m) => num(m.value)).join(', ')}${measured.length > 8 ? ', …' : ''})` : ''
    log(`Area = ${num(value)} ${u}²${each}. Centroid ${pointText(centroid)}${skipped ? `. ${plural('object', skipped)} without an area left out` : ''}`)
  },
}

const volume: Command = {
  name: 'Volume',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select closed solids or meshes')
    const measured: { value: number; centroid: Vector3 }[] = []
    let open = 0
    for (const id of ids) {
      const g = doc.objects.get(id)!.geometry
      if (g.type === 'mesh' && isClosedMesh(g)) {
        const r = meshVolumeCentroid(g)
        measured.push({ value: r.volume, centroid: r.centroid })
      } else if (g.type === 'brep' && g.kind === 'solid') {
        await kernel(ctx)
        measured.push(shapeVolume(shapeOf(g)))
      } else open++
    }
    if (measured.length === 0) throw new Error('Select closed solids or closed meshes (open ones have no volume)')
    const { value, centroid } = combine(measured)
    log(`Volume = ${num(value)} ${unit(ctx)}³. Centroid ${pointText(centroid)}${open ? `. ${plural('object', open)} not closed left out` : ''}`)
  },
}

const boundingBoxCommand: Command = {
  name: 'BoundingBox',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = await input.getObjects('Select objects to box')
    let world = true
    for (;;) {
      const option = await input.getOption('Bounding box. Press Enter to make it', [`CoordinateSystem=${world ? 'World' : 'CPlane'}`])
      if (option === null) break
      if (isOption(option, 'CoordinateSystem')) world = !world
    }
    const plane = world ? { origin: new Vector3(), xaxis: new Vector3(1, 0, 0), yaxis: new Vector3(0, 1, 0), normal: new Vector3(0, 0, 1) } : display.active.cplane
    // Surfaces and solids are bounded exactly by the kernel; the rest from their points.
    const geometries = ids.map((id) => doc.objects.get(id)!.geometry)
    const box = boundingBox(geometries.filter((g) => g.type !== 'brep'), plane)
    const breps = geometries.filter((g) => g.type === 'brep')
    if (breps.length > 0) await kernel(ctx)
    for (const g of breps) box.union(shapeBounds(shapeOf(g), plane))
    if (box.isEmpty()) throw new Error('Nothing to box')
    const size = box.getSize(new Vector3())
    const at = (x: number, y: number, z: number) =>
      plane.origin.clone().addScaledVector(plane.xaxis, x).addScaledVector(plane.yaxis, y).addScaledVector(plane.normal, z)
    const corner = at(box.min.x, box.min.y, box.min.z)
    const tiny = Math.max(size.x, size.y, size.z) * 1e-9
    const u = unit(ctx)
    const flat = [size.x, size.y, size.z].filter((s) => s <= tiny).length
    if (flat >= 2) throw new Error('The objects lie on a line: they have no box')
    let id: number
    if (flat === 1) {
      // Flat objects get a rectangle.
      const corners =
        size.z <= tiny
          ? [at(box.min.x, box.min.y, box.min.z), at(box.max.x, box.min.y, box.min.z), at(box.max.x, box.max.y, box.min.z), at(box.min.x, box.max.y, box.min.z)]
          : size.y <= tiny
            ? [at(box.min.x, box.min.y, box.min.z), at(box.max.x, box.min.y, box.min.z), at(box.max.x, box.min.y, box.max.z), at(box.min.x, box.min.y, box.max.z)]
            : [at(box.min.x, box.min.y, box.min.z), at(box.min.x, box.max.y, box.min.z), at(box.min.x, box.max.y, box.max.z), at(box.min.x, box.min.y, box.max.z)]
      id = doc.add({ type: 'polyline', points: corners, closed: true }).id
    } else {
      await kernel(ctx)
      id = doc.add(toBrep(boxShape(corner, plane.xaxis.clone().multiplyScalar(size.x), plane.yaxis.clone().multiplyScalar(size.y), plane.normal.clone().multiplyScalar(size.z)))).id
    }
    doc.select([id])
    log(`Bounding box ${num(size.x)} × ${num(size.y)} × ${num(size.z)} ${u}, from ${pointText(corner)}`)
  },
}

const what: Command = {
  name: 'What',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to describe')
    for (const id of ids.slice(0, 20)) {
      const o = doc.objects.get(id)!
      const box = boundingBox([o.geometry])
      const rows = geometryRows(o.geometry).map(([label, value]) => `${label}: ${value}`)
      const state = [o.hidden && 'hidden', o.locked && 'locked', !!o.groups?.length && 'grouped'].filter(Boolean).join(', ')
      log(
        `#${id} ${typeName(o.geometry)} on layer "${doc.layerOf(o).name}"${state ? ` (${state})` : ''}. ${rows.join('. ')}${rows.length ? '. ' : ''}` +
          `Box from ${pointText(box.min)} to ${pointText(box.max)}`,
      )
    }
    if (ids.length > 20) log(`…and ${plural('more object', ids.length - 20)}`)
  },
}

interface Problem {
  id: number
  text: string
}

/** What is wrong with an object, if anything. */
async function problemsOf(ctx: CommandContext, o: CadObject): Promise<string[]> {
  const g = o.geometry
  const problems: string[] = []
  if (isCurve(g)) {
    if (length(g) < 1e-9) problems.push('it has no length')
  } else if (g.type === 'mesh') {
    let degenerate = 0
    const v = (i: number) => new Vector3().fromArray(g.vertices, 3 * i)
    for (let i = 0; i < g.faces.length; i += 4) {
      const [a, b, c] = [v(g.faces[i]), v(g.faces[i + 1]), v(g.faces[i + 2])]
      if (b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() === 0) degenerate++
    }
    if (degenerate) problems.push(`${plural('face', degenerate)} with no area`)
    if (g.vertices.some((x) => !Number.isFinite(x))) problems.push('vertices that are not numbers')
    if (faceCount(g) === 0) problems.push('no faces')
  } else if (g.type === 'brep') {
    await kernel(ctx)
    const check = checkShape(shapeOf(g))
    if (!check.valid) problems.push('the kernel finds it invalid')
    if (check.nonManifoldEdges) problems.push(`${plural('edge', check.nonManifoldEdges)} shared by more than two faces`)
  }
  return problems
}

/** Facts worth knowing that are not faults. */
async function notesOf(ctx: CommandContext, o: CadObject): Promise<string> {
  const g = o.geometry
  if (g.type === 'mesh') {
    const open = nakedEdges(g).length
    return `${vertexCount(g)} vertices, ${faceCount(g)} faces, ${open ? `open (${plural('naked edge', open)})` : 'closed'}, ${plural('piece', meshPieces(g).length)}`
  }
  if (g.type === 'brep') {
    const check = checkShape(shapeOf(g))
    return `${plural('face', check.faces)}, ${plural('edge', check.edges)}, ${check.nakedEdges ? `open (${plural('naked edge', check.nakedEdges)})` : 'closed'}`
  }
  return ''
}

const checkCommand: Command = {
  name: 'Check',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to check')
    const bad: Problem[] = []
    for (const id of ids) {
      const o = doc.objects.get(id)!
      const problems = await problemsOf(ctx, o)
      const notes = await notesOf(ctx, o)
      if (problems.length) bad.push({ id, text: problems.join(', ') })
      if (ids.length <= 10) log(`#${id} ${typeName(o.geometry)}: ${problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'good'}${notes ? `. ${notes}` : ''}`)
    }
    if (ids.length > 10) log(bad.length === 0 ? `All ${ids.length} objects are good` : `${plural('object', bad.length)} with problems: ${bad.slice(0, 10).map((b) => `#${b.id} (${b.text})`).join('; ')}`)
  },
}

const selBadObjects: Command = {
  name: 'SelBadObjects',
  history: false,
  async run(ctx) {
    const { doc, log } = ctx
    const bad: number[] = []
    for (const o of doc.objects.values()) if (doc.isSelectable(o) && (await problemsOf(ctx, o)).length) bad.push(o.id)
    doc.select(bad)
    log(bad.length === 0 ? 'No bad objects' : `${plural('bad object', bad.length)} selected; Check tells what is wrong`)
  },
}

export const analyzeCommands: Command[] = [distance, lengthCommand, angle, radius, area, volume, boundingBoxCommand, what, checkCommand, selBadObjects]
