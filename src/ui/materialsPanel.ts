import type { CommandRunner } from '../commands/runner'
import type { Document } from '../core/document'
import type { FileManager } from '../app/files'
import { Material, MATERIAL_PRESETS, MaterialTexture, TEXTURE_DEFAULTS, TEXTURE_KINDS, TextureKind } from '../core/materials'
import { patternPreview } from '../view/textures'
import { iconButton } from './icons'

/** A small picture of a material: its color, with a highlight as sharp as its finish. */
function swatch(m: Material): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'material-swatch'
  if (m.texture) {
    el.style.background = `center / cover url("${texturePreview(m.texture)}")`
    return el
  }
  const spot = Math.round(10 + m.roughness * 40)
  const shine = m.metalness > 0.5 ? 'rgb(255 255 255 / 0.9)' : `rgb(255 255 255 / ${0.85 - m.roughness * 0.6})`
  el.style.background = `radial-gradient(circle at 35% 30%, ${shine}, transparent ${spot}%), ${m.color}`
  if (m.transparency > 0) el.style.opacity = String(1 - m.transparency * 0.6)
  return el
}

const previews = new Map<string, string>()

/** A small picture of a texture (patterns are drawn once). */
function texturePreview(t: MaterialTexture): string {
  if (t.kind === 'Image') return t.image!
  let url = previews.get(t.kind)
  if (!url) previews.set(t.kind, (url = patternPreview(t.kind)))
  return url
}

