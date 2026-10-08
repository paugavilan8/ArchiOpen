import { Geometry, geometryFromJSON, geometryToJSON } from './geometry'

export interface Layer {
  id: number
  name: string
  color: string
  visible: boolean
  locked: boolean
}

export interface CadObject {
  id: number
  layerId: number
  geometry: Geometry
}

export type ChangeKind = 'objects' | 'selection' | 'layers'
export type SelectMode = 'replace' | 'add' | 'remove'

type Action =
  | { type: 'add'; obj: CadObject }
  | { type: 'remove'; obj: CadObject }
  | { type: 'modify'; id: number; before: Geometry; after: Geometry }
  | { type: 'relayer'; id: number; before: number; after: number }

const LAYER_COLORS = ['#c0392b', '#1f6fb5', '#1e8449', '#b9770e', '#7d3c98', '#117a8b']

function defaultLayers(): Layer[] {
  return [{ id: 1, name: 'Default', color: '#000000', visible: true, locked: false }]
}

export class Document {
  readonly objects = new Map<number, CadObject>()
  readonly selection = new Set<number>()
  layers: Layer[] = defaultLayers()
  currentLayerId = 1
  /** True when there are changes since the document was created, opened or saved. */
  modified = false

  private nextObjectId = 1
  private nextLayerId = 2
  private undoStack: Action[][] = []
  private redoStack: Action[][] = []
  private tx: Action[] | null = null
  private listeners = new Set<(kind: ChangeKind) => void>()

  on(listener: (kind: ChangeKind) => void): void {
    this.listeners.add(listener)
  }

  private emit(kind: ChangeKind): void {
    if (kind !== 'selection') this.modified = true
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

  layerOf(obj: CadObject): Layer {
    return this.layers.find((l) => l.id === obj.layerId) ?? this.layers[0]
  }

  isVisible(obj: CadObject): boolean {
    return this.layerOf(obj).visible
  }

  isSelectable(obj: CadObject): boolean {
    const layer = this.layerOf(obj)
    return layer.visible && !layer.locked
  }

  // --- History ---------------------------------------------------------------

  /** Groups every change until commit() into a single undo step. */
  begin(): void {
    this.tx = []
  }

  commit(): void {
    if (this.tx && this.tx.length > 0) {
      this.undoStack.push(this.tx)
      this.redoStack = []
    }
    this.tx = null
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
    }
    this.pruneSelection()
    this.emit('objects')
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
    }
  }

  // --- Selection -------------------------------------------------------------

  select(ids: Iterable<number>, mode: SelectMode = 'replace'): void {
    if (mode === 'replace') this.selection.clear()
    for (const id of ids) {
      if (mode === 'remove') this.selection.delete(id)
      else this.selection.add(id)
    }
    this.emit('selection')
  }

  clearSelection(): void {
    if (this.selection.size === 0) return
    this.selection.clear()
    this.emit('selection')
  }

  private pruneSelection(): void {
    for (const id of this.selection) {
      const obj = this.objects.get(id)
      if (!obj || !this.isSelectable(obj)) this.selection.delete(id)
    }
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

  toJSON(): unknown {
    return {
      version: 1,
      layers: this.layers,
      currentLayerId: this.currentLayerId,
      objects: [...this.objects.values()].map((o) => ({
        id: o.id,
        layerId: o.layerId,
        geometry: geometryToJSON(o.geometry),
      })),
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load(json: any): void {
    const layers: Layer[] = json.layers?.length ? json.layers : defaultLayers()
    const objects: CadObject[] = (json.objects ?? []).map((o: any) => ({
      id: o.id,
      layerId: o.layerId,
      geometry: geometryFromJSON(o.geometry),
    }))

    this.layers = layers
    this.currentLayerId = layers.some((l) => l.id === json.currentLayerId) ? json.currentLayerId : layers[0].id
    this.objects.clear()
    for (const obj of objects) this.objects.set(obj.id, obj)
    this.selection.clear()
    this.nextObjectId = Math.max(0, ...objects.map((o) => o.id)) + 1
    this.nextLayerId = Math.max(0, ...layers.map((l) => l.id)) + 1
    this.undoStack = []
    this.redoStack = []
    this.tx = null
    this.emit('layers')
    this.emit('objects')
    this.modified = false
  }

  /** Empties the document, as for a new file. */
  clear(): void {
    this.load({})
  }
}
