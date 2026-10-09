import { Box3, Vector3 } from 'three'
import type { CommandRunner } from '../commands/runner'
import { placeInstance, redefineBlock } from '../core/blocks'
import type { Document } from '../core/document'
import { BlockDefinition, wireframe } from '../core/geometry'
import { iconButton } from './icons'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A small top view of a block's line work. */
function thumbnail(definition: BlockDefinition): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'block-thumb')
  svg.setAttribute('viewBox', '0 0 32 32')
  const lines = wireframe(placeInstance(definition, new Vector3()))
  const box = new Box3().setFromPoints(lines.flat())
  if (box.isEmpty()) return svg
  const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 1e-9)
  const k = 28 / size
  const ox = 16 - ((box.min.x + box.max.x) / 2) * k
  const oy = 16 + ((box.min.y + box.max.y) / 2) * k
  // A few hundred segments are enough for a thumbnail.
  const step = Math.max(1, Math.ceil(lines.length / 300))
  for (let i = 0; i < lines.length; i += step) {
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', lines[i].map((p) => `${(ox + p.x * k).toFixed(1)},${(oy - p.y * k).toFixed(1)}`).join(' '))
    svg.appendChild(line)
  }
  return svg
}

/** The document's block definitions: insert, select, edit, rename and delete them. */
export class BlocksPanel {
  private readonly list = document.createElement('ul')
  private frame = 0

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly runner: CommandRunner,
    private readonly log: (text: string) => void,
  ) {
    const header = document.createElement('div')
    header.className = 'panel-toolbar'
    const hint = document.createElement('span')
    hint.className = 'panel-hint'
    hint.textContent = 'Double-click a name to rename'
    header.append(
      hint,
      iconButton('plus', 'Make a block from the selection  (Block)', () => void runner.run('Block')),
      iconButton('delete', 'Remove unused blocks  (Purge)', () => void runner.run('Purge')),
    )
    this.list.className = 'layer-list block-list'
    container.append(header, this.list)
    doc.on((kind) => {
      if (kind !== 'selection' && !this.frame) this.frame = requestAnimationFrame(() => this.render())
    })
    this.render()
  }

  private render(): void {
    this.frame = 0
    const usage = this.doc.blockUsage()
    const names = [...this.doc.blocks.keys()].sort((a, b) => a.localeCompare(b))
    if (names.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'panel-empty'
      empty.textContent = 'No blocks yet. Select objects and run Block, or open a DXF with blocks.'
      this.list.replaceChildren(empty)
      return
    }
    this.list.replaceChildren(...names.map((name) => this.row(this.doc.blocks.get(name)!, usage.get(name) ?? 0)))
  }

  private row(definition: BlockDefinition, count: number): HTMLLIElement {
    const { doc, runner } = this
    const row = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = definition.name
    name.addEventListener('dblclick', () => this.rename(definition, name))
    const objects = document.createElement('span')
    objects.className = 'layer-count'
    objects.textContent = String(count)
    objects.dataset.tip = `${count} instance${count === 1 ? '' : 's'}`
    const quoted = `"${definition.name.replace(/"/g, '')}"`
    const instances = () => [...doc.objects.values()].filter((o) => o.geometry.type === 'instance' && o.geometry.definition.name === definition.name)
    row.append(
      thumbnail(definition),
      name,
      objects,
      iconButton('plus', 'Insert', () => void runner.run(`Insert ${quoted}`)),
      iconButton('selectAll', 'Select its instances', () => doc.select(instances().filter((o) => doc.isSelectable(o)).map((o) => o.id))),
      iconButton('minus', 'Delete the block (only if it is not used)', () => {
        if (count > 0) return this.log(`Block "${definition.name}" is used ${count} time${count === 1 ? '' : 's'}: delete or explode its instances first`)
        doc.begin()
        doc.setBlock(definition.name, null)
        doc.commit()
      }),
    )
    return row
  }

  private rename(definition: BlockDefinition, label: HTMLElement): void {
    if (this.runner.busy) return
    if (this.doc.blockEdit?.block === definition.name) return this.log('Finish editing the block before renaming it')
    const input = document.createElement('input')
    input.className = 'layer-rename'
    input.value = definition.name
    label.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name && name !== definition.name) {
        if (this.doc.blocks.has(name)) this.log(`There is already a block named "${name}"`)
        else {
          this.doc.begin()
          redefineBlock(this.doc, { name, objects: definition.objects }, definition.name)
          this.doc.commit()
        }
      }
      this.render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }
}
