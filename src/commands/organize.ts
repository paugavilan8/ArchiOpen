import type { CadObject } from '../core/document'
import { geometryToJSON } from '../core/geometry'
import { plural } from './helpers'
import type { Command, CommandContext } from './runner'

/** Hiding, showing, isolating and locking objects, and selecting them by kind, layer and history. */

const visibleObjects = (ctx: CommandContext) => [...ctx.doc.objects.values()].filter((o) => !o.hidden)

const hide: Command = {
  name: 'Hide',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to hide')
    for (const id of ids) doc.setState(id, { hidden: 'user' })
    log(`${plural('object', ids.length)} hidden. Show brings them back`)
  },
}

/** Shows hidden objects (only those hidden by Isolate, with `isolated`) and selects them. */
function showHidden(ctx: CommandContext, isolated: boolean): number {
  const { doc } = ctx
  const ids = [...doc.objects.values()].filter((o) => (isolated ? o.hidden === 'isolate' : o.hidden)).map((o) => o.id)
  for (const id of ids) doc.setState(id, { hidden: undefined })
  doc.select(ids.filter((id) => doc.isSelectable(doc.objects.get(id)!)))
  return ids.length
}

const show: Command = {
  name: 'Show',
  async run(ctx) {
    const n = showHidden(ctx, false)
    ctx.log(n === 0 ? 'Nothing is hidden' : `${plural('object', n)} shown`)
  },
}

const hideSwap: Command = {
  name: 'HideSwap',
  async run(ctx) {
    const { doc, log } = ctx
    const objects = [...doc.objects.values()]
    const hidden = objects.filter((o) => o.hidden).map((o) => o.id)
    const shown = objects.filter((o) => !o.hidden).map((o) => o.id)
    for (const id of shown) doc.setState(id, { hidden: 'user' })
    for (const id of hidden) doc.setState(id, { hidden: undefined })
    log(`${plural('object', hidden.length)} shown, ${plural('object', shown.length)} hidden`)
  },
}

const isolate: Command = {
  name: 'Isolate',
  async run(ctx) {
    const { doc, input, log } = ctx
    const keep = new Set(await input.getObjects('Select objects to isolate'))
    const others = visibleObjects(ctx).filter((o) => !keep.has(o.id))
    for (const o of others) doc.setState(o.id, { hidden: 'isolate' })
    log(`${plural('object', others.length)} hidden. Unisolate brings them back`)
  },
}

const unisolate: Command = {
  name: 'Unisolate',
  async run(ctx) {
    const n = showHidden(ctx, true)
    ctx.log(n === 0 ? 'Nothing is isolated' : `${plural('object', n)} shown`)
  },
}

const lock: Command = {
  name: 'Lock',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects to lock')
    for (const id of ids) doc.setState(id, { locked: true })
    log(`${plural('object', ids.length)} locked. Unlock frees them`)
  },
}

const unlock: Command = {
  name: 'Unlock',
  async run(ctx) {
    const { doc, log } = ctx
    const ids = [...doc.objects.values()].filter((o) => o.locked).map((o) => o.id)
    for (const id of ids) doc.setState(id, { locked: false })
    doc.select(ids.filter((id) => doc.isSelectable(doc.objects.get(id)!)))
    log(ids.length === 0 ? 'Nothing is locked' : `${plural('object', ids.length)} unlocked`)
  },
}

/** A selection command: selects every pickable object that passes the test (adding to the selection). */
function selector(name: string, what: string, test: (o: CadObject) => boolean): Command {
  return {
    name,
    history: false,
    async run(ctx) {
      const { doc, log } = ctx
      const ids = [...doc.objects.values()].filter((o) => doc.isSelectable(o) && test(o)).map((o) => o.id)
      doc.select(ids, 'add')
      log(ids.length === 0 ? `No ${what} to select` : `${plural(what.replace(/(?<=(s|sh|ch|x))es$|s$/, ''), ids.length)} added to the selection`)
    },
  }
}

