import { version as appVersion } from '../../package.json'
import { ARCHI_FORMAT, ARCHI_MARK } from './archiFormat'
import { DEFAULT_LEVELS, type Level } from './architecture'
import { DEFAULT_RENDER_SETTINGS, layerMaterial, Material, materialFromJSON, RenderSettings, renderSettingsFromJSON } from './materials'
import { controlPoints } from './curves'
import { BlockDefinition, Geometry, geometryFromJSON, geometryToJSON } from './geometry'
import type { Layout } from './layout'

export interface Layer {
  id: number
  name: string
  color: string
  visible: boolean
  locked: boolean
  /** Name of a linetype (see LINETYPES); Continuous when missing. */
  linetype?: string
  /** Pen width for printing, in millimeters; the default width when missing or 0. */
  printWidth?: number
  /** Name of the render material of the layer's objects; their layer color when missing. */
  material?: string
}

export interface CadObject {
  id: number
  layerId: number
  geometry: Geometry
  /** Groups the object belongs to; picking one member picks them all. */
  groups?: number[]
  /** Hidden by Hide ('user') or by Isolate ('isolate'); shown when missing. */
  hidden?: 'user' | 'isolate'
  /** Locked objects are drawn but cannot be picked. */
  locked?: boolean
  /** Render material, by name, in place of the layer's. */
  material?: string
  /** How the object was made from others, so it can be made again when they change. */
  history?: HistoryRecord
}

/** The command and inputs an object was built from (see the history manager). */
export interface HistoryRecord {
  command: string
  /** Ids of the input objects, in the order the command takes them. */
  inputs: number[]
  /** Anything else the command needs: distances, directions, options. */
  params?: Record<string, unknown>
}

/** A saved camera: which kind of view it was, and where it looked from. */
export interface NamedView {
  name: string
  kind: string
  state: { target: [number, number, number]; viewHeight: number; distance: number; azimuth: number; elevation: number }
}

/** A saved construction plane. */
export interface NamedCPlane {
  name: string
  origin: [number, number, number]
  xaxis: [number, number, number]
  yaxis: [number, number, number]
}

export interface ObjectState {
  hidden?: 'user' | 'isolate'
  locked?: boolean
  material?: string
}

/**
 * Editing a block in place: the definition's objects are in the model (from `startId` on, with
 * anything drawn meanwhile), the instance being edited is hidden and everything else is shown dimmed.
 */
export interface BlockEdit {
  block: string
  instanceId: number
  /** The edited instance's transform, to take the objects back into the block's own coordinates. */
  matrix: number[]
  startId: number
}

export type ChangeKind = 'objects' | 'selection' | 'layers'

/** What a step changed, as onStep() listeners see it. */
export type StepChange = Action
export type SelectMode = 'replace' | 'add' | 'remove'

type Action =
  | { type: 'add'; obj: CadObject }
  | { type: 'remove'; obj: CadObject }
  | { type: 'modify'; id: number; before: Geometry; after: Geometry }
  | { type: 'relayer'; id: number; before: number; after: number }
  | { type: 'groups'; id: number; before: number[] | undefined; after: number[] | undefined }
  | { type: 'state'; id: number; before: ObjectState; after: ObjectState }
  | { type: 'block'; name: string; before: BlockDefinition | undefined; after: BlockDefinition | undefined }
  | { type: 'blockEdit'; before: BlockEdit | null; after: BlockEdit | null }
  | { type: 'layouts'; before: Layout[]; after: Layout[] }
  | { type: 'history'; id: number; before: HistoryRecord | undefined; after: HistoryRecord | undefined }

const LAYER_COLORS = ['#c0392b', '#1f6fb5', '#1e8449', '#b9770e', '#7d3c98', '#117a8b']

function defaultLayers(): Layer[] {
  return [{ id: 1, name: 'Default', color: '#000000', visible: true, locked: false }]
}

