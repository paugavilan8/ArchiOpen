import { Box3, Vector3 } from 'three'
import type { CadObject } from '../core/document'
import { BrepGeometry, MeshGeometry, TOLERANCE } from '../core/geometry'
import {
  brepDisplayMesh,
  faceCount,
  fillHoles,
  flipMesh,
  meshBox,
  meshCylinder,
  meshPlane,
  meshSphere,
  unifyNormals,
  unweldMesh,
  vertexCount,
  weldMesh,
} from '../core/mesh'
import { OBJ, STL } from '../app/files'
import { CancelError } from '../input/interaction'
import { writeObj, writeStl } from '../io/meshFiles'
import { meshToShape, shapeOf, shapeToMesh, toBrep } from '../kernel/brep'
import { isOption, plural, valueOption } from './helpers'
import { chosenObjects } from './plot'
import { boxLines, circleLines, getHeight, getRadius, kernel, memory as solidMemory } from './solids'
import type { Command, CommandContext } from './runner'

/** Face counts and settings the mesh commands remember. */
const memory = {
  xFaces: 10,
  yFaces: 10,
  zFaces: 10,
  around: 32,
  vertical: 16,
  /** Bands up the side of a cylinder. */
  bands: 1,
  density: 'Medium' as Density,
  weldTolerance: TOLERANCE,
}

type Density = 'Coarse' | 'Medium' | 'Fine'
const DENSITIES: Density[] = ['Coarse', 'Medium', 'Fine']
/** Largest distance from the surface (as a part of the object's size) and largest turn between facets. */
const DENSITY_SETTINGS: Record<Density, [number, number]> = { Coarse: [1 / 100, 0.5], Medium: [1 / 400, 0.25], Fine: [1 / 2000, 0.1] }

type CountKey = 'xFaces' | 'yFaces' | 'zFaces' | 'around' | 'vertical' | 'bands'
const COUNT_NAMES: Record<CountKey, string> = { xFaces: 'XFaces', yFaces: 'YFaces', zFaces: 'ZFaces', around: 'AroundFaces', vertical: 'VerticalFaces', bands: 'VerticalFaces' }
/** The fewest faces that still make the shape. */
const COUNT_MIN: Record<CountKey, number> = { xFaces: 1, yFaces: 1, zFaces: 1, around: 3, vertical: 2, bands: 1 }

/** Asks for the first point, letting the face counts be changed first. */
async function firstPoint(ctx: CommandContext, prompt: string, counts: CountKey[]) {
  for (;;) {
    const r = await ctx.input.getPoint({ prompt, options: counts.map((k) => valueOption(COUNT_NAMES[k], memory[k])) })
    if (r.kind === 'option') {
      const key = counts.find((k) => isOption(r.option, COUNT_NAMES[k]))!
      const n = await ctx.input.getNumber(`Number of faces (${COUNT_NAMES[key]})`, memory[key])
      if (typeof n === 'number') memory[key] = Math.min(1000, Math.max(COUNT_MIN[key], Math.round(n)))
      continue
    }
    if (r.kind !== 'point') throw new CancelError()
    return r
  }
}

const meshBoxCommand: Command = {
  name: 'MeshBox',
  async run(ctx) {
    const { doc, input } = ctx
    const first = await firstPoint(ctx, 'First corner of base', ['xFaces', 'yFaces', 'zFaces'])
    const a = first.point
    const { xaxis, yaxis, normal } = first.viewport.cplane
    const sides = (p: Vector3) => {
      const d = p.clone().sub(a)
      return [xaxis.clone().multiplyScalar(d.dot(xaxis)), yaxis.clone().multiplyScalar(d.dot(yaxis))]
    }
    const second = await input.getPoint({
      prompt: 'Other corner of base',
      base: a,
      rubberBand: false,
      preview: (p) => {
        const [u, v] = sides(p)
        return boxLines(a, u, v, new Vector3())
      },
    })
    if (second.kind !== 'point') return
    const [u, v] = sides(second.point)
    if (u.length() < 1e-9 || v.length() < 1e-9) throw new Error('The base has no area')
    const h = await getHeight(ctx, second.point, normal, (h) => boxLines(a, u, v, normal.clone().multiplyScalar(h)))
    if (Math.abs(h) < 1e-9) throw new Error('The height must not be zero')
    solidMemory.height = Math.abs(h)
    doc.add(meshBox(a, u, v, normal.clone().multiplyScalar(h), memory.xFaces, memory.yFaces, memory.zFaces))
  },
}

const meshSphereCommand: Command = {
  name: 'MeshSphere',
  async run(ctx) {
    const center = await firstPoint(ctx, 'Center of sphere', ['vertical', 'around'])
    const { xaxis, yaxis } = center.viewport.cplane
    const r = await getRadius(ctx, center.point, xaxis, yaxis)
    ctx.doc.add(meshSphere(center.point, r, xaxis, yaxis, memory.around, memory.vertical))
  },
}