/** A picture from a file, made at most 1024 pixels across and stored as JPEG, so models stay small. */
async function pictureDataUrl(bytes: Uint8Array): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** The document's render materials: add from presets, edit, assign to objects and layers. */
export class MaterialsPanel {
  private readonly list = document.createElement('ul')
  private readonly editor = document.createElement('div')
  private editing: string | null = null
  private frame = 0

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly runner: CommandRunner,
    private readonly log: (text: string) => void,
    private readonly files: FileManager,
  ) {
    const header = document.createElement('div')
    header.className = 'panel-toolbar'
    const add = document.createElement('select')
    add.className = 'material-add'
    add.add(new Option('Add a material…', '', true, true))
    for (const p of MATERIAL_PRESETS) add.add(new Option(p.name, p.name))
    add.addEventListener('change', () => {
      const preset = MATERIAL_PRESETS.find((p) => p.name === add.value)
      add.value = ''
      if (preset) this.addMaterial(preset)
    })
    header.append(add, iconButton('print', 'Render the active view  (Render)', () => void runner.run('Render')))
    this.list.className = 'layer-list material-list'
    this.editor.className = 'properties layer-properties'
    container.append(header, this.list, this.editor)
    doc.on((kind) => {
      if (kind !== 'selection' && !this.frame) this.frame = requestAnimationFrame(() => this.render())
    })
    this.render()
  }

  /** Adds a copy of a material under a free name, and edits it. */
  private addMaterial(source: Material): void {
    let name = source.name
    for (let n = 2; this.doc.materials.some((m) => m.name === name); n++) name = `${source.name} ${n}`
    this.doc.setMaterials([...this.doc.materials, { ...source, name }])
    this.editing = name
    this.render()
  }

  private render(): void {
    this.frame = 0
    const { doc } = this
    if (this.editing && !doc.materials.some((m) => m.name === this.editing)) this.editing = null
    if (doc.materials.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'panel-empty'
      empty.textContent = 'No materials yet. Add one above, then give it to objects or layers; switch a view to Rendered to see it.'
      this.list.replaceChildren(empty)
    } else this.list.replaceChildren(...doc.materials.map((m) => this.row(m)))
    // Not while one of its fields is in use: rebuilding it would cut a slider's drag short.
    if (!this.editor.contains(document.activeElement)) this.renderEditor()
  }

  private usage(name: string): number {
    let n = 0
    for (const o of this.doc.objects.values()) if ((o.material ?? this.doc.layerOf(o).material) === name) n++
    return n
  }

  private row(m: Material): HTMLLIElement {
    const { doc } = this
    const row = document.createElement('li')
    row.classList.toggle('current', m.name === this.editing)
    row.addEventListener('click', () => {
      this.editing = m.name
      this.render()
    })
    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = m.name
    const count = document.createElement('span')
    count.className = 'layer-count'
    const used = this.usage(m.name)
    count.textContent = String(used)
    count.dataset.tip = `${used} object${used === 1 ? '' : 's'}`
    row.append(
      swatch(m),
      name,
      count,
      iconButton('plus', 'Give it to the selected objects', () => {
        if (this.runner.busy) return
        if (doc.selection.size === 0) return this.log('Select objects first')
        doc.begin()
        for (const id of doc.selection) doc.setState(id, { material: m.name })
        doc.commit()
      }),
      iconButton('minus', 'Delete the material', () => {
        if (used > 0 || doc.layers.some((l) => l.material === m.name) || [...doc.objects.values()].some((o) => o.material === m.name)) {
          return this.log(`"${m.name}" is in use: give its objects and layers another material first`)
        }
        doc.setMaterials(doc.materials.filter((x) => x !== m))
      }),
    )
    return row
  }

  private renderEditor(): void {
    const { doc } = this
    const m = doc.materials.find((x) => x.name === this.editing)
    if (!m) {
      this.editor.replaceChildren()
      return
    }
    const section = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = `Material ${m.name}`
    const list = document.createElement('dl')
    const field = (label: string, input: HTMLElement) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.appendChild(input)
      list.append(dt, dd)
    }
    const update = (patch: Partial<Material>) => doc.setMaterials(doc.materials.map((x) => (x.name === m.name ? { ...x, ...patch } : x)))
    const name = document.createElement('input')
    name.value = m.name
    name.addEventListener('keydown', (e) => e.stopPropagation())
    name.addEventListener('change', () => {
      name.blur()
      this.rename(m.name, name.value.trim())
    })
    field('Name', name)
    const color = document.createElement('input')
    color.type = 'color'
    color.value = m.color
    color.addEventListener('input', () => update({ color: color.value }))
    field('Color', color)
    const slider = (label: string, key: 'roughness' | 'metalness' | 'transparency', tip: string) => {
      const input = document.createElement('input')
      input.type = 'range'
      input.min = '0'
      input.max = '1'
      input.step = '0.01'
      input.value = String(m[key])
      input.dataset.tip = tip
      input.addEventListener('input', () => update({ [key]: Number(input.value) }))
      field(label, input)
    }
    slider('Roughness', 'roughness', 'Polished (left) to matte (right)')
    slider('Metal', 'metalness', 'Paint, stone or plastic (left) to bare metal (right)')
    slider('Transparency', 'transparency', 'Opaque (left) to clear glass (right)')
    this.textureFields(m, field, update)
    const layer = document.createElement('select')
    layer.add(new Option('Give it to a layer…', '', true, true))
    for (const l of doc.layers) layer.add(new Option(`${l.name}${l.material === m.name ? ' ✓' : ''}`, String(l.id)))
    layer.addEventListener('change', () => {
      if (layer.value) doc.updateLayer(Number(layer.value), { material: m.name })
    })
    field('Layer', layer)
    section.append(heading, list)
    this.editor.replaceChildren(section)
  }

  /** Pattern or picture, its real size, turn and relief. */
  private textureFields(m: Material, field: (label: string, input: HTMLElement) => void, update: (patch: Partial<Material>) => void): void {
    const kind = document.createElement('select')
    kind.add(new Option('None', '', false, !m.texture))
    for (const k of TEXTURE_KINDS) kind.add(new Option(k === 'Image' ? 'Picture from a file…' : k, k, false, m.texture?.kind === k))
    const choosePicture = async () => {
      const file = await this.files.pickImage()
      if (!file) return this.render()
      try {
        const image = await pictureDataUrl(file.bytes)
        update({ color: '#ffffff', texture: { kind: 'Image', image, rotation: 0, ...TEXTURE_DEFAULTS.Image, ...(m.texture?.kind === 'Image' ? { size: m.texture.size, rotation: m.texture.rotation } : {}) } })
      } catch {
        this.log(`Could not read ${file.name} as a picture`)
        this.render()
      }
    }
    kind.addEventListener('change', () => {
      // Out of the field, so the editor shows the texture's own fields.
      kind.blur()
      const k = kind.value as TextureKind | ''
      if (!k) update({ texture: undefined })
      else if (k === 'Image') void choosePicture()
      // A pattern shows as it is under white; the old color would tint it.
      else update({ color: '#ffffff', texture: { kind: k, rotation: 0, ...TEXTURE_DEFAULTS[k] } })
    })
    field('Texture', kind)
    const t = m.texture
    if (!t) return
    const number = (value: number, step: string, onChange: (n: number) => void) => {
      const input = document.createElement('input')
      input.type = 'number'
      input.step = step
      input.value = String(value)
      input.addEventListener('keydown', (e) => e.stopPropagation())
      input.addEventListener('change', () => {
        const n = Number(input.value)
        if (Number.isFinite(n)) onChange(n)
      })
      return input
    }
    field('Size (m)', number(t.size, '0.05', (n) => n > 0 && update({ texture: { ...t, size: n } })))
    field('Rotation (°)', number(t.rotation, '15', (n) => update({ texture: { ...t, rotation: n } })))
    const bump = document.createElement('input')
    bump.type = 'range'
    bump.min = '0'
    bump.max = '1'
    bump.step = '0.05'
    bump.value = String(t.bump)
    bump.dataset.tip = 'Flat (left) to deep relief (right)'
    bump.addEventListener('input', () => update({ texture: { ...t, bump: Number(bump.value) } }))
    field('Relief', bump)
    if (t.kind === 'Image') {
      const change = document.createElement('button')
      change.type = 'button'
      change.className = 'material-picture'
      change.textContent = 'Change picture…'
      change.addEventListener('click', () => void choosePicture())
      field('', change)
    }
  }

  /** Renames a material and everything that refers to it. */
  private rename(from: string, to: string): void {
    const { doc } = this
    if (!to || to === from) return this.render()
    if (doc.materials.some((m) => m.name === to)) {
      this.log(`There is already a material named "${to}"`)
      return this.render()
    }
    doc.setMaterials(doc.materials.map((m) => (m.name === from ? { ...m, name: to } : m)))
    for (const l of doc.layers) if (l.material === from) doc.updateLayer(l.id, { material: to })
    const users = [...doc.objects.values()].filter((o) => o.material === from)
    if (users.length > 0 && !this.runner.busy) {
      doc.begin()
      for (const o of users) doc.setState(o.id, { material: to })
      doc.commit()
    }
    this.editing = to
  }
}
