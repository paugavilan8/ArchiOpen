import { Matrix4, Vector3 } from 'three'
import { CancelError } from '../input/interaction'
import { length } from '../core/curves'
import { curveArrayMatrices, type CurveArrayOrientation } from '../core/curveTools'
import { isClosed, isCurve } from '../core/geometry'
import {
  applyTransform,
  isOption,
  memory,
  mirrorIn,
  rotationAbout,
  scaleAbout,
  scaleAcross,
  scaleAlong,
  signedAngle,
  transformedPreview,
  valueOption,
  yesNo,
} from './helpers'
import type { Command } from './runner'

const DEG = Math.PI / 180

const rotate: Command = {
  name: 'Rotate',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to rotate')
    const center = await input.getPoint({ prompt: 'Center of rotation' })
    if (center.kind !== 'point') return
    const c = center.point
    const n = center.viewport.cplane.normal

    for (;;) {
      const first = await input.getPoint({
        prompt: 'Angle or first reference point',
        base: c,
        acceptNumber: true,
        options: [yesNo('Copy', memory.rotateCopy)],
      })
      if (first.kind === 'option') {
        memory.rotateCopy = !memory.rotateCopy
        continue
      }
      if (first.kind === 'number') return applyTransform(ctx, ids, rotationAbout(c, n, first.value * DEG), memory.rotateCopy)
      if (first.kind !== 'point') return

      const ref = first.point.clone().sub(c)
      const angleTo = (p: Vector3) => signedAngle(ref, p.clone().sub(c), n)
      const second = await input.getPoint({
        prompt: 'Second reference point',
        base: c,
        acceptNumber: true,
        preview: transformedPreview(ctx, ids, (p) => rotationAbout(c, n, angleTo(p))),
      })
      const angle = second.kind === 'number' ? second.value * DEG : second.kind === 'point' ? angleTo(second.point) : null
      if (angle !== null) applyTransform(ctx, ids, rotationAbout(c, n, angle), memory.rotateCopy)
      return
    }
  },
}

const scale: Command = {
  name: 'Scale',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to scale')
    const origin = await input.getPoint({ prompt: 'Origin point' })
    if (origin.kind !== 'point') return
    const c = origin.point

    for (;;) {
      const first = await input.getPoint({
        prompt: 'Scale factor or first reference point',
        base: c,
        acceptNumber: true,
        options: [yesNo('Copy', memory.scaleCopy)],
      })
      if (first.kind === 'option') {
        memory.scaleCopy = !memory.scaleCopy
        continue
      }
      if (first.kind === 'number') {
        if (first.value <= 0) throw new Error('The scale factor must be positive')
        return applyTransform(ctx, ids, scaleAbout(c, first.value), memory.scaleCopy)
      }
      if (first.kind !== 'point') return

      const refLength = first.point.distanceTo(c)
      if (refLength < 1e-9) throw new Error('The reference point is on the origin')
      const factorAt = (p: Vector3) => p.distanceTo(c) / refLength
      const second = await input.getPoint({
        prompt: 'Second reference point',
        base: c,
        acceptNumber: true,
        preview: transformedPreview(ctx, ids, (p) => (factorAt(p) > 1e-9 ? scaleAbout(c, factorAt(p)) : null)),
      })
      const factor = second.kind === 'number' ? second.value : second.kind === 'point' ? factorAt(second.point) : null
      if (factor !== null && factor > 1e-9) applyTransform(ctx, ids, scaleAbout(c, factor), memory.scaleCopy)
      return
    }
  },
}

/**
 * Scale1D: stretches along one direction only, from the origin through a reference point. Surfaces
 * and solids too: their NURBS are stretched with them, exactly.
 */
