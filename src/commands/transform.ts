import { Matrix4, Vector3 } from 'three'
import { CancelError } from '../input/interaction'
import {
  applyTransform,
  isOption,
  memory,
  mirrorIn,
  rotationAbout,
  scaleAbout,
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

export const transformCommands: Command[] = [rotate, scale, mirror, array, arrayPolar]