export class Document {
  readonly objects = new Map<number, CadObject>()
  readonly selection = new Set<number>()
  /** Objects whose control points are shown and editable. */
  readonly pointsOn = new Set<number>()
  /** Selected control points, by object id. */
  readonly pointSelection = new Map<number, Set<number>>()
  layers: Layer[] = defaultLayers()
  /** Block definitions by name. */
  readonly blocks = new Map<string, BlockDefinition>()
  /** Saved views and construction planes (kept with the model, outside undo, as in Rhino). */
  namedViews: NamedView[] = []
  namedCPlanes: NamedCPlane[] = []
  /** The building's levels, lowest first, and the one being drawn on (kept outside undo, like views). */
  levels: Level[] = DEFAULT_LEVELS.map((l) => ({ ...l }))
  currentLevel = DEFAULT_LEVELS[0].name

  setLevels(levels: Level[], current = this.currentLevel): void {
    this.levels = [...levels].sort((a, b) => a.elevation - b.elevation)
    this.currentLevel = this.levels.some((l) => l.name === current) ? current : (this.levels[0]?.name ?? '')
    this.modified = true
    this.emit('layers')
  }

  /** The level being drawn on. */
  get level(): Level {
    return this.levels.find((l) => l.name === this.currentLevel) ?? this.levels[0] ?? DEFAULT_LEVELS[0]
  }

  setNamedViews(views: NamedView[]): void {
    this.namedViews = views
    this.emit('layers')
  }

  setNamedCPlanes(planes: NamedCPlane[]): void {
    this.namedCPlanes = planes
    this.emit('layers')
  }