const scale1D: Command = {
  name: 'Scale1D',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to scale')
    const origin = await input.getPoint({ prompt: 'Origin point' })
    if (origin.kind !== 'point') return
    const c = origin.point
    for (;;) {
      const first = await input.getPoint({
        prompt: 'Scale factor or first reference point',
        base: c,
        acceptNumber: true,
        options: [yesNo('Copy', memory.scaleCopy)],
      })
      if (first.kind === 'option') {
        memory.scaleCopy = !memory.scaleCopy
        continue
      }
      if (first.kind === 'number') {
        if (first.value <= 0) throw new Error('The scale factor must be positive')
        const factor = first.value
        const along = await input.getPoint({
          prompt: 'Direction to scale in',
          base: c,
          preview: transformedPreview(ctx, ids, (p) => (p.distanceTo(c) > 1e-9 ? scaleAlong(c, p.clone().sub(c), factor) : null)),
        })
        if (along.kind !== 'point' || along.point.distanceTo(c) < 1e-9) return
        return applyTransform(ctx, ids, scaleAlong(c, along.point.clone().sub(c), factor), memory.scaleCopy)
      }
      if (first.kind !== 'point') return
      const ref = first.point.clone().sub(c)
      const refLength = ref.length()
      if (refLength < 1e-9) throw new Error('The reference point is on the origin')
      const dir = ref.clone().normalize()
      // How far the second point is along the first's direction, as a factor.
      const factorAt = (p: Vector3) => p.clone().sub(c).dot(dir) / refLength
      const second = await input.getPoint({
        prompt: 'Second reference point',
        base: c,
        acceptNumber: true,
        preview: transformedPreview(ctx, ids, (p) => (factorAt(p) > 1e-9 ? scaleAlong(c, dir, factorAt(p)) : null)),
      })
      const factor = second.kind === 'number' ? second.value : second.kind === 'point' ? factorAt(second.point) : null
      if (factor !== null && factor > 1e-9) applyTransform(ctx, ids, scaleAlong(c, dir, factor), memory.scaleCopy)
      return
    }
  },
}

/** Scale2D: scales in the construction plane's directions only, keeping heights. */
const scale2D: Command = {
  name: 'Scale2D',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to scale')
    const origin = await input.getPoint({ prompt: 'Origin point' })
    if (origin.kind !== 'point') return
    const c = origin.point
    const n = origin.viewport.cplane.normal
    for (;;) {
      const first = await input.getPoint({
        prompt: 'Scale factor or first reference point',
        base: c,
        acceptNumber: true,
        options: [yesNo('Copy', memory.scaleCopy)],
      })
      if (first.kind === 'option') {
        memory.scaleCopy = !memory.scaleCopy
        continue
      }
      if (first.kind === 'number') {
        if (first.value <= 0) throw new Error('The scale factor must be positive')
        return applyTransform(ctx, ids, scaleAcross(c, n, first.value), memory.scaleCopy)
      }
      if (first.kind !== 'point') return
      // Distances measured in the plane.
      const flat = (p: Vector3) => {
        const d = p.clone().sub(c)
        return d.addScaledVector(n, -d.dot(n)).length()
      }
      const refLength = flat(first.point)
      if (refLength < 1e-9) throw new Error('The reference point is on the origin')
      const factorAt = (p: Vector3) => flat(p) / refLength
      const second = await input.getPoint({
        prompt: 'Second reference point',
        base: c,
        acceptNumber: true,
        preview: transformedPreview(ctx, ids, (p) => (factorAt(p) > 1e-9 ? scaleAcross(c, n, factorAt(p)) : null)),
      })
      const factor = second.kind === 'number' ? second.value : second.kind === 'point' ? factorAt(second.point) : null
      if (factor !== null && factor > 1e-9) applyTransform(ctx, ids, scaleAcross(c, n, factor), memory.scaleCopy)
      return
    }
  },
}

/**
 * ProjectToCPlane: flattens curves, points, meshes, texts and hatches onto the active construction
 * plane, straight along its normal. Surfaces and solids are left as they are (Make2D or Section
 * draws them flat).
 */
