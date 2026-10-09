import { Vector3 } from 'three'
import type { NamedCPlane } from '../core/document'
import type { Display } from '../view/display'
import { DisplayMode, ViewKind, worldPlane } from '../view/viewport'
import { isOption } from './helpers'
import type { Command, CommandContext } from './runner'

/** Construction planes, saved views and display modes. */

const triple = (v: Vector3) => v.toArray() as [number, number, number]

/** Applies a saved construction plane to a viewport. */
export function applyCPlane(display: Display, plane: NamedCPlane): void {
  display.active.setCPlane({ origin: new Vector3(...plane.origin), xaxis: new Vector3(...plane.xaxis), yaxis: new Vector3(...plane.yaxis) })
  display.requestRender()
}

/** Restores a saved view in the viewport of its kind, which becomes the active one. */
export function restoreView(display: Display, name: string, views: { name: string; kind: string; state: Display['active']['state'] }[]): boolean {
  const view = views.find((v) => v.name.toLowerCase() === name.toLowerCase())
  const vp = view && display.viewports.find((v) => v.kind === view.kind)
  if (!view || !vp) return false
  display.setActive(vp)
  vp.state = view.state
  display.requestRender()
  return true
}

const cplane: Command = {
  name: 'CPlane',
  history: false,
  async run({ display, input, log }) {
    const vp = display.active
    for (;;) {
      const r = await input.getPoint({ prompt: `New origin for the ${vp.kind} construction plane`, options: ['World', '3Point', 'Elevation'] })
      if (r.kind === 'point') {
        vp.setCPlane({ ...vp.cplane, origin: r.point })
        break
      }
      if (r.kind !== 'option') return
      if (isOption(r.option, 'World')) {
        vp.setCPlane(worldPlane(vp.kind as ViewKind))
        break
      }
      if (isOption(r.option, 'Elevation')) {
        const h = await input.getNumber('Distance along the plane normal', 0)
        if (typeof h !== 'number') return
        vp.setCPlane({ ...vp.cplane, origin: vp.cplane.origin.clone().addScaledVector(vp.cplane.normal, h) })
        break
      }
      // Three points: origin, a point on the X axis, and one on the side of the Y axis.
      const o = await input.getPoint({ prompt: 'Origin' })
      if (o.kind !== 'point') return
      const x = await input.getPoint({ prompt: 'Direction of the X axis', base: o.point })
      if (x.kind !== 'point') return
      const y = await input.getPoint({ prompt: 'Direction of the Y axis', base: o.point })
      if (y.kind !== 'point') return
      const xaxis = x.point.clone().sub(o.point)
      const yaxis = y.point.clone().sub(o.point)
      if (xaxis.length() < 1e-9 || xaxis.clone().cross(yaxis).length() < 1e-9) throw new Error('The three points must not be in line')
      vp.setCPlane({ origin: o.point, xaxis, yaxis })
      break
    }
    display.requestRender()
    log(`${vp.kind} construction plane at ${vp.cplane.origin.toArray().map((v) => +v.toFixed(3)).join(', ')}`)
  },
}

/** Save, restore or delete by name. */
async function named(ctx: CommandContext, what: string, names: string[]): Promise<{ action: 'Save' | 'Restore' | 'Delete'; name: string } | null> {
  const option = await ctx.input.getOption(`Named ${what}s${names.length ? ` (${names.join(', ')})` : ''}`, ['Save', 'Restore', 'Delete'])
  if (!option) return null
  const action = isOption(option, 'Save') ? 'Save' : isOption(option, 'Restore') ? 'Restore' : 'Delete'
  const name = (await ctx.input.getString(`Name of the ${what}`))?.trim()
  return name ? { action, name } : null
}

const namedView: Command = {
  name: 'NamedView',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, display, log } = ctx
    const answer = await named(ctx, 'view', doc.namedViews.map((v) => v.name))
    if (!answer) return
    const others = doc.namedViews.filter((v) => v.name.toLowerCase() !== answer.name.toLowerCase())
    if (answer.action === 'Save') {
      doc.setNamedViews([...others, { name: answer.name, kind: display.active.kind, state: display.active.state }])
      log(`View "${answer.name}" saved`)
    } else if (answer.action === 'Restore') {
      if (!restoreView(display, answer.name, doc.namedViews)) throw new Error(`There is no view named "${answer.name}"`)
    } else {
      if (others.length === doc.namedViews.length) throw new Error(`There is no view named "${answer.name}"`)
      doc.setNamedViews(others)
    }
  },
}

const namedCPlane: Command = {
  name: 'NamedCPlane',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, display, log } = ctx
    const answer = await named(ctx, 'construction plane', doc.namedCPlanes.map((p) => p.name))
    if (!answer) return
    const others = doc.namedCPlanes.filter((p) => p.name.toLowerCase() !== answer.name.toLowerCase())
    const plane = display.active.cplane
    if (answer.action === 'Save') {
      doc.setNamedCPlanes([...others, { name: answer.name, origin: triple(plane.origin), xaxis: triple(plane.xaxis), yaxis: triple(plane.yaxis) }])
      log(`Construction plane "${answer.name}" saved`)
    } else if (answer.action === 'Restore') {
      const saved = doc.namedCPlanes.find((p) => p.name.toLowerCase() === answer.name.toLowerCase())
      if (!saved) throw new Error(`There is no construction plane named "${answer.name}"`)
      applyCPlane(display, saved)
    } else {
      doc.setNamedCPlanes(others)
    }
  },
}

const MODES: [string, DisplayMode][] = [
  ['Wireframe', 'wireframe'],
  ['Shaded', 'shaded'],
  ['Ghosted', 'ghosted'],
  ['XRay', 'xray'],
]

const setDisplayMode: Command = {
  name: 'SetDisplayMode',
  history: false,
  async run({ display, input }) {
    const option = await input.getOption(`Display mode for ${display.active.kind}`, MODES.map(([label]) => label))
    const mode = MODES.find(([label]) => option && isOption(option, label))
    if (!mode) return
    display.active.mode = mode[1]
    display.requestRender()
  },
}

export const viewSetupCommands: Command[] = [cplane, namedView, namedCPlane, setDisplayMode]
