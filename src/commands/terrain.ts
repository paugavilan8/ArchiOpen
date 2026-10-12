import { Vector3 } from 'three'
import { isClosed, isCurve, tessellate, type AnyCurve } from '../core/geometry'
import { MATERIAL_PRESETS } from '../core/materials'
import { resample, terrainMesh } from '../core/terrain'
import { layerNamed } from './drawing'
import { formatValue, isOption, valueOption } from './helpers'
import type { Command } from './runner'

/**
 * Terrain: a surface through point objects and contour lines (curves at their heights, sampled
 * every `Spacing`), optionally cut to a closed boundary curve and given a base below it so that it
 * is a solid. It goes on a Terrain layer as a mesh.
 */

const memory = { base: 0, spacing: 0, maxEdge: 0 }

const terrain: Command = {
  name: 'Terrain',
  async run(ctx) {
    const { doc, input, log } = ctx
    let boundaryId: number | null = null
    for (;;) {
      const option = await input.getOption('Terrain from points and contour lines. Press Enter to select them', [
        'Select',
        boundaryId === null ? 'Boundary=None' : 'Boundary=Curve',
        valueOption('Base', memory.base),
        memory.spacing > 0 ? valueOption('Spacing', memory.spacing) : 'Spacing=Auto',
        memory.maxEdge > 0 ? valueOption('MaxEdge', memory.maxEdge) : 'MaxEdge=None',
      ])
      // Enter (or Select) goes on to the points and curves.
      if (option === null) break
      if (isOption(option, 'Boundary')) {
        const closed = (id: number) => {
          const g = doc.objects.get(id)?.geometry
          return !!g && isCurve(g) && isClosed(g)
        }
        const r = await input.getPick('Pick a closed curve to cut the terrain to. Press Enter for none', [], closed)
        boundaryId = r.kind === 'pick' ? r.id : null
      } else if (isOption(option, 'Base')) {
        const v = await input.getNumber('Depth of the base below the lowest point (0 for a surface only)', memory.base)
        if (typeof v === 'number' && v >= 0) memory.base = v
      } else if (isOption(option, 'Spacing')) {
        const v = await input.getNumber('Distance between points taken along contour lines (0 for automatic)', memory.spacing)
        if (typeof v === 'number' && v >= 0) memory.spacing = v
      } else if (isOption(option, 'MaxEdge')) {
        const v = await input.getNumber('Longest triangle side kept, in plan (0 for no limit)', memory.maxEdge)
        if (typeof v === 'number' && v >= 0) memory.maxEdge = v
      } else break
    }
    const ids = (await input.getObjects('Select point objects and contour lines')).filter((id) => {
      const g = id === boundaryId ? undefined : doc.objects.get(id)?.geometry
      return g?.type === 'point' || (g && isCurve(g))
    })
    if (ids.length === 0) throw new Error('Select point objects or curves at their heights')
    const curves = ids.map((id) => doc.objects.get(id)!.geometry).filter(isCurve) as AnyCurve[]
    const points = ids.flatMap((id) => {
      const g = doc.objects.get(id)!.geometry
      return g.type === 'point' ? [g.point.clone()] : []
    })
    // Contours sampled finely enough for their bends, by default a fiftieth of the site's size.
    const all = curves.flatMap((c) => tessellate(c))
    const xs = [...all.map((p) => p.x), ...points.map((p) => p.x)]
    const ys = [...all.map((p) => p.y), ...points.map((p) => p.y)]
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9)
    const spacing = memory.spacing > 0 ? memory.spacing : extent / 50
    for (const c of curves) {
      const pts = resample(tessellate(c), spacing)
      // A closed curve's last point is its first.
      points.push(...(isClosed(c) ? pts.slice(0, -1) : pts))
    }
    const boundaryCurve = boundaryId === null ? undefined : (doc.objects.get(boundaryId)?.geometry as AnyCurve | undefined)
    const boundary = boundaryCurve ? tessellate(boundaryCurve).map((p) => [p.x, p.y] as [number, number]) : undefined
    const mesh = terrainMesh(
      points.map((p) => new Vector3(p.x, p.y, p.z)),
      { base: memory.base, boundary, maxEdge: memory.maxEdge },
    )
    const layer = layerNamed(ctx, 'Terrain', '#7d8f55')
    if (!layer.material) {
      const name = 'Grass'
      if (!doc.materials.some((m) => m.name === name)) doc.setMaterials([...doc.materials, { ...MATERIAL_PRESETS.find((m) => m.name === 'White plaster')!, name, color: '#7d8f55', roughness: 0.95 }])
      doc.updateLayer(layer.id, { material: name })
    }
    const id = doc.add(mesh, layer.id).id
    doc.select([id])
    const triangles = mesh.faces.length / 4
    log(`Terrain made through ${points.length} points: ${triangles} faces${memory.base > 0 ? `, a solid with its base ${formatValue(memory.base)} below its lowest point` : ''}`)
  },
}

export const terrainCommands: Command[] = [terrain]