  /** Render materials, by name; layers and objects refer to them by name. */
  materials: Material[] = []
  renderSettings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS }

  setMaterials(materials: Material[]): void {
    this.materials = materials
    this.emit('layers')
  }

  setRenderSettings(patch: Partial<RenderSettings>): void {
    this.renderSettings = { ...this.renderSettings, ...patch }
    this.emit('layers')
  }

  /** The material an object renders with: its own, its layer's, or its layer color. */
  materialOf(obj: CadObject): Material {
    const layer = this.layerOf(obj)
    const name = obj.material ?? layer.material
    return (name && this.materials.find((m) => m.name === name)) || layerMaterial(layer.color)
  }

  /** Sheets for printing; replaced as a whole on every change. */
  layouts: Layout[] = []
  private groupDepth = 0
  /** Set while a block is being edited in place. */
  blockEdit: BlockEdit | null = null
  currentLayerId = 1
  /** Model units, named as in Rhino ("Millimeters", "Meters", ...). */
  units = 'Millimeters'
  /** True when there are changes since the document was created, opened or saved. */
  modified = false
  /** Goes up with every change to the model, for caches of things drawn from it. */
  revision = 0

  private nextObjectId = 1
  private nextLayerId = 2
  private nextGroupId = 1
  private undoStack: Action[][] = []
  private redoStack: Action[][] = []
  private tx: Action[] | null = null
  private listeners = new Set<(kind: ChangeKind) => void>()

  on(listener: (kind: ChangeKind) => void): void {
    this.listeners.add(listener)
  }

  private emit(kind: ChangeKind): void {
    if (kind !== 'selection') {
      this.modified = true
      this.revision++
    }
    for (const listener of this.listeners) listener(kind)
  }

  // --- Objects ---------------------------------------------------------------

  add(geometry: Geometry, layerId = this.currentLayerId): CadObject {
    const obj: CadObject = { id: this.nextObjectId++, layerId, geometry }
    this.record({ type: 'add', obj })
    return obj
  }

  remove(id: number): void {
    const obj = this.objects.get(id)
    if (obj) this.record({ type: 'remove', obj })
  }

  setGeometry(id: number, geometry: Geometry): void {
    const obj = this.objects.get(id)
    if (obj) this.record({ type: 'modify', id, before: obj.geometry, after: geometry })
  }

  setLayer(id: number, layerId: number): void {
    const obj = this.objects.get(id)
    if (obj && obj.layerId !== layerId) this.record({ type: 'relayer', id, before: obj.layerId, after: layerId })
  }

  /** The id the next added object will get. */
  get nextId(): number {
    return this.nextObjectId
  }

  /** Hides, shows, locks or unlocks an object, or sets its material (undoable). */
  setState(id: number, patch: ObjectState): void {
    const obj = this.objects.get(id)
    if (!obj) return
    const before: ObjectState = { hidden: obj.hidden, locked: obj.locked, material: obj.material }
    const after: ObjectState = { ...before, ...patch }
    if (before.hidden !== after.hidden || before.locked !== after.locked || before.material !== after.material) this.record({ type: 'state', id, before, after })
  }

  /** The objects added by the last change (a command's whole step, or a single edit). */
  lastCreated: number[] = []
  /** The selection before the last time it was replaced or cleared. */
  previousSelection: number[] = []

  /** Puts the objects in a new group. Returns its id. */
  group(ids: Iterable<number>): number {
    const group = this.nextGroupId++
    for (const id of ids) this.setGroups(id, [...(this.objects.get(id)?.groups ?? []), group])
    return group
  }

  setGroups(id: number, groups: number[] | undefined): void {
    const obj = this.objects.get(id)
    if (!obj) return
    const after = groups && groups.length > 0 ? [...new Set(groups)] : undefined
    if (String(obj.groups ?? '') !== String(after ?? '')) this.record({ type: 'groups', id, before: obj.groups, after })
  }

  /** The objects, with every other member of the groups they belong to. */
  withGroups(ids: Iterable<number>): number[] {
    const out = new Set(ids)
    const groups = new Set<number>()
    for (const id of out) for (const g of this.objects.get(id)?.groups ?? []) groups.add(g)
    if (groups.size === 0) return [...out]
    for (const obj of this.objects.values()) if (obj.groups?.some((g) => groups.has(g)) && this.isSelectable(obj)) out.add(obj.id)
    return [...out]
  }

  /** Adds, replaces (or with null removes) a block definition. */
  setBlock(name: string, definition: BlockDefinition | null): void {
    const before = this.blocks.get(name)
    if (before !== (definition ?? undefined)) this.record({ type: 'block', name, before, after: definition ?? undefined })
  }

  /** How many objects place each block, counting the ones nested in other blocks' definitions once. */
  blockUsage(): Map<string, number> {
    const usage = new Map<string, number>()
    for (const obj of this.objects.values()) {
      if (obj.geometry.type === 'instance') usage.set(obj.geometry.definition.name, (usage.get(obj.geometry.definition.name) ?? 0) + 1)
    }
    for (const def of this.blocks.values()) {
      for (const o of def.objects) if (o.geometry.type === 'instance') usage.set(o.geometry.definition.name, (usage.get(o.geometry.definition.name) ?? 0) + 1)
    }
    return usage
  }

  setLayouts(layouts: Layout[]): void {
    if (layouts !== this.layouts) this.record({ type: 'layouts', before: this.layouts, after: layouts })
  }

  /** Replaces one layout (matched by id). */
  updateLayout(layout: Layout): void {
    this.setLayouts(this.layouts.map((l) => (l.id === layout.id ? layout : l)))
  }

  setBlockEdit(state: BlockEdit | null): void {
    this.record({ type: 'blockEdit', before: this.blockEdit, after: state })
  }

  layerOf(obj: CadObject): Layer {
    return this.layers.find((l) => l.id === obj.layerId) ?? this.layers[0]
  }

  isVisible(obj: CadObject): boolean {
    return this.layerOf(obj).visible && !obj.hidden
  }

  isSelectable(obj: CadObject): boolean {
    const layer = this.layerOf(obj)
    return layer.visible && !layer.locked && !obj.hidden && !obj.locked && this.isEditable(obj)
  }

  /** While a block is edited, only its objects can be picked. */
  isEditable(obj: CadObject): boolean {
    return !this.blockEdit || obj.id >= this.blockEdit.startId
  }

  // --- History ---------------------------------------------------------------

  /** Sets or clears how an object was built (undoable). */
  setHistory(id: number, record: HistoryRecord | undefined): void {
    const obj = this.objects.get(id)
    if (!obj || (!obj.history && !record)) return
    this.record({ type: 'history', id, before: obj.history, after: record })
  }

  private stepListeners = new Set<(step: readonly Action[]) => void>()
  private amending: Action[] | null = null

  /**
   * Called after each finished step (a committed transaction or a single change, not undo or redo),
   * with its changes, so dependents can follow.
   */
  onStep(listener: (step: readonly StepChange[]) => void): void {
    this.stepListeners.add(listener as (step: readonly Action[]) => void)
  }

  /**
   * Like begin(), but commit() adds the changes to `step` (as given to onStep listeners), so undoing
   * that step undoes them too. If other steps came after it, the changes get their own undo step.
   */
  beginAmend(step: readonly StepChange[]): void {
    if (this.groupDepth > 0) return
    this.tx = []
    this.amending = this.undoStack[this.undoStack.length - 1] === step ? (step as Action[]) : null
  }

  /** Groups every change until commit() into a single undo step. */
  begin(): void {
    // Inside a group, the steps of commands are parts of the group's own step.
    if (this.groupDepth > 0) return
    this.tx = []
    this.amending = null
  }

  /**
   * Starts a step that takes in the steps of everything done until endGroup(), commands included
   * (their begin() and commit() add to it), as when a script runs several commands. Groups nest.
   */
  beginGroup(): void {
    if (this.groupDepth === 0) this.begin()
    this.groupDepth++
  }

  endGroup(): void {
    if (this.groupDepth === 0) return
    this.groupDepth--
    if (this.groupDepth === 0) this.commit()
  }

  commit(): void {
    if (this.groupDepth > 0) return
    const tx = this.tx
    const amending = this.amending
    this.tx = null
    this.amending = null
    if (!tx || tx.length === 0) return
    if (amending) {
      amending.push(...tx)
      return
    }
    this.undoStack.push(tx)
    this.redoStack = []
    this.noteCreated(tx)
    this.finishStep(tx)
  }

  /**
   * Takes back everything changed since begin(), as if it had not happened (for a command that
   * failed halfway). Inside a group (a script's step) it does nothing: the group goes on.
   */
  rollback(): boolean {
    if (this.groupDepth > 0) return false
    const tx = this.tx
    this.tx = null
    this.amending = null
    if (!tx || tx.length === 0) return false
    for (let i = tx.length - 1; i >= 0; i--) this.apply(tx[i], true)
    this.pruneSelection()
    this.emit('objects')
    return true
  }

  private finishStep(step: Action[]): void {
    for (const listener of this.stepListeners) listener(step)
  }

  private noteCreated(actions: Action[]): void {
    const added = actions.filter((a): a is Extract<Action, { type: 'add' }> => a.type === 'add').map((a) => a.obj.id)
    if (added.length > 0) this.lastCreated = added
  }

  undo(): boolean {
    const actions = this.undoStack.pop()
    if (!actions) return false
    for (let i = actions.length - 1; i >= 0; i--) this.apply(actions[i], true)
    this.redoStack.push(actions)
    this.pruneSelection()
    this.emit('objects')
    return true
  }

  redo(): boolean {
    const actions = this.redoStack.pop()
    if (!actions) return false
    for (const action of actions) this.apply(action, false)
    this.undoStack.push(actions)
    this.pruneSelection()
    this.emit('objects')
    return true
  }

  private record(action: Action): void {
    this.apply(action, false)
    if (this.tx) {
      this.tx.push(action)
    } else {
      this.undoStack.push([action])
      this.redoStack = []
      this.noteCreated([action])
    }
    // Only the object changed can have left the selection (a whole check on every change of a
    // large edit, as deleting thousands of objects, would take time growing with its square).
    this.pruneSelection('id' in action ? [action.id] : 'obj' in action ? [action.obj.id] : undefined)
    this.emit('objects')
    if (!this.tx) this.finishStep(this.undoStack[this.undoStack.length - 1])
  }

  private apply(action: Action, inverse: boolean): void {
    switch (action.type) {
      case 'add':
      case 'remove':
        if ((action.type === 'add') !== inverse) this.objects.set(action.obj.id, action.obj)
        else this.objects.delete(action.obj.id)
        break
      case 'modify': {
        const obj = this.objects.get(action.id)
        if (obj) obj.geometry = inverse ? action.before : action.after
        break
      }
      case 'relayer': {
        const obj = this.objects.get(action.id)
        if (obj) obj.layerId = inverse ? action.before : action.after
        break
      }
      case 'groups': {
        const obj = this.objects.get(action.id)
        if (obj) obj.groups = inverse ? action.before : action.after
        break
      }
      case 'state': {
        const obj = this.objects.get(action.id)
        if (!obj) break
        const state = inverse ? action.before : action.after
        if (state.hidden) obj.hidden = state.hidden
        else delete obj.hidden
        if (state.locked) obj.locked = true
        else delete obj.locked
        if (state.material) obj.material = state.material
        else delete obj.material
        break
      }
      case 'block': {
        const definition = inverse ? action.before : action.after
        if (definition) this.blocks.set(action.name, definition)
        else this.blocks.delete(action.name)
        break
      }
      case 'blockEdit':
        this.blockEdit = inverse ? action.before : action.after
        break
      case 'layouts':
        this.layouts = inverse ? action.before : action.after
        break
      case 'history': {
        const obj = this.objects.get(action.id)
        if (!obj) break
        const record = inverse ? action.before : action.after
        if (record) obj.history = record
        else delete obj.history
        break
      }
    }
  }

  // --- Selection -------------------------------------------------------------

  select(ids: Iterable<number>, mode: SelectMode = 'replace'): void {
    if (mode === 'replace') {
      if (this.selection.size > 0) this.previousSelection = [...this.selection]
      this.selection.clear()
    }
    for (const id of ids) {
      if (mode === 'remove') this.selection.delete(id)
      else this.selection.add(id)
    }
    this.emit('selection')
  }

  clearSelection(): void {
    if (this.selection.size === 0) return
    this.previousSelection = [...this.selection]
    this.selection.clear()
    this.emit('selection')
  }

  /** Takes out of the selection what can no longer be selected: all of it, or only the objects given. */
  private pruneSelection(ids?: Iterable<number>): void {
    const selected = ids ? [...ids].filter((id) => this.selection.has(id)) : this.selection
    for (const id of selected) {
      const obj = this.objects.get(id)
      if (!obj || !this.isSelectable(obj)) this.selection.delete(id)
    }
    const withPoints = ids ? [...(ids as number[])].filter((id) => this.pointsOn.has(id)) : this.pointsOn
    for (const id of withPoints) {
      const obj = this.objects.get(id)
      if (!obj || !this.isSelectable(obj) || !controlPoints(obj.geometry)) this.pointsOn.delete(id)
    }
    const pointIds = ids ? [...(ids as number[])].filter((id) => this.pointSelection.has(id)) : [...this.pointSelection.keys()]
    for (const id of pointIds) {
      const indices = this.pointSelection.get(id)!
      const count = this.pointsOn.has(id) ? controlPoints(this.objects.get(id)!.geometry)!.length : 0
      for (const i of indices) if (i >= count) indices.delete(i)
      if (indices.size === 0) this.pointSelection.delete(id)
    }
  }

  // --- Control points ----------------------------------------------------------------

  /** Shows or hides the control points of objects. Returns how many objects changed. */
  setPointsOn(ids: Iterable<number>, on: boolean): number {
    let changed = 0
    for (const id of ids) {
      const obj = this.objects.get(id)
      if (on && obj && this.isSelectable(obj) && controlPoints(obj.geometry) && !this.pointsOn.has(id)) {
        this.pointsOn.add(id)
        changed++
      } else if (!on && this.pointsOn.delete(id)) {
        this.pointSelection.delete(id)
        changed++
      }
    }
    if (changed) this.emit('selection')
    return changed
  }

  get selectedPointCount(): number {
    let n = 0
    for (const indices of this.pointSelection.values()) n += indices.size
    return n
  }

  selectPoints(points: Iterable<{ id: number; index: number }>, mode: SelectMode = 'replace'): void {
    if (mode === 'replace') this.pointSelection.clear()
    for (const { id, index } of points) {
      if (!this.pointsOn.has(id)) continue
      let indices = this.pointSelection.get(id)
      if (mode === 'remove') {
        indices?.delete(index)
        if (indices?.size === 0) this.pointSelection.delete(id)
        continue
      }
      if (!indices) this.pointSelection.set(id, (indices = new Set()))
      indices.add(index)
    }
    this.emit('selection')
  }

  clearPointSelection(): void {
    if (this.pointSelection.size === 0) return
    this.pointSelection.clear()
    this.emit('selection')
  }

  // --- Layers ----------------------------------------------------------------

  get currentLayer(): Layer {
    return this.layers.find((l) => l.id === this.currentLayerId) ?? this.layers[0]
  }

  addLayer(): Layer {
    let n = this.layers.length
    let name: string
    do {
      name = `Layer ${String(n++).padStart(2, '0')}`
    } while (this.layers.some((l) => l.name === name))
    const layer: Layer = {
      id: this.nextLayerId++,
      name,
      color: LAYER_COLORS[(this.nextLayerId - 3) % LAYER_COLORS.length],
      visible: true,
      locked: false,
    }
    this.layers.push(layer)
    this.emit('layers')
    return layer
  }

  updateLayer(id: number, patch: Partial<Omit<Layer, 'id'>>): void {
    const layer = this.layers.find((l) => l.id === id)
    if (!layer) return
    Object.assign(layer, patch)
    this.pruneSelection()
    this.emit('layers')
  }

  setCurrentLayer(id: number): void {
    if (id === this.currentLayerId || !this.layers.some((l) => l.id === id)) return
    this.currentLayerId = id
    this.emit('layers')
  }

  /** Removes a layer. Fails if it is the last one or still holds objects. */
  removeLayer(id: number): boolean {
    if (this.layers.length <= 1) return false
    for (const obj of this.objects.values()) if (obj.layerId === id) return false
    this.layers = this.layers.filter((l) => l.id !== id)
    if (this.currentLayerId === id) this.currentLayerId = this.layers[0].id
    this.emit('layers')
    return true
  }

  // --- Persistence -----------------------------------------------------------

  setUnits(units: string): void {
    this.units = units
    this.emit('layers')
  }

  toJSON(): unknown {
    return {
      format: ARCHI_MARK,
      version: ARCHI_FORMAT,
      app: appVersion,
      units: this.units,
      layers: this.layers,
      currentLayerId: this.currentLayerId,
      blocks: [...this.blocks.values()].map((b) => ({
        name: b.name,
        ...(b.link ? { link: b.link } : {}),
        objects: b.objects.map((o) => ({ layerId: o.layerId, geometry: geometryToJSON(o.geometry) })),
      })),
      objects: [...this.objects.values()].map((o) => ({
        id: o.id,
        layerId: o.layerId,
        ...(o.groups ? { groups: o.groups } : {}),
        ...(o.hidden ? { hidden: o.hidden } : {}),
        ...(o.locked ? { locked: true } : {}),
        ...(o.material ? { material: o.material } : {}),
        ...(o.history ? { history: o.history } : {}),
        geometry: geometryToJSON(o.geometry),
      })),
      ...(this.layouts.length > 0 ? { layouts: this.layouts } : {}),
      ...(this.namedViews.length > 0 ? { namedViews: this.namedViews } : {}),
      ...(this.namedCPlanes.length > 0 ? { namedCPlanes: this.namedCPlanes } : {}),
      levels: this.levels,
      currentLevel: this.currentLevel,
      ...(this.materials.length > 0 ? { materials: this.materials } : {}),
      renderSettings: this.renderSettings,
      ...(this.blockEdit ? { blockEdit: this.blockEdit } : {}),
    }
  }

  /**
   * Replaces the document with one read from JSON (an .archi file, brought up to date by
   * archiFormat). Objects of a kind this version does not know (from a newer one) are left out
   * rather than failing the whole file; returns how many.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load(json: any): number {
    let skipped = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readAll = <T>(list: any, read: (o: any) => T): T[] =>
      (Array.isArray(list) ? list : []).flatMap((o) => {
        try {
          return [read(o)]
        } catch {
          skipped++
          return []
        }
      })
    const layers: Layer[] = json.layers?.length ? json.layers : defaultLayers()
    // Definitions first, empty, so that blocks nested in blocks find each other in any order.
    const blocks = new Map<string, BlockDefinition>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blockList = (Array.isArray(json.blocks) ? json.blocks : []).filter((b: any) => typeof b?.name === 'string')
    for (const b of blockList) blocks.set(b.name, { name: b.name, objects: [], ...(typeof b.link?.source === 'string' ? { link: { source: b.link.source, fileName: String(b.link.fileName ?? b.link.source) } } : {}) })
    const lookup = (name: string) => blocks.get(name)
    for (const b of blockList) {
      blocks.get(b.name)!.objects.push(...readAll(b.objects, (o) => ({ layerId: o.layerId, geometry: geometryFromJSON(o.geometry, lookup) })))
    }
    const objects: CadObject[] = readAll(json.objects, (o) => ({
      id: o.id,
      layerId: o.layerId,
      ...(o.groups?.length ? { groups: o.groups } : {}),
      ...(o.hidden === 'user' || o.hidden === 'isolate' ? { hidden: o.hidden } : {}),
      ...(o.locked ? { locked: true } : {}),
      ...(typeof o.material === 'string' && o.material ? { material: o.material } : {}),
      ...(o.history && typeof o.history.command === 'string' && Array.isArray(o.history.inputs) ? { history: o.history } : {}),
      geometry: geometryFromJSON(o.geometry, lookup),
    }))

    this.layers = layers
    this.units = typeof json.units === 'string' ? json.units : 'Millimeters'
    this.currentLayerId = layers.some((l) => l.id === json.currentLayerId) ? json.currentLayerId : layers[0].id
    this.objects.clear()
    for (const obj of objects) this.objects.set(obj.id, obj)
    this.blocks.clear()
    for (const [name, definition] of blocks) this.blocks.set(name, definition)
    this.blockEdit = json.blockEdit ?? null
    this.layouts = Array.isArray(json.layouts) ? json.layouts : []
    this.namedViews = Array.isArray(json.namedViews) ? json.namedViews : []
    this.namedCPlanes = Array.isArray(json.namedCPlanes) ? json.namedCPlanes : []
    const levels: Level[] = Array.isArray(json.levels)
      ? json.levels.filter((l: any) => typeof l?.name === 'string' && Number.isFinite(l.elevation) && Number.isFinite(l.height))
      : []
    this.levels = levels.length > 0 ? levels.sort((a, b) => a.elevation - b.elevation) : DEFAULT_LEVELS.map((l) => ({ ...l }))
    this.currentLevel = this.levels.some((l) => l.name === json.currentLevel) ? json.currentLevel : this.levels[0].name
    this.materials = Array.isArray(json.materials) ? json.materials.map(materialFromJSON).filter((m: Material | null): m is Material => m !== null) : []
    this.renderSettings = renderSettingsFromJSON(json.renderSettings)
    this.lastCreated = []
    this.previousSelection = []
    this.selection.clear()
    this.pointsOn.clear()
    this.pointSelection.clear()
    // (A loop rather than Math.max(...ids), which overflows the stack for very large drawings.)
    this.nextObjectId = objects.reduce((max, o) => Math.max(max, o.id), 0) + 1
    this.nextLayerId = layers.reduce((max, l) => Math.max(max, l.id), 0) + 1
    this.nextGroupId = objects.reduce((max, o) => Math.max(max, ...(o.groups ?? [])), 0) + 1
    this.undoStack = []
    this.redoStack = []
    this.tx = null
    this.groupDepth = 0
    this.emit('layers')
    this.emit('objects')
    this.modified = false
    return skipped
  }

  /** Empties the document, as for a new file. */
  clear(): void {
    this.load({})
  }
}
