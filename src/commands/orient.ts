import { Matrix4, Vector3 } from 'three'
import { flatten } from '../core/blocks'
import { wireframe, type Plane } from '../core/geometry'
import { transform } from '../core/curves'
import {
  ALIGN_MODES,
  alignOffsets,
  boxInPlane,
  distributeOffsets,
  orientByPoints,
  orientByThreePoints,
  type AlignMode,
  type DistributeMode,
  type OrientScale,
  type PlaneBox,
} from '../core/orient'
import { CancelError } from '../input/interaction'
import { applyTransform, isOption, plural, transformedPreview, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'

const remembered = {
  orientCopy: false,
  orientScale: 'No' as OrientScale,
  orient3Copy: false,
  distributeAxis: 0 as 0 | 1 | 2,
  distributeMode: 'Centers' as DistributeMode,
  distributeSpacing: null as number | null,
}

const SCALES: OrientScale[] = ['No', 'Uniform', 'OneDirection']

/** Asks for a point, offering options; the options are handled by `onOption`, then asked again. */
async function pointOrOption(
  ctx: CommandContext,
  ask: () => Promise<Awaited<ReturnType<CommandContext['input']['getPoint']>>>,
  onOption: (option: string) => void,
): Promise<Vector3 | null> {
  for (;;) {
    const result = await ask()
    if (result.kind === 'option') {
      onOption(result.option)
      continue
    }
    return result.kind === 'point' ? result.point : null
  }
}

const orient: Command = {
  name: 'Orient',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to orient')
    const options = () => [yesNo('Copy', remembered.orientCopy), `Scale=${remembered.orientScale}`]
    const onOption = (option: string) => {
      if (isOption(option, 'Copy')) remembered.orientCopy = !remembered.orientCopy
      if (isOption(option, 'Scale')) remembered.orientScale = SCALES[(SCALES.indexOf(remembered.orientScale) + 1) % SCALES.length]
    }
    const r1 = await pointOrOption(ctx, () => input.getPoint({ prompt: 'First reference point', options: options() }), onOption)
    if (!r1) throw new CancelError()
    // Enter after one reference point: the objects are only moved.
    const r2 = await pointOrOption(ctx, () => input.getPoint({ prompt: 'Second reference point. Press Enter to only move', base: r1, options: options() }), onOption)
    const from = r2 ? [r1, r2] : [r1]
    const t1 = await input.getPoint({
      prompt: 'First target point',
      base: r1,
      preview: transformedPreview(ctx, ids, (p) => orientByPoints([r1], [p])),
    })
    if (t1.kind !== 'point') throw new CancelError()
    let m = orientByPoints([r1], [t1.point])
    if (r2) {
      const tryOrient = (p: Vector3) => {
        try {
          return orientByPoints(from, [t1.point, p], remembered.orientScale)
        } catch {
          return null
        }
      }
      const t2 = await input.getPoint({ prompt: 'Second target point', base: t1.point, preview: transformedPreview(ctx, ids, tryOrient) })
      if (t2.kind !== 'point') throw new CancelError()
      m = orientByPoints(from, [t1.point, t2.point], remembered.orientScale)
    }
    applyTransform(ctx, ids, m, remembered.orientCopy)
    ctx.log(`${plural('object', ids.length)} ${remembered.orientCopy ? 'copied' : 'oriented'}`)
  },
}

const orient3Pt: Command = {
  name: 'Orient3Pt',
  async run(ctx) {
    const { input } = ctx
    const ids = await input.getObjects('Select objects to orient')
    const onOption = (option: string) => {
      if (isOption(option, 'Copy')) remembered.orient3Copy = !remembered.orient3Copy
    }
    const from: Vector3[] = []
    for (const name of ['First', 'Second', 'Third']) {
      const p = await pointOrOption(
        ctx,
        () => input.getPoint({ prompt: `${name} reference point`, base: from.at(-1), options: [yesNo('Copy', remembered.orient3Copy)] }),
        onOption,
      )
      if (!p) throw new CancelError()
      from.push(p)
    }
    const to: Vector3[] = []
    for (const name of ['First', 'Second', 'Third']) {
      // The objects follow the cursor once the target frame can be made from it.
      const preview =
        to.length === 2
          ? transformedPreview(ctx, ids, (p) => {
              try {
                return orientByThreePoints(from, [...to, p])
              } catch {
                return null
              }
            })
          : to.length === 0
            ? transformedPreview(ctx, ids, (p) => new Matrix4().makeTranslation(p.x - from[0].x, p.y - from[0].y, p.z - from[0].z))
            : undefined
      const result = await input.getPoint({ prompt: `${name} target point`, base: to.at(-1), preview })
      if (result.kind !== 'point') throw new CancelError()
      to.push(result.point)
    }
    applyTransform(ctx, ids, orientByThreePoints(from, to), remembered.orient3Copy)
    ctx.log(`${plural('object', ids.length)} ${remembered.orient3Copy ? 'copied' : 'oriented'}`)
  },
}

