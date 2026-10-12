import { Matrix4 } from 'three'
import { transform } from '../core/curves'
import type { Document } from '../core/document'
import { BlockDefinition, Geometry, geometryFromJSON, geometryToJSON } from '../core/geometry'
import type { RhinoImport } from '../io/rhino3dm'
import { METERS } from '../core/units'

/** Every block definition the geometry uses, nested ones included. */
function definitionsIn(geometries: Geometry[], out = new Set<BlockDefinition>()): Set<BlockDefinition> {
  for (const g of geometries) {
    if (g.type !== 'instance' || out.has(g.definition)) continue
    out.add(g.definition)
    definitionsIn(
      g.definition.objects.map((o) => o.geometry),
      out,
    )
  }
  return out
}

/** True if a definition holds the same objects, on the same layers, as `objects`. */
function sameContents(definition: BlockDefinition, objects: BlockDefinition['objects']): boolean {
  const key = (list: BlockDefinition['objects']) => JSON.stringify(list.map((o) => [o.layerId, geometryToJSON(o.geometry)]))
  return definition.objects.length === objects.length && key(definition.objects) === key(objects)
}

/**
 * Replaces the document with the content of an imported file (.3dm or .dxf), keeping its units.
 * Layer numbers in the file (also those of objects inside blocks) become layer ids from 1.
 */
export function applyRhinoImport(doc: Document, model: RhinoImport): void {
  // A file with nothing but what is made later (as an IFC file's walls) still needs a layer.
  const given = model.layers.length > 0 ? model.layers : [{ name: 'Default', color: '#000000', visible: true, locked: false }]
  const layers = given.map((layer, i) => ({ id: i + 1, ...layer }))
  const current = layers.find((l) => l.visible && !l.locked) ?? layers[0]
  const blocks = [...definitionsIn(model.objects.map((o) => o.geometry))].map((b) => ({
    name: b.name,
    objects: b.objects.map((o) => ({ layerId: o.layerId + 1, geometry: geometryToJSON(o.geometry) })),
  }))
  doc.load({
    units: model.units,
    layers,
    currentLayerId: current.id,
    blocks,
    objects: model.objects.map((o, i) => ({ id: i + 1, layerId: o.layer + 1, geometry: geometryToJSON(o.geometry) })),
  })
}

/**
 * Adds the content of an imported file to the document. Layers with the same name are reused;
 * geometry, blocks included, is scaled into the document's units. Blocks whose name is taken by a
 * different block get a number. Returns the new object ids and the units it was scaled from.
 */
export function mergeRhinoImport(doc: Document, model: RhinoImport): { ids: number[]; scaledFrom: string | null } {
  const { objects, scaledFrom } = adoptModel(doc, model)
  return { ids: objects.map((o) => doc.add(o.geometry, o.layerId).id), scaledFrom }
}

/**
 * A file's content made ready for the document, without adding it: its layers reused or made
 * (named by `layerName`), its geometry and blocks scaled into the document's units.
 */
export function adoptModel(doc: Document, model: RhinoImport, layerName = (name: string) => name): { objects: BlockDefinition['objects']; scaledFrom: string | null } {
  const layerIds = model.layers.map((layer) => {
    const name = layerName(layer.name)
    const existing = doc.layers.find((l) => l.name === name)
    if (existing) return existing.id
    const created = doc.addLayer()
    doc.updateLayer(created.id, { ...layer, name })
    return created.id
  })

  const from = METERS[model.units]
  const to = METERS[doc.units]
  const factor = from && to && model.units !== doc.units ? from / to : 1
  const scale = new Matrix4().makeScale(factor, factor, factor)
  const unscale = new Matrix4().makeScale(1 / factor, 1 / factor, 1 / factor)

  // Definitions are scaled too, so a block inserted later is in model units; an instance then keeps
  // its own rotation and scale and only its position is scaled.
  const adopted = new Map<BlockDefinition, BlockDefinition>()
  const adoptDefinition = (definition: BlockDefinition): BlockDefinition => {
    let done = adopted.get(definition)
    if (done) return done
    const objects = definition.objects.map((o) => ({ layerId: layerIds[o.layerId] ?? doc.currentLayerId, geometry: adopt(o.geometry) }))
    // The same block already here (pasted back into its own file, say): its copies use it.
    const existing = doc.blocks.get(definition.name)
    if (existing && sameContents(existing, objects)) {
      adopted.set(definition, existing)
      return existing
    }
    let name = definition.name
    for (let n = 2; doc.blocks.has(name); n++) name = `${definition.name} ${n}`
    done = { name, objects }
    adopted.set(definition, done)
    doc.setBlock(name, done)
    return done
  }
  const adopt = (g: Geometry): Geometry => {
    if (g.type !== 'instance') return factor === 1 ? g : transform(g, scale)
    const matrix = scale.clone().multiply(new Matrix4().fromArray(g.matrix)).multiply(unscale)
    return { type: 'instance', definition: adoptDefinition(g.definition), matrix: matrix.toArray() }
  }

  const objects = model.objects.map((o) => ({ layerId: layerIds[o.layer] ?? doc.currentLayerId, geometry: adopt(o.geometry) }))
  return { objects, scaledFrom: factor === 1 ? null : model.units }
}

/**
 * An .archi file's model as imported content: its visible objects and the blocks they use, with
 * layer ids turned into indices. (Drawings, layouts and history stay in that file.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function archiAsImport(json: any): RhinoImport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileLayers: any[] = Array.isArray(json?.layers) ? json.layers : []
  const index = new Map<number, number>(fileLayers.map((l, i) => [Number(l.id), i]))
  const layerOf = (id: unknown) => index.get(Number(id)) ?? 0
  const blocks = new Map<string, BlockDefinition>()
  for (const b of json?.blocks ?? []) blocks.set(b.name, { name: b.name, objects: [] })
  const lookup = (name: string) => blocks.get(name)
  for (const b of json?.blocks ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks.get(b.name)!.objects.push(...(b.objects ?? []).map((o: any) => ({ layerId: layerOf(o.layerId), geometry: geometryFromJSON(o.geometry, lookup) })))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hiddenLayers = new Set(fileLayers.filter((l) => l.visible === false).map((l: any) => Number(l.id)))
  const objects = (json?.objects ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((o: any) => !o.hidden && !hiddenLayers.has(Number(o.layerId)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({ layer: layerOf(o.layerId), geometry: geometryFromJSON(o.geometry, lookup) }))
  return {
    units: String(json?.units ?? 'Millimeters'),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    layers: fileLayers.length > 0 ? fileLayers.map(({ id, ...rest }) => rest) : [{ name: 'Default', color: '#000000', visible: true, locked: false }],
    objects,
    breps: [],
    tolerance: 0,
    skipped: new Map(),
  }
}
