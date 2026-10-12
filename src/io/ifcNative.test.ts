import { Vector3 } from 'three'
import opencascade from 'replicad-opencascadejs'
import * as R from 'replicad'
import { IfcAPI } from 'web-ifc'
import { beforeAll, describe, expect, it } from 'vitest'
import { wallParams, type Opening } from '../core/architecture'
import type { AnyCurve, BrepGeometry } from '../core/geometry'
import { toBrep } from '../kernel/brep'
import { openingPartShape, slabShape, wallShape } from '../kernel/architecture'
import { writeIfc, type IfcElement } from './ifc'
import { readIfc } from './ifcRead'

let api: IfcAPI
beforeAll(async () => {
  R.setOC(await opencascade())
  api = new IfcAPI()
  await api.Init()
}, 60_000)

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const mesh = (g: BrepGeometry) => ({ vertices: [...g.display.vertices], triangles: [...g.display.triangles] })

describe('IFC walls and slabs as editable elements', () => {
  it('reads straight walls with their doors and windows, and slabs with their holes', () => {
    // A wall 6 m long, 250 thick, 3 m high, turned 30°, with a window and a door.
    const a = (30 * Math.PI) / 180
    const dir = v(Math.cos(a), Math.sin(a))
    const path: AnyCurve = { type: 'polyline', points: [v(1000, 500), v(1000, 500).addScaledVector(dir, 6000)], closed: false }
    const window: Opening = { id: 1, kind: 'window', at: 1500, width: 1200, height: 1200, sill: 900 }
    const door: Opening = { id: 2, kind: 'door', at: 4500, width: 900, height: 2100, sill: 0 }
    const params = wallParams({ thickness: 250, height: 3000, justification: 'center', openings: [window, door] })
    const wall = toBrep(wallShape(path, params))
    const parts = (o: Opening) => (o.kind === 'window' ? (['frame', 'glass'] as const) : (['frame', 'leaf'] as const)).map((p) => mesh(toBrep(openingPartShape(path, params, o, p))))
    // A slab 8 x 5 m with a stairwell, its top at 3000; and a curved wall that stays a mesh.
    const outline: AnyCurve = { type: 'polyline', points: [v(0, 0, 3000), v(8000, 0, 3000), v(8000, 5000, 3000), v(0, 5000, 3000)], closed: true }
    const slab = toBrep(slabShape(outline, { thickness: 250, holes: [{ points: [[1000, 1000], [3000, 1000], [3000, 2000], [1000, 2000]] }] }))
    const arc: AnyCurve = { type: 'arc', center: v(20000, 0), radius: 4000, start: 0, end: Math.PI / 2, xaxis: v(1, 0), yaxis: v(0, 1) } as unknown as AnyCurve
    let curved: BrepGeometry | null = null
    try {
      curved = toBrep(wallShape(arc, wallParams({ thickness: 200, height: 3000 })))
    } catch {
      curved = null
    }
    const elements: IfcElement[] = [
      { type: 'IfcWall', name: 'Wall 1', level: 'Ground', meshes: [mesh(wall)] },
      { type: 'IfcWindow', name: 'Window 1', level: 'Ground', meshes: parts(window), width: 1200, height: 1200 },
      { type: 'IfcDoor', name: 'Door 1', level: 'Ground', meshes: parts(door), width: 900, height: 2100 },
      { type: 'IfcSlab', name: 'Slab 1', level: 'Ground', meshes: [mesh(slab)] },
      ...(curved ? [{ type: 'IfcWall' as const, name: 'Wall 2', level: 'Ground', meshes: [mesh(curved)] }] : []),
    ]
    const text = writeIfc({ project: 'p', toMeters: 1e-3, levels: [{ name: 'Ground', elevation: 0, height: 3000 }], elements, spaces: [] })
    const read = readIfc(api, new TextEncoder().encode(text))

    expect(read.native.walls).toHaveLength(1)
    const w = read.native.walls[0]
    expect(w.thickness).toBeCloseTo(250, 0)
    expect(w.height).toBeCloseTo(3000, 0)
    // Its centre line: along the wall, 6 m long, on its base (either way round).
    const [p0, p1] = w.path
    expect(p0.distanceTo(p1)).toBeCloseTo(6000, 0)
    const ends = [p0, p1].map((p) => p.clone().sub(v(1000, 500)).length()).sort((x, y) => x - y)
    expect(ends[0]).toBeLessThan(1)
    expect(p0.z).toBeCloseTo(0, 3)
    // Its openings where they were, measured from the end the path starts at.
    const along = (at: number) => (p0.distanceTo(v(1000, 500)) < 1 ? at : 6000 - at)
    const byKind = Object.fromEntries(w.openings.map((o) => [o.kind, o]))
    expect(byKind.window.at).toBeCloseTo(along(1500), 0)
    expect(byKind.window.width).toBeCloseTo(1200, 0)
    expect(byKind.window.height).toBeCloseTo(1200, 0)
    expect(byKind.window.sill).toBeCloseTo(900, 0)
    expect(byKind.door.at).toBeCloseTo(along(4500), 0)
    expect(byKind.door.width).toBeCloseTo(900, 0)
    expect(byKind.door.height).toBeCloseTo(2100, 0)

    expect(read.native.slabs).toHaveLength(1)
    const s = read.native.slabs[0]
    expect(s.thickness).toBeCloseTo(250, 0)
    expect(s.outline).toHaveLength(4)
    expect(s.outline.every((p) => Math.abs(p.z - 3000) < 1e-6)).toBe(true)
    expect(s.holes).toHaveLength(1)
    expect(s.holes[0].points).toHaveLength(4)

    // What was taken in is not also a mesh; the curved wall is.
    expect(Object.fromEntries(read.counts)).toEqual(curved ? { Wall: 1 } : {})
  })
})