/** The selected objects in units that move together: a group's members as one, other objects alone. */
function units(ctx: CommandContext, ids: number[]): number[][] {
  const byKey = new Map<string, number[]>()
  for (const id of ids) {
    const group = ctx.doc.objects.get(id)?.groups?.[0]
    const key = group === undefined ? `object ${id}` : `group ${group}`
    byKey.set(key, [...(byKey.get(key) ?? []), id])
  }
  return [...byKey.values()]
}

/** The boxes of some units along the axes of a construction plane. */
const unitBoxes = (ctx: CommandContext, groups: number[][], plane: Plane): PlaneBox[] =>
  groups.map((unit) => boxInPlane(unit.flatMap((id) => flatten(ctx.doc.objects.get(id)!.geometry)), plane))

/** A move along the construction plane's axes. */
function moveInPlane(plane: Plane, x: number, y: number, z = 0): Matrix4 {
  const d = plane.xaxis.clone().multiplyScalar(x).addScaledVector(plane.yaxis, y).addScaledVector(plane.normal, z)
  return new Matrix4().makeTranslation(d.x, d.y, d.z)
}

/** Draws where each unit would go. */
function previewMoves(ctx: CommandContext, groups: number[][], moves: Matrix4[]): Vector3[][] {
  return groups.flatMap((unit, i) => unit.flatMap((id) => wireframe(transform(ctx.doc.objects.get(id)!.geometry, moves[i]))))
}

const align: Command = {
  name: 'Align',
  async run(ctx) {
    const { input, display } = ctx
    const ids = await input.getObjects('Select objects to align')
    const plane = display.active.cplane
    const groups = units(ctx, ids)
    const mode = (await input.getOption('Alignment', ALIGN_MODES)) as AlignMode | null
    if (!mode) return
    const boxes = unitBoxes(ctx, groups, plane)
    const movesTo = (target?: Vector3) => {
      const local = target && { x: target.clone().sub(plane.origin).dot(plane.xaxis), y: target.clone().sub(plane.origin).dot(plane.yaxis) }
      return alignOffsets(boxes, mode, local).map((o) => moveInPlane(plane, o.x, o.y))
    }
    if (groups.length < 2) {
      // One object (or group) can only be aligned to a point.
      const target = await input.getPoint({ prompt: 'Point to align to', preview: (p) => previewMoves(ctx, groups, movesTo(p)) })
      if (target.kind !== 'point') throw new CancelError()
      groups.forEach((unit, i) => applyTransform(ctx, unit, movesTo(target.point)[i], false))
      return
    }
    display.setPreview(previewMoves(ctx, groups, movesTo()))
    const target = await input.getPoint({
      prompt: 'Point to align to. Press Enter to line them up with each other',
      preview: (p) => previewMoves(ctx, groups, movesTo(p)),
    })
    if (target.kind !== 'point' && target.kind !== 'enter') throw new CancelError()
    const moves = movesTo(target.kind === 'point' ? target.point : undefined)
    groups.forEach((unit, i) => applyTransform(ctx, unit, moves[i], false))
    ctx.log(`${plural('object', ids.length)} aligned (${mode})`)
  },
}

const AXES = ['X', 'Y', 'Z'] as const

const distribute: Command = {
  name: 'Distribute',
  async run(ctx) {
    const { input, display } = ctx
    const ids = await input.getObjects('Select objects to distribute')
    const plane = display.active.cplane
    const groups = units(ctx, ids)
    if (groups.length < 3) throw new Error('Select at least three objects (or groups) to distribute')
    const boxes = unitBoxes(ctx, groups, plane)
    const moves = () => {
      const offsets = distributeOffsets(boxes, remembered.distributeAxis, remembered.distributeMode, remembered.distributeSpacing ?? undefined)
      return offsets.map((d) => {
        const axis = [0, 0, 0]
        axis[remembered.distributeAxis] = d
        return moveInPlane(plane, axis[0], axis[1], axis[2])
      })
    }
    for (;;) {
      display.setPreview(previewMoves(ctx, groups, moves()))
      const spacing = remembered.distributeSpacing === null ? 'Auto' : String(Number(remembered.distributeSpacing.toFixed(4)))
      const option = await input.getOption('Distribute. Press Enter when done', [
        `Direction=${AXES[remembered.distributeAxis]}`,
        `Mode=${remembered.distributeMode}`,
        `Spacing=${spacing}`,
      ])
      if (option === null) break
      if (isOption(option, 'Direction')) remembered.distributeAxis = ((remembered.distributeAxis + 1) % 3) as 0 | 1 | 2
      if (isOption(option, 'Mode')) remembered.distributeMode = remembered.distributeMode === 'Centers' ? 'Gaps' : 'Centers'
      if (isOption(option, 'Spacing')) {
        const value = await input.getNumber('Spacing (0 for automatic: the first and last stay)', remembered.distributeSpacing ?? 0)
        if (typeof value === 'number') remembered.distributeSpacing = value > 0 ? value : null
      }
    }
    const m = moves()
    groups.forEach((unit, i) => applyTransform(ctx, unit, m[i], false))
    ctx.log(`${plural('object', ids.length)} distributed along ${AXES[remembered.distributeAxis]}`)
  },
}

export const orientCommands: Command[] = [orient, orient3Pt, align, distribute]
