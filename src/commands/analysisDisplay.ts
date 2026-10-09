import { Box3, Vector3 } from 'three'
import { curvatureAt } from '../core/curveTools'
import type { Document } from '../core/document'
import { AnyCurve, domain, isCurve, pointAt, SegmentGeometry, tessellate } from '../core/geometry'
import { nakedEdges } from '../core/mesh'
import { shapeOf } from '../kernel/brep'
import { borderCurves } from '../kernel/surfaceEdit'
import type { Display } from '../view/display'
import { isOption, plural, valueOption } from './helpers'
import type { Command, CommandContext } from './runner'
import { kernel } from './solids'

/** Analysis shown over the model: curvature combs, naked edges, zebra stripes and draft angles. */

const CURVATURE_COLOR = '#d0218f'
const EDGE_COLOR = '#e8178a'

const settings = {
  /** Comb length, in percent of the automatic length. */
  combScale: 100,
  /** Hairs per span of a curve. */
  density: 32,
  draftAngle: 3,
}

// --- Curvature combs ---------------------------------------------------------------------

/** Hairs and their outline for one smooth piece of a curve; `scale` turns curvature into length. */
function comb(g: Exclude<AnyCurve, { type: 'polycurve' }>, scale: number): Vector3[][] {
  if (g.type === 'polyline') return [] // Straight pieces have no curvature.
  const [t0, t1] = domain(g)
  const spans = g.type === 'curve' ? new Set(g.knots.slice(g.degree, g.points.length + 1)).size - 1 : 4
  const count = Math.min(2000, Math.max(16, spans * settings.density))
  const tips: Vector3[] = []
  const lines: Vector3[][] = []
  for (let i = 0; i <= count; i++) {
    const t = t0 + ((t1 - t0) * i) / count
    const p = pointAt(g, t)
    // The comb stands on the outside of the bend, as long as the curvature is strong.
    const tip = p.clone().addScaledVector(curvatureAt(g, t), -scale)
    tips.push(tip)
    lines.push([p, tip])
  }
  lines.push(tips)
  return lines
}

const pieces = (g: AnyCurve): SegmentGeometry[] | Exclude<AnyCurve, { type: 'polycurve' }>[] => (g.type === 'polycurve' ? g.segments : [g])

/** Combs for every curve, scaled together so the strongest bend reaches a fifth of their size. */
export function curvatureCombs(curves: AnyCurve[]): Vector3[][] {
  const box = new Box3()
  let strongest = 0
  for (const c of curves) {
    for (const p of tessellate(c)) box.expandByPoint(p)
    for (const piece of pieces(c)) {
      if (piece.type === 'polyline') continue
      const [t0, t1] = domain(piece)
      for (let i = 0; i <= 64; i++) strongest = Math.max(strongest, curvatureAt(piece, t0 + ((t1 - t0) * i) / 64).length())
    }
  }
  if (strongest === 0) return []
  const scale = ((box.getSize(new Vector3()).length() * 0.2) / strongest) * (settings.combScale / 100)
  return curves.flatMap((c) => pieces(c).flatMap((piece) => comb(piece, scale)))
}

/** Which curves show combs, kept up to date as they are edited. */
class CurvatureGraph {
  readonly ids = new Set<number>()
  private listening = false

  constructor(
    private readonly doc: Document,
    private readonly display: Display,
  ) {}

  update(): void {
    const curves: AnyCurve[] = []
    for (const id of [...this.ids]) {
      const g = this.doc.objects.get(id)?.geometry
      if (g && isCurve(g)) curves.push(g)
      else this.ids.delete(id) // Deleted, or no longer a curve.
    }
    this.display.setOverlay('curvature', curvatureCombs(curves), CURVATURE_COLOR)
    if (!this.listening && this.ids.size > 0) {
      this.listening = true
      this.doc.on((kind) => {
        if (kind !== 'selection' && this.ids.size > 0) this.update()
      })
    }
  }
}

const graphs = new WeakMap<Document, CurvatureGraph>()
const graphOf = (ctx: CommandContext) => {
  let graph = graphs.get(ctx.doc)
  if (!graph) graphs.set(ctx.doc, (graph = new CurvatureGraph(ctx.doc, ctx.display)))
  return graph
}

