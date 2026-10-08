import type { Vector3 } from 'three'
import type { CommandRunner } from '../commands/runner'
import type { CadObject, Document } from '../core/document'
import { length } from '../core/curves'
import { endPoint, Geometry, isClosed, startPoint, tessellate, typeName } from '../core/geometry'

type Row = [label: string, value: string]

const fmt = (n: number) => n.toFixed(3)
const point = (p: Vector3) => `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`

function polylineLength(pts: Vector3[]): number {
  let length = 0
  for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1])
  return length
}

function geometryRows(g: Geometry): Row[] {
  switch (g.type) {
    case 'polyline': {
      const length = polylineLength(tessellate(g))
      if (g.points.length === 2) return [['Length', fmt(length)], ['Start', point(g.points[0])], ['End', point(g.points[1])]]
      return [['Length', fmt(length)], ['Points', String(g.points.length)], ['Closed', g.closed ? 'Yes' : 'No']]
    }
    case 'circle':
      return [
        ['Center', point(g.center)],
        ['Radius', fmt(g.radius)],
        ['Diameter', fmt(g.radius * 2)],
        ['Circumference', fmt(2 * Math.PI * g.radius)],
      ]
    case 'curve':
      return [
        ['Length', `≈ ${fmt(polylineLength(tessellate(g)))}`],
        ['Degree', String(Math.min(g.degree, g.points.length - 1))],
        ['Control points', String(g.points.length)],
        ['Start', point(g.points[0])],
        ['End', point(g.points[g.points.length - 1])],
      ]
    case 'arc':
      return [
        ['Center', point(g.center)],
        ['Radius', fmt(g.radius)],
        ['Angle', `${fmt((g.angle * 180) / Math.PI)}°`],
        ['Length', fmt(g.radius * g.angle)],
        ['Start', point(startPoint(g))],
        ['End', point(endPoint(g))],
      ]
    case 'polycurve':
      return [
        ['Length', fmt(length(g))],
        ['Segments', String(g.segments.length)],
        ['Closed', isClosed(g) ? 'Yes' : 'No'],
      ]
  }
}

function plural(word: string, n: number): string {
  return n === 1 ? word : `${word}s`
}

/** Shows what is selected and lets its layer be changed. */
export class PropertiesPanel {
  private readonly body = document.createElement('div')
  private frame = 0

  constructor(
    container: HTMLElement,
    private readonly doc: Document,
    private readonly runner: CommandRunner,
  ) {
    this.body.className = 'properties'
    container.appendChild(this.body)
    // Many changes can arrive in one burst (e.g. a window selection), so render once per frame.
    doc.on(() => {
      if (!this.frame) this.frame = requestAnimationFrame(() => this.render())
    })
    this.render()
  }

  private render(): void {
    this.frame = 0
    const selected = [...this.doc.selection].map((id) => this.doc.objects.get(id)).filter((o): o is CadObject => !!o)
    const sections: HTMLElement[] = []

    if (selected.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'panel-empty'
      empty.textContent = 'Nothing selected. Click an object, or drag a window to select several.'
      sections.push(empty, this.section('Document', [
        ['Objects', String(this.doc.objects.size)],
        ['Layers', String(this.doc.layers.length)],
        ['Units', this.doc.units],
      ]))
    } else {
      const counts = new Map<string, number>()
      for (const obj of selected) {
        const type = typeName(obj.geometry)
        counts.set(type, (counts.get(type) ?? 0) + 1)
      }
      const type = [...counts].map(([name, n]) => `${n} ${plural(name, n)}`).join(', ')
      const object = this.section('Object', [['Type', selected.length === 1 ? capitalize(typeName(selected[0].geometry)) : type]])
      object.querySelector('dl')!.append(...this.layerField(selected))
      sections.push(object)
      if (selected.length === 1) sections.push(this.section('Geometry', geometryRows(selected[0].geometry)))
    }
    this.body.replaceChildren(...sections)
  }

  private section(title: string, rows: Row[]): HTMLElement {
    const section = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = title
    const list = document.createElement('dl')
    for (const [label, value] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      list.append(dt, dd)
    }
    section.append(heading, list)
    return section
  }

  private layerField(selected: CadObject[]): HTMLElement[] {
    const dt = document.createElement('dt')
    dt.textContent = 'Layer'
    const dd = document.createElement('dd')
    const select = document.createElement('select')
    const layerIds = new Set(selected.map((o) => this.doc.layerOf(o).id))
    if (layerIds.size > 1) select.add(new Option('(varies)', '', true, true))
    for (const layer of this.doc.layers) {
      const only = layerIds.size === 1 && layerIds.has(layer.id)
      select.add(new Option(layer.name, String(layer.id), only, only))
    }
    select.addEventListener('change', () => {
      const layerId = Number(select.value)
      if (!layerId || this.runner.busy) return
      // One undo step for the whole selection.
      this.doc.begin()
      for (const obj of selected) this.doc.setLayer(obj.id, layerId)
      this.doc.commit()
    })
    dd.appendChild(select)
    return [dt, dd]
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