const projectToCPlane: Command = {
  name: 'ProjectToCPlane',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const selected = await input.getObjects('Select objects to project to the construction plane')
    const ids = selected.filter((id) => !['brep', 'instance', 'clipping'].includes(doc.objects.get(id)?.geometry.type ?? ''))
    if (ids.length === 0) throw new Error('Surfaces, solids and blocks cannot be flattened: use Make2D or Section for them')
    for (;;) {
      const option = await input.getOption('Press Enter to project', [yesNo('DeleteInput', memory.projectDelete)])
      if (option === null) break
      memory.projectDelete = !memory.projectDelete
    }
    const { origin, normal } = display.active.cplane
    applyTransform(ctx, ids, scaleAlong(origin, normal, 0), !memory.projectDelete)
    const skipped = selected.length - ids.length
    log(`${ids.length} object${ids.length === 1 ? '' : 's'} projected to the construction plane${skipped > 0 ? `; ${skipped} surface${skipped === 1 ? '' : 's'}, solid${skipped === 1 ? '' : 's'} or block${skipped === 1 ? '' : 's'} left as they are` : ''}`)
  },
}

const mirror: Command = {
  name: 'Mirror',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to mirror')
    for (;;) {
      const start = await input.getPoint({ prompt: 'Start of mirror plane', options: [yesNo('Copy', memory.mirrorCopy)] })
      if (start.kind === 'option') {
        memory.mirrorCopy = !memory.mirrorCopy
        continue
      }
      if (start.kind !== 'point') return
      const a = start.point
      const n = start.viewport.cplane.normal
      // The mirror plane contains the picked line and the construction plane's normal.
      const planeNormal = (p: Vector3) => {
        const m = p.clone().sub(a).cross(n)
        return m.length() > 1e-9 ? m.normalize() : null
      }
      const end = await input.getPoint({
        prompt: 'End of mirror plane',
        base: a,
        preview: transformedPreview(ctx, ids, (p) => {
          const m = planeNormal(p)
          return m ? mirrorIn(a, m) : null
        }),
      })
      if (end.kind !== 'point') return
      const m = planeNormal(end.point)
      if (m) applyTransform(ctx, ids, mirrorIn(a, m), memory.mirrorCopy)
      return
    }
  },
}

/** Asks for a number; Enter keeps the given default. */
async function getValue(ctx: Parameters<Command['run']>[0], prompt: string, value: number): Promise<number> {
  const result = await ctx.input.getNumber(prompt, value)
  if (typeof result !== 'number') throw new CancelError()
  return result
}

/** Asks for a whole number of at least `min`, remembering the answer. */
async function getCount(ctx: Parameters<Command['run']>[0], prompt: string, value: number, min: number): Promise<number> {
  const count = Math.round(await getValue(ctx, prompt, value))
  if (count < min) throw new Error(`${prompt} must be at least ${min}`)
  return count
}

const array: Command = {
  name: 'Array',
  async run(ctx) {
    const { input, display, log } = ctx
    const ids = await input.getObjects('Select objects to array')
    memory.arrayX = await getCount(ctx, 'Number in X direction', memory.arrayX, 1)
    memory.arrayY = await getCount(ctx, 'Number in Y direction', memory.arrayY, 1)
    if (memory.arrayX > 1) memory.arraySpacingX = await getValue(ctx, 'Spacing in X direction', memory.arraySpacingX)
    if (memory.arrayY > 1) memory.arraySpacingY = await getValue(ctx, 'Spacing in Y direction', memory.arraySpacingY)

    // Rows and columns follow the axes of the active viewport's construction plane.
    const { xaxis, yaxis } = display.active.cplane
    let copies = 0
    for (let i = 0; i < memory.arrayX; i++) {
      for (let j = 0; j < memory.arrayY; j++) {
        if (i === 0 && j === 0) continue
        const d = xaxis.clone().multiplyScalar(i * memory.arraySpacingX).addScaledVector(yaxis, j * memory.arraySpacingY)
        applyTransform(ctx, ids, new Matrix4().makeTranslation(d.x, d.y, d.z), true)
        copies++
      }
    }
    log(`${copies} ${copies === 1 ? 'copy' : 'copies'} created`)
  },
}

