import { Matrix4 } from 'three'
import { transform } from '../core/curves'
import type { Document } from '../core/document'
import { geometryToJSON } from '../core/geometry'
import type { RhinoImport } from '../io/rhino3dm'
import { METERS } from '../core/units'

/** Replaces the document with the content of a .3dm file, keeping its units. */
export function applyRhinoImport(doc: Document, model: RhinoImport): void {
  const layers = model.layers.map((layer, i) => ({ id: i + 1, ...layer }))
  const current = layers.find((l) => l.visible && !l.locked) ?? layers[0]
  doc.load({
    units: model.units,
    layers,
    currentLayerId: current.id,
    objects: model.objects.map((o, i) => ({ id: i + 1, layerId: o.layer + 1, geometry: geometryToJSON(o.geometry) })),
  })
}

/**
 * Adds the content of a .3dm file to the document. Layers with the same name are reused; geometry is
 * scaled into the document's units. Returns the new object ids and the units it was scaled from.
 */
export function mergeRhinoImport(doc: Document, model: RhinoImport): { ids: number[]; scaledFrom: string | null } {
  const layerIds = model.layers.map((layer) => {
    const existing = doc.layers.find((l) => l.name === layer.name)
    if (existing) return existing.id
    const created = doc.addLayer()
    doc.updateLayer(created.id, layer)
    return created.id
  })

  const from = METERS[model.units]
  const to = METERS[doc.units]
  const factor = from && to && model.units !== doc.units ? from / to : 1
  const scale = new Matrix4().makeScale(factor, factor, factor)
  const ids = model.objects.map((o) => doc.add(factor === 1 ? o.geometry : transform(o.geometry, scale), layerIds[o.layer]).id)
  return { ids, scaledFrom: factor === 1 ? null : model.units }
}
