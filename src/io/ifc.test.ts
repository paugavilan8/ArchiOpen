import { IfcAPI } from 'web-ifc'
import { beforeAll, describe, expect, it } from 'vitest'
import { ifcGuid, stepReal, stepString, writeIfc, type IfcMesh, type IfcModel } from './ifc'
import { layerName, readIfc } from './ifcRead'

/** A box from (x0, y0, z0) to (x1, y1, z1) as triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): IfcMesh {
  const vertices = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]
  return { vertices, triangles: quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]) }
}

const model = (): IfcModel => ({
  project: "Casa 'Ñ'",
  toMeters: 1e-3,
  levels: [
    { name: 'Ground', elevation: 0, height: 3000 },
    { name: 'First', elevation: 3000, height: 3000 },
  ],
  elements: [
    { type: 'IfcWall', name: 'Wall 1', level: 'Ground', meshes: [box(0, 0, 0, 4000, 200, 3000)] },
    { type: 'IfcSlab', name: 'Slab 1', level: 'First', predefined: 'FLOOR', meshes: [box(0, 0, 2750, 4000, 3000, 3000)] },
    { type: 'IfcWindow', name: 'Window 1', level: 'Ground', predefined: 'WINDOW', width: 1200, height: 1200, meshes: [box(1000, 0, 900, 2200, 200, 2100)] },
    { type: 'IfcDoor', name: 'Door 1', level: 'Ground', predefined: 'DOOR', operation: 'SINGLE_SWING_LEFT', width: 900, height: 2100, meshes: [box(2500, 0, 0, 3400, 200, 2100)] },
  ],
  spaces: [
    {
      name: 'Salón',
      level: 'Ground',
      loops: [
        [
          [0, 200],
          [4000, 200],
          [4000, 3000],
          [0, 3000],
        ],
      ],
      area: 4000 * 2800,
    },
  ],
})

let api: IfcAPI
beforeAll(async () => {
  api = new IfcAPI()
  await api.Init()
}, 60_000)

describe('IFC', () => {
  it('writes STEP values and GlobalIds', () => {
    expect(stepString("it's")).toBe("'it''s'")
    expect(stepString('Salón')).toBe("'Sal\\X2\\00F3\\X0\\n'")
    expect(stepReal(3)).toBe('3.')
    expect(stepReal(-0.25)).toBe('-0.25')
    const id = ifcGuid()
    expect(id).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/)
    expect(ifcGuid()).not.toBe(id)
  })

  it('writes a project with storeys, elements and spaces that web-ifc reads back in place', () => {
    const text = writeIfc(model(), { timestamp: '2026-01-01T00:00:00' })
    expect(text.startsWith('ISO-10303-21;')).toBe(true)
    expect(text).toContain("FILE_SCHEMA(('IFC4'));")
    expect(text).toMatch(/IFCWINDOW\('[^']+',\$,'Window 1',\$,\$,#\d+,#\d+,\$,1\.2,1\.2,\.WINDOW\.,\.NOTDEFINED\.,\$\)/)
    expect(text).toContain('.SINGLE_SWING_LEFT.')
    expect(text).toMatch(/IFCBUILDINGSTOREY\('[^']+',\$,'First',\$,\$,#\d+,\$,\$,\.ELEMENT\.,3\.\)/)
    expect(text).toContain("IFCQUANTITYAREA('NetFloorArea',$,$,11.2,$)")

    const read = readIfc(api, new TextEncoder().encode(text))
    expect(read.units).toBe('Millimeters')
    expect(read.levels).toEqual([
      { name: 'Ground', elevation: 0, height: 3000 },
      { name: 'First', elevation: 3000, height: 3000 },
    ])
    expect(Object.fromEntries(read.counts)).toEqual({ Wall: 1, Slab: 1, Window: 1, Door: 1, Space: 1 })
    // Spaces are kept hidden.
    expect(read.layers.find((l) => l.name === 'Space')!.visible).toBe(false)
    // Every element where it was, Z up, in millimeters.
    const bounds = (layer: string) => {
      const o = read.objects.find((x) => read.layers[x.layer].name === layer)!.geometry
      const v = o.type === 'mesh' ? o.vertices : []
      const axis = (k: number) => {
        const values = v.filter((_, i) => i % 3 === k)
        return [Math.min(...values), Math.max(...values)].map((n) => Math.round(n) + 0)
      }
      return [axis(0), axis(1), axis(2)]
    }
    expect(bounds('Wall')).toEqual([
      [0, 4000],
      [0, 200],
      [0, 3000],
    ])
    expect(bounds('Slab')).toEqual([
      [0, 4000],
      [0, 3000],
      [2750, 3000],
    ])
    expect(bounds('Window')).toEqual([
      [1000, 2200],
      [0, 200],
      [900, 2100],
    ])
    expect(bounds('Space')).toEqual([
      [0, 4000],
      [200, 3000],
      [0, 3000],
    ])
  })

  it('names layers after IFC classes', () => {
    expect(layerName('IFCWALLSTANDARDCASE')).toBe('Wall')
    expect(layerName('IFCFLOWTERMINAL')).toBe('Flowterminal')
  })
})