/** ArrayCrv: copies along a curve, evenly by number or by distance, turning with it or not. */
const arrayCrv: Command = {
  name: 'ArrayCrv',
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = await input.getObjects('Select objects to array')
    const base = await input.getPoint({ prompt: 'Base point (where on the objects follows the curve)' })
    if (base.kind !== 'point') return
    const pick = await input.getPick('Select the path curve', [], (id) => {
      const g = doc.objects.get(id)?.geometry
      return !!g && isCurve(g)
    })
    if (pick.kind !== 'pick') return
    const path = doc.objects.get(pick.id)?.geometry
    if (!path || !isCurve(path)) throw new Error('The path must be a curve')
    const orientations: CurveArrayOrientation[] = ['freeform', 'roadlike', 'none']
    const names = { freeform: 'Freeform', roadlike: 'Roadlike', none: 'NoRotation' }
    for (;;) {
      const options = [valueOption('Items', memory.curveArrayCount), valueOption('Distance', memory.curveArrayDistance), `Orientation=${names[memory.curveArrayOrientation]}`]
      const r = await input.getNumber(memory.curveArrayByDistance ? 'Distance between items' : 'Number of items', memory.curveArrayByDistance ? memory.curveArrayDistance : memory.curveArrayCount, options)
      if (typeof r === 'number') {
        if (memory.curveArrayByDistance) {
          if (r <= 0) throw new Error('The distance must be more than zero')
          memory.curveArrayDistance = r
        } else {
          if (r < 1 || !Number.isInteger(r)) throw new Error('The number of items must be a whole number, 1 or more')
          memory.curveArrayCount = r
        }
        break
      }
      if (isOption(r, 'Items')) memory.curveArrayByDistance = false
      else if (isOption(r, 'Distance')) memory.curveArrayByDistance = true
      else if (isOption(r, 'Orientation')) memory.curveArrayOrientation = orientations[(orientations.indexOf(memory.curveArrayOrientation) + 1) % orientations.length]
    }
    const total = length(path)
    const closed = isClosed(path)
    const distances: number[] = []
    if (memory.curveArrayByDistance) {
      for (let s = 0; s <= total * (1 + 1e-12); s += memory.curveArrayDistance) distances.push(Math.min(s, total))
      if (closed && distances.length > 1 && total - distances[distances.length - 1] < memory.curveArrayDistance * 1e-9) distances.pop()
    } else {
      const n = memory.curveArrayCount
      // On a closed curve the last would land on the first.
      const parts = closed ? n : Math.max(n - 1, 1)
      for (let i = 0; i < n; i++) distances.push(n === 1 ? 0 : (total * i) / parts)
    }
    const matrices = curveArrayMatrices(path, base.point, distances, memory.curveArrayOrientation, display.active.cplane.normal)
    for (const m of matrices) applyTransform(ctx, ids, m, true)
    log(`${matrices.length} cop${matrices.length === 1 ? 'y' : 'ies'} along the curve`)
  },
}

const arrayPolar: Command = {
  name: 'ArrayPolar',
  async run(ctx) {
    const { input, log } = ctx
    const ids = await input.getObjects('Select objects to array')
    const center = await input.getPoint({ prompt: 'Center of polar array' })
    if (center.kind !== 'point') return
    const n = center.viewport.cplane.normal
    memory.polarCount = await getCount(ctx, 'Number of items', memory.polarCount, 2)

    for (;;) {
      const result = await input.getNumber('Angle to fill', memory.polarAngle, [valueOption('Count', memory.polarCount)])
      if (typeof result === 'string') {
        if (isOption(result, 'Count')) memory.polarCount = await getCount(ctx, 'Number of items', memory.polarCount, 2)
        continue
      }
      memory.polarAngle = result
      break
    }
    const full = Math.abs(Math.abs(memory.polarAngle) - 360) < 1e-9
    // A full circle spaces the items evenly; a partial one puts the last item at the end of the angle.
    const step = (memory.polarAngle * DEG) / (full ? memory.polarCount : memory.polarCount - 1)
    for (let k = 1; k < memory.polarCount; k++) applyTransform(ctx, ids, rotationAbout(center.point, n, step * k), true)
    log(`${memory.polarCount - 1} ${memory.polarCount === 2 ? 'copy' : 'copies'} created`)
  },
}

export const transformCommands: Command[] = [rotate, scale, scale1D, scale2D, projectToCPlane, mirror, array, arrayPolar, arrayCrv]
