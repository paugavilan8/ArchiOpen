import type { Vector3 } from 'three'
import { clippingCorners, type ClippingGeometry } from '../core/geometry'
import type { Command, CommandContext } from './runner'
import { plural } from './helpers'

/** The views a new clipping plane cuts. */
export const ALL_VIEWS = ['Top', 'Front', 'Right', 'Perspective']

/**
 * The clipping plane through the rectangle from `a` to `b` in a construction plane, facing away from
 * the viewer (as the view looks), so what is behind it stays and what is in front is cut away.
 */
export function clippingFromCorners(a: Vector3, b: Vector3, plane: { xaxis: Vector3; yaxis: Vector3 }): ClippingGeometry | null {
  const d = b.clone().sub(a)
  const width = Math.abs(d.dot(plane.xaxis))
  const height = Math.abs(d.dot(plane.yaxis))
  if (width < 1e-9 || height < 1e-9) return null
  return {
    type: 'clipping',
    center: a.clone().add(b).multiplyScalar(0.5),
    xaxis: plane.xaxis.clone(),
    // x × (−y) is the construction plane's normal reversed: into the screen.
    yaxis: plane.yaxis.clone().negate(),
    width,
    height,
    views: [...ALL_VIEWS],
  }
}

const clippingPlane: Command = {
  name: 'ClippingPlane',
  async run({ doc, input, log }) {
    const first = await input.getPoint({ prompt: 'First corner of clipping plane' })
    if (first.kind !== 'point') return
    const a = first.point
    const cplane = first.viewport.cplane
    const other = await input.getPoint({
      prompt: 'Other corner (type r20,10 for width and height)',
      base: a,
      rubberBand: false,
      preview: (p) => {
        const g = clippingFromCorners(a, p, cplane)
        if (!g) return []
        const c = clippingCorners(g)
        return [[...c, c[0]]]
      },
    })
    if (other.kind !== 'point') return
    const g = clippingFromCorners(a, other.point, cplane)
    if (!g) throw new Error('The clipping plane needs a width and a height')
    doc.add(g)
    log('Clipping plane added. It cuts in every view; Flip turns it around, and its properties say which views it cuts')
  },
}

/** Clipping planes among the given objects. */
const clippingIds = (ctx: CommandContext, ids: Iterable<number>) => [...ids].filter((id) => ctx.doc.objects.get(id)?.geometry.type === 'clipping')

/** Turns every clipping plane on or off in the active viewport. */
function clippingInView(on: boolean): Command {
  return {
    name: on ? 'EnableClippingPlanes' : 'DisableClippingPlanes',
    run(ctx) {
      const view = ctx.display.active.kind
      const ids = clippingIds(ctx, ctx.doc.objects.keys())
      if (ids.length === 0) throw new Error('There are no clipping planes')
      for (const id of ids) {
        const g = ctx.doc.objects.get(id)!.geometry as ClippingGeometry
        const views = on ? [...new Set([...g.views, view])] : g.views.filter((v) => v !== view)
        if (views.length !== g.views.length) ctx.doc.setGeometry(id, { ...g, views })
      }
      ctx.log(`${plural('clipping plane', ids.length)} ${on ? 'cut' : 'no longer cut'} the ${view} view`)
    },
  }
}

/** Turns clipping planes around, so they keep the other side. */
export function flipClipping(g: ClippingGeometry): ClippingGeometry {
  return { ...g, yaxis: g.yaxis.clone().negate() }
}

export const clippingCommands: Command[] = [clippingPlane, clippingInView(true), clippingInView(false)]