const meshCylinderCommand: Command = {
  name: 'MeshCylinder',
  async run(ctx) {
    const base = await firstPoint(ctx, 'Center of base', ['bands', 'around'])
    const c = base.point
    const { xaxis, yaxis, normal } = base.viewport.cplane
    const r = await getRadius(ctx, c, xaxis, yaxis)
    const h = await getHeight(ctx, c, normal, (h) => {
      const top = c.clone().addScaledVector(normal, h)
      return [circleLines(c, xaxis, yaxis, r), circleLines(top, xaxis, yaxis, r)]
    })
    if (Math.abs(h) < 1e-9) throw new Error('The height must not be zero')
    solidMemory.height = Math.abs(h)
    ctx.doc.add(meshCylinder(c, r, h, xaxis, yaxis, memory.around, memory.bands))
  },
}

const meshPlaneCommand: Command = {
  name: 'MeshPlane',
  async run(ctx) {
    const first = await firstPoint(ctx, 'First corner of plane', ['xFaces', 'yFaces'])
    const a = first.point
    const { xaxis, yaxis } = first.viewport.cplane
    const sides = (p: Vector3) => {
      const d = p.clone().sub(a)
      return [xaxis.clone().multiplyScalar(d.dot(xaxis)), yaxis.clone().multiplyScalar(d.dot(yaxis))]
    }
    const second = await ctx.input.getPoint({
      prompt: 'Other corner',
      base: a,
      rubberBand: false,
      preview: (p) => {
        const [u, v] = sides(p)
        return boxLines(a, u, v, new Vector3()).slice(0, 1)
      },
    })
    if (second.kind !== 'point') return
    let [u, v] = sides(second.point)
    if (u.length() < 1e-9 || v.length() < 1e-9) throw new Error('The plane has no area')
    // Face up the construction plane, whichever corner was picked first.
    if (u.clone().cross(v).dot(first.viewport.cplane.normal) < 0) [u, v] = [v, u]
    ctx.doc.add(meshPlane(a, u, v, memory.xFaces, memory.yFaces))
  },
}

const meshOf = (o: CadObject | undefined): MeshGeometry | null => (o?.geometry.type === 'mesh' ? o.geometry : null)

/** Asks for meshes (the selection, if it has some). */
async function getMeshes(ctx: CommandContext, prompt: string): Promise<number[]> {
  const ids = (await ctx.input.getObjects(prompt)).filter((id) => meshOf(ctx.doc.objects.get(id)))
  if (ids.length === 0) throw new Error('Select meshes')
  return ids
}

const meshCommand: Command = {
  name: 'Mesh',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = (await input.getObjects('Select surfaces or solids to mesh')).filter((id) => doc.objects.get(id)?.geometry.type === 'brep')
    if (ids.length === 0) throw new Error('Select surfaces, polysurfaces or solids')
    for (;;) {
      const option = await input.getOption('Mesh density. Press Enter to mesh', [`Density=${memory.density}`])
      if (option === null) break
      memory.density = DENSITIES[(DENSITIES.indexOf(memory.density) + 1) % DENSITIES.length]
    }
    await kernel(ctx)
    const [relative, angle] = DENSITY_SETTINGS[memory.density]
    const made: number[] = []
    let faces = 0
    for (const id of ids) {
      const obj = doc.objects.get(id)!
      const g = obj.geometry as BrepGeometry
      const box = new Box3().setFromArray(g.display.vertices)
      const size = Math.max(1e-6, box.getSize(new Vector3()).length())
      const mesh = shapeToMesh(shapeOf(g), size * relative, angle)
      faces += faceCount(mesh)
      made.push(doc.add(mesh, obj.layerId).id)
    }
    // As in Rhino, the originals stay; the new meshes are selected.
    doc.select(made)
    log(`${plural('mesh', made.length)} made with ${faces} faces (${memory.density.toLowerCase()}). The originals are kept`)
  },
}

const MAX_NURB_FACES = 20000

const meshToNurb: Command = {
  name: 'MeshToNURB',
  async run(ctx) {
    const { doc, log } = ctx
    const ids = await getMeshes(ctx, 'Select meshes to turn into polysurfaces')
    const big = ids.find((id) => faceCount(meshOf(doc.objects.get(id))!) > MAX_NURB_FACES)
    if (big !== undefined) throw new Error(`A mesh has more than ${MAX_NURB_FACES} faces: as one flat surface per face it would be too heavy to work with`)
    await kernel(ctx)
    const made: number[] = []
    for (const id of ids) {
      const obj = doc.objects.get(id)!
      try {
        made.push(doc.add(toBrep(meshToShape(meshOf(obj)!)), obj.layerId).id)
      } catch (error) {
        console.error(error)
        throw new Error('Could not turn the mesh into a polysurface')
      }
    }
    doc.select(made)
    const solids = made.filter((id) => (doc.objects.get(id)!.geometry as BrepGeometry).kind === 'solid').length
    log(`${plural('polysurface', made.length)} made${solids > 0 ? ` (${solids} closed, as solids)` : ''}. The meshes are kept`)
  },
}