const isCurveType = (o: CadObject) => ['polyline', 'circle', 'arc', 'curve', 'polycurve'].includes(o.geometry.type)
const brepKind = (o: CadObject) => (o.geometry.type === 'brep' ? o.geometry.kind : null)

/** A key that is the same for objects with the same geometry, to 6 decimal places. */
function geometryKey(o: CadObject): string {
  return JSON.stringify(geometryToJSON(o.geometry), (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))
}

const selLayer: Command = {
  name: 'SelLayer',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    const names = doc.layers.map((l) => l.name)
    const typed = await input.getString(`Layer to select (${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}) <${doc.currentLayer.name}>`)
    const lower = (typed ?? doc.currentLayer.name).trim().toLowerCase()
    const layer = doc.layers.find((l) => l.name.toLowerCase() === lower) ?? doc.layers.find((l) => l.name.toLowerCase().startsWith(lower))
    if (!layer) throw new Error(`There is no layer named "${typed}"`)
    const ids = [...doc.objects.values()].filter((o) => o.layerId === layer.id && doc.isSelectable(o)).map((o) => o.id)
    doc.select(ids, 'add')
    log(`${plural('object', ids.length)} on layer ${layer.name} selected`)
  },
}

const selDup: Command = {
  name: 'SelDup',
  history: false,
  async run(ctx) {
    const { doc, log } = ctx
    // The first of each set of identical objects stays unselected, so deleting the rest leaves one.
    const seen = new Set<string>()
    const dups: number[] = []
    for (const o of doc.objects.values()) {
      if (!doc.isSelectable(o)) continue
      const key = geometryKey(o)
      if (seen.has(key)) dups.push(o.id)
      else seen.add(key)
    }
    doc.select(dups)
    log(dups.length === 0 ? 'No duplicates' : `${plural('duplicate', dups.length)} selected`)
  },
}

const selLast: Command = {
  name: 'SelLast',
  history: false,
  async run(ctx) {
    const { doc, log } = ctx
    const ids = doc.lastCreated.filter((id) => doc.objects.has(id) && doc.isSelectable(doc.objects.get(id)!))
    doc.select(ids)
    log(ids.length === 0 ? 'The last objects made are gone' : `${plural('object', ids.length)} selected`)
  },
}

const selPrev: Command = {
  name: 'SelPrev',
  history: false,
  async run(ctx) {
    const { doc } = ctx
    doc.select(doc.previousSelection.filter((id) => doc.objects.has(id) && doc.isSelectable(doc.objects.get(id)!)))
  },
}

const invert: Command = {
  name: 'Invert',
  history: false,
  async run(ctx) {
    const { doc } = ctx
    doc.select([...doc.objects.values()].filter((o) => doc.isSelectable(o) && !doc.selection.has(o.id)).map((o) => o.id))
  },
}

export const organizeCommands: Command[] = [
  hide,
  show,
  hideSwap,
  isolate,
  unisolate,
  lock,
  unlock,
  selLayer,
  selDup,
  selLast,
  selPrev,
  invert,
  selector('SelCrv', 'curves', isCurveType),
  selector('SelSrf', 'surfaces', (o) => brepKind(o) === 'surface'),
  selector('SelPolysrf', 'polysurfaces', (o) => brepKind(o) === 'polysurface' || brepKind(o) === 'solid'),
  selector('SelClosedPolysrf', 'closed solids', (o) => brepKind(o) === 'solid'),
  selector('SelOpenPolysrf', 'open polysurfaces', (o) => brepKind(o) === 'polysurface'),
  selector('SelBlockInstance', 'blocks', (o) => o.geometry.type === 'instance'),
  selector('SelAnnotation', 'annotations', (o) => o.geometry.type === 'annotation'),
  selector('SelDim', 'dimensions', (o) => o.geometry.type === 'annotation' && o.geometry.kind !== 'text' && o.geometry.kind !== 'leader'),
  selector('SelText', 'texts', (o) => o.geometry.type === 'annotation' && o.geometry.kind === 'text'),
  selector('SelHatch', 'hatches', (o) => o.geometry.type === 'hatch'),
  selector('SelMesh', 'meshes', (o) => o.geometry.type === 'mesh'),
]