const curvatureGraphOn: Command = {
  name: 'CurvatureGraphOn',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select curves for curvature graph')).filter((id) => {
      const g = doc.objects.get(id)?.geometry
      return g && isCurve(g)
    })
    if (ids.length === 0) throw new Error('Select curves')
    const graph = graphOf(ctx)
    for (const id of ids) graph.ids.add(id)
    graph.update()
    doc.clearSelection()
    for (;;) {
      const option = await input.getOption('Curvature graph. Press Enter when done', [valueOption('Scale', settings.combScale), valueOption('Density', settings.density)])
      if (option === null) break
      const [name, current] = isOption(option, 'Scale') ? ['Comb length in percent', settings.combScale] : ['Hairs per span', settings.density]
      const n = await input.getNumber(name, current)
      if (typeof n !== 'number' || n <= 0) continue
      if (isOption(option, 'Scale')) settings.combScale = n
      else settings.density = Math.min(500, Math.round(n))
      graph.update()
    }
    log(`Curvature graph on for ${plural('curve', graph.ids.size)}. CurvatureGraphOff turns it off`)
  },
}

const curvatureGraphOff: Command = {
  name: 'CurvatureGraphOff',
  history: false,
  async run(ctx) {
    const graph = graphOf(ctx)
    graph.ids.clear()
    graph.update()
  },
}

// --- Naked edges ---------------------------------------------------------------------------

const showEdges: Command = {
  name: 'ShowEdges',
  history: false,
  async run(ctx) {
    const { doc, input, display, log } = ctx
    const ids = (await input.getObjects('Select surfaces, polysurfaces or meshes')).filter((id) => {
      const t = doc.objects.get(id)?.geometry.type
      return t === 'brep' || t === 'mesh'
    })
    if (ids.length === 0) throw new Error('Select surfaces, polysurfaces or meshes')
    const lines: Vector3[][] = []
    let count = 0
    for (const id of ids) {
      const g = doc.objects.get(id)!.geometry
      if (g.type === 'mesh') {
        const edges = nakedEdges(g)
        count += edges.length
        lines.push(...edges)
      } else if (g.type === 'brep') {
        await kernel(ctx)
        // Naked edges joined into the open borders they make.
        const borders = borderCurves(shapeOf(g))
        count += borders.length
        lines.push(...borders.map((c) => tessellate(c)))
      }
    }
    doc.clearSelection()
    display.setOverlay('edges', lines, EDGE_COLOR)
    try {
      await input.getOption(count === 0 ? 'No naked edges: the objects are closed. Press Enter when done' : `${plural('naked edge', count)} shown. Press Enter when done`, [])
    } finally {
      display.setOverlay('edges', [], EDGE_COLOR)
    }
    log(count === 0 ? 'No naked edges' : `${plural('naked edge', count)}: Join, Cap, Weld or FillMeshHoles may close them`)
  },
}

// --- Surface analysis ----------------------------------------------------------------------

/** The surfaces and meshes to analyze. */
async function surfaceAnalysis(ctx: CommandContext, prompt: string): Promise<number[]> {
  const { doc, input } = ctx
  const ids = (await input.getObjects(prompt)).filter((id) => {
    const t = doc.objects.get(id)?.geometry.type
    return t === 'brep' || t === 'mesh'
  })
  if (ids.length === 0) throw new Error('Select surfaces, polysurfaces, solids or meshes')
  doc.clearSelection()
  return ids
}

const zebra: Command = {
  name: 'Zebra',
  history: false,
  async run(ctx) {
    const ids = await surfaceAnalysis(ctx, 'Select surfaces for zebra analysis')
    ctx.display.setSurfaceAnalysis({ mode: { kind: 'zebra' }, ids })
    ctx.log('Zebra stripes on. Breaks in the stripes show where surfaces meet without tangency. ZebraOff turns it off')
  },
}

const draftAngle: Command = {
  name: 'DraftAngleAnalysis',
  history: false,
  async run(ctx) {
    const { input, display, log } = ctx
    const ids = await surfaceAnalysis(ctx, 'Select surfaces for draft angle analysis')
    const n = await input.getNumber('Draft angle in degrees', settings.draftAngle)
    if (typeof n !== 'number') return
    if (n < 0 || n >= 90) throw new Error('The draft angle must be between 0 and 90 degrees')
    settings.draftAngle = n
    const pull = display.active.cplane.normal.clone()
    display.setSurfaceAnalysis({ mode: { kind: 'draft', angle: n, pull }, ids })
    log(`Draft along the construction plane's normal: green leans away by ${n}° or more, yellow by less, red leans back. DraftAngleAnalysisOff turns it off`)
  },
}

/** Turns off whichever surface analysis is on. */
function analysisOff(name: string): Command {
  return {
    name,
    history: false,
    async run({ display }) {
      display.setSurfaceAnalysis(null)
    },
  }
}

export const analysisDisplayCommands: Command[] = [
  curvatureGraphOn,
  curvatureGraphOff,
  showEdges,
  zebra,
  analysisOff('ZebraOff'),
  draftAngle,
  analysisOff('DraftAngleAnalysisOff'),
]