/** Replaces each chosen mesh with `change(mesh)`; `report` describes what was done. */
function meshEdit(name: string, prompt: string, change: (g: MeshGeometry, ctx: CommandContext) => MeshGeometry, report: (count: number) => string): Command {
  return {
    name,
    async run(ctx) {
      const ids = await getMeshes(ctx, prompt)
      for (const id of ids) ctx.doc.setGeometry(id, change(meshOf(ctx.doc.objects.get(id))!, ctx))
      ctx.log(report(ids.length))
    },
  }
}

const weld: Command = {
  name: 'Weld',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await getMeshes(ctx, 'Select meshes to weld')
    const tol = await input.getNumber('Join vertices closer than', memory.weldTolerance)
    if (typeof tol !== 'number') return
    if (tol < 0) throw new Error('The distance cannot be negative')
    memory.weldTolerance = tol
    let before = 0
    let after = 0
    for (const id of ids) {
      const g = meshOf(doc.objects.get(id))!
      const welded = weldMesh(g, tol)
      before += vertexCount(g)
      after += vertexCount(welded)
      doc.setGeometry(id, welded)
    }
    log(`${before} vertices welded into ${after}`)
  },
}

const unifyMeshNormals: Command = {
  name: 'UnifyMeshNormals',
  async run(ctx) {
    const ids = await getMeshes(ctx, 'Select meshes')
    let flipped = 0
    for (const id of ids) {
      const result = unifyNormals(meshOf(ctx.doc.objects.get(id))!)
      flipped += result.flipped
      ctx.doc.setGeometry(id, result.mesh)
    }
    ctx.log(flipped === 0 ? 'All faces already agree' : `${plural('face', flipped)} turned round`)
  },
}

const fillMeshHoles: Command = {
  name: 'FillMeshHoles',
  async run(ctx) {
    const ids = await getMeshes(ctx, 'Select meshes with holes')
    let holes = 0
    for (const id of ids) {
      const result = fillHoles(meshOf(ctx.doc.objects.get(id))!)
      holes += result.holes
      if (result.holes > 0) ctx.doc.setGeometry(id, result.mesh)
    }
    ctx.log(holes === 0 ? 'No holes found' : `${plural('hole', holes)} filled`)
  },
}

/** Meshes and surfaces (as their display triangles) among the objects, with their names for OBJ. */
function exportMeshes(ctx: CommandContext): { name: string; mesh: MeshGeometry }[] {
  const out: { name: string; mesh: MeshGeometry }[] = []
  for (const o of chosenObjects(ctx)) {
    const g = o.geometry
    const layer = ctx.doc.layerOf(o).name
    if (g.type === 'mesh') out.push({ name: `${layer}_${o.id}`, mesh: g })
    else if (g.type === 'brep') out.push({ name: `${layer}_${o.id}`, mesh: brepDisplayMesh(g) })
  }
  if (out.length === 0) throw new Error('There are no meshes, surfaces or solids to export')
  return out
}

const exportStl: Command = {
  name: 'ExportSTL',
  history: false,
  repeat: false,
  async run(ctx) {
    const meshes = exportMeshes(ctx)
    const fileName = await ctx.files.exportFile(STL, () => writeStl(meshes.map((m) => m.mesh), ctx.files.name))
    if (fileName) ctx.log(`Exported ${plural('object', meshes.length)} to ${fileName} (in ${ctx.doc.units.toLowerCase()})`)
  },
}

const exportObj: Command = {
  name: 'ExportOBJ',
  history: false,
  repeat: false,
  async run(ctx) {
    const meshes = exportMeshes(ctx)
    const fileName = await ctx.files.exportFile(OBJ, () => writeObj(meshes))
    if (fileName) ctx.log(`Exported ${plural('object', meshes.length)} to ${fileName} (in ${ctx.doc.units.toLowerCase()})`)
  },
}

export const meshCommands: Command[] = [
  meshCommand,
  meshBoxCommand,
  meshSphereCommand,
  meshCylinderCommand,
  meshPlaneCommand,
  meshToNurb,
  weld,
  meshEdit('Unweld', 'Select meshes to unweld', unweldMesh, (n) => `${plural('mesh', n)} unwelded: every face has its own vertices`),
  meshEdit('Flip', 'Select meshes to flip', flipMesh, (n) => `${plural('mesh', n)} flipped`),
  unifyMeshNormals,
  fillMeshHoles,
  exportStl,
  exportObj,
]
