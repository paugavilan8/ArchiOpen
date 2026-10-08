import type { Vector3 } from 'three'
import { removeControlPoints, translate } from '../core/curves'
import { tessellate } from '../core/geometry'
import type { Command, CommandContext } from './runner'

/** Preview callback that draws the given objects displaced from `from` to the cursor. */
function movedPreview({ doc }: CommandContext, ids: number[], from: Vector3) {
  const outlines = ids.map((id) => tessellate(doc.objects.get(id)!.geometry))
  return (p: Vector3) => {
    const delta = p.clone().sub(from)
    return outlines.map((pts) => pts.map((q) => q.clone().add(delta)))
  }
}

const move: Command = {
  name: 'Move',
  async run(ctx) {
    const { doc, input } = ctx
    const ids = await input.getObjects('Select objects to move')
    const from = await input.getPoint({ prompt: 'Point to move from' })
    if (from.kind !== 'point') return
    const to = await input.getPoint({
      prompt: 'Point to move to',
      base: from.point,
      preview: movedPreview(ctx, ids, from.point),
    })
    if (to.kind !== 'point') return
    const delta = to.point.clone().sub(from.point)
    for (const id of ids) doc.setGeometry(id, translate(doc.objects.get(id)!.geometry, delta))
  },
}

const copy: Command = {
  name: 'Copy',
  async run(ctx) {
    const { doc, input } = ctx
    const ids = await input.getObjects('Select objects to copy')
    const from = await input.getPoint({ prompt: 'Point to copy from' })
    if (from.kind !== 'point') return
    const preview = movedPreview(ctx, ids, from.point)

    for (;;) {
      const to = await input.getPoint({ prompt: 'Point to copy to', base: from.point, preview })
      if (to.kind !== 'point') break
      const delta = to.point.clone().sub(from.point)
      for (const id of ids) {
        const source = doc.objects.get(id)!
        doc.add(translate(source.geometry, delta), source.layerId)
      }
    }
  },
}

const del: Command = {
  name: 'Delete',
  async run({ doc, input, log }) {
    if (doc.selectedPointCount > 0) {
      // Selected control points are removed from their curves instead.
      let removed = 0
      for (const [id, indices] of [...doc.pointSelection]) {
        const result = removeControlPoints(doc.objects.get(id)!.geometry, indices)
        if (!result) {
          log('Not enough points would be left on a curve')
          continue
        }
        removed += indices.size
        doc.setGeometry(id, result)
      }
      doc.clearPointSelection()
      log(`${removed} control point${removed === 1 ? '' : 's'} deleted`)
      return
    }
    const ids = await input.getObjects('Select objects to delete')
    for (const id of ids) doc.remove(id)
    log(`${ids.length} object${ids.length === 1 ? '' : 's'} deleted`)
  },
}

const selAll: Command = {
  name: 'SelAll',
  run({ doc, log }) {
    const ids = [...doc.objects.values()].filter((o) => doc.isSelectable(o)).map((o) => o.id)
    doc.select(ids)
    log(`${ids.length} object${ids.length === 1 ? '' : 's'} selected`)
  },
}

const selNone: Command = {
  name: 'SelNone',
  run: ({ doc }) => doc.clearSelection(),
}

const undo: Command = {
  name: 'Undo',
  history: false,
  repeat: false,
  run({ doc, log }) {
    if (!doc.undo()) log('Nothing to undo')
  },
}

const redo: Command = {
  name: 'Redo',
  history: false,
  repeat: false,
  run({ doc, log }) {
    if (!doc.redo()) log('Nothing to redo')
  },
}

const pointsOn: Command = {
  name: 'PointsOn',
  history: false,
  async run({ doc, input, log }) {
    const ids = await input.getObjects('Select objects to show control points')
    const changed = doc.setPointsOn(ids, true)
    doc.clearSelection()
    const skipped = ids.filter((id) => !doc.pointsOn.has(id)).length
    log(`Control points on for ${changed} object${changed === 1 ? '' : 's'}` + (skipped ? `. ${skipped} skipped: circles, arcs and polycurves have no editable points yet` : ''))
  },
}

const pointsOff: Command = {
  name: 'PointsOff',
  history: false,
  repeat: false,
  run({ doc }) {
    doc.setPointsOn([...doc.pointsOn], false)
  },
}

export const editCommands: Command[] = [move, copy, del, selAll, selNone, undo, redo, pointsOn, pointsOff]
