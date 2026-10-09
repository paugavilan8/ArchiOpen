import { Matrix4, Vector3 } from 'three'
import { transform } from './curves'
import type { Document } from './document'
import type { BlockDefinition, BlockObject, Geometry, InstanceGeometry } from './geometry'

/**
 * Blocks: a definition is a named, immutable set of objects around a base point at the origin; an
 * instance places a definition with a transform. Instances hold the definition itself, so redefining
 * a block means giving its instances the new definition, which keeps undo simple.
 */

export const instanceMatrix = (g: InstanceGeometry) => new Matrix4().fromArray(g.matrix)

/** The insertion point of an instance: where the definition's base point lands. */
export const insertionPoint = (g: InstanceGeometry) => new Vector3().setFromMatrixPosition(instanceMatrix(g))

const contentsCache = new WeakMap<InstanceGeometry, BlockObject[]>()

/** The objects of an instance's definition, placed where the instance is. Nested instances stay instances. */
export function instanceContents(g: InstanceGeometry): BlockObject[] {
  let contents = contentsCache.get(g)
  if (!contents) {
    const m = instanceMatrix(g)
    contents = g.definition.objects.map((o) => ({ layerId: o.layerId, geometry: transform(o.geometry, m) }))
    contentsCache.set(g, contents)
  }
  return contents
}

/** The geometry itself, or for an instance everything it draws, with nested instances expanded. */
export function flatten(g: Geometry): Geometry[] {
  if (g.type !== 'instance') return [g]
  return instanceContents(g).flatMap((o) => flatten(o.geometry))
}

/** True if the definition uses `name`, directly or through nested blocks. */
export function usesBlock(definition: BlockDefinition, name: string): boolean {
  return definition.objects.some(
    (o) => o.geometry.type === 'instance' && (o.geometry.definition.name === name || usesBlock(o.geometry.definition, name)),
  )
}

/** A definition from objects placed in the model, with `base` becoming its origin. */
export function defineBlock(name: string, objects: BlockObject[], base: Vector3): BlockDefinition {
  const toOrigin = new Matrix4().makeTranslation(-base.x, -base.y, -base.z)
  return { name, objects: objects.map((o) => ({ layerId: o.layerId, geometry: transform(o.geometry, toOrigin) })) }
}

/**
 * An instance of a definition at a point, scaled uniformly and turned by `rotation` radians. The
 * block's X and Y follow the plane's axes (the world's by default).
 */
export function placeInstance(
  definition: BlockDefinition,
  at: Vector3,
  scale = 1,
  rotation = 0,
  plane: { xaxis: Vector3; yaxis: Vector3 } = { xaxis: new Vector3(1, 0, 0), yaxis: new Vector3(0, 1, 0) },
): InstanceGeometry {
  const normal = plane.xaxis.clone().cross(plane.yaxis)
  const m = new Matrix4()
    .makeTranslation(at.x, at.y, at.z)
    .multiply(new Matrix4().makeBasis(plane.xaxis, plane.yaxis, normal))
    .multiply(new Matrix4().makeRotationZ(rotation))
    .multiply(new Matrix4().makeScale(scale, scale, scale))
  return { type: 'instance', definition, matrix: m.toArray() }
}

/** The same objects, with every instance of the replaced definitions pointing at the new ones. */
function rewire(objects: BlockObject[], replaced: Map<BlockDefinition, BlockDefinition>): BlockObject[] | null {
  let changed = false
  const out = objects.map((o) => {
    if (o.geometry.type !== 'instance') return o
    const next = replaced.get(o.geometry.definition)
    if (!next) return o
    changed = true
    return { ...o, geometry: { ...o.geometry, definition: next } }
  })
  return changed ? out : null
}

/**
 * Replaces a block definition everywhere: in the document's blocks, in every instance in the model,
 * and in the definitions of other blocks that nest it (which become new definitions in turn). With
 * `oldName`, the block is renamed as well.
 */
export function redefineBlock(doc: Document, definition: BlockDefinition, oldName = definition.name): void {
  const replaced = new Map<BlockDefinition, BlockDefinition>()
  const old = doc.blocks.get(oldName)
  if (oldName !== definition.name) doc.setBlock(oldName, null)
  doc.setBlock(definition.name, definition)
  if (old) replaced.set(old, definition)
  // Blocks that nest a replaced one are replaced too, until nothing changes.
  for (let changed = true; changed; ) {
    changed = false
    for (const def of [...doc.blocks.values()]) {
      const objects = rewire(def.objects, replaced)
      if (!objects) continue
      const next = { name: def.name, objects }
      replaced.set(def, next)
      doc.setBlock(def.name, next)
      changed = true
    }
  }
  for (const obj of [...doc.objects.values()]) {
    const g = obj.geometry
    if (g.type === 'instance' && replaced.has(g.definition)) doc.setGeometry(obj.id, { ...g, definition: replaced.get(g.definition)! })
  }
}
