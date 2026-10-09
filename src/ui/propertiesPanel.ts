import { Matrix4, Vector3 } from 'three'
import type { CommandRunner } from '../commands/runner'
import type { CadObject, Document } from '../core/document'
import { length } from '../core/curves'
import { measure } from '../core/annotation'
import { PATTERN_NAMES } from '../core/hatch'
import { AnnotationGeometry, endPoint, HatchGeometry, Geometry, isClosed, startPoint, tessellate, typeName } from '../core/geometry'

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
    case 'brep':
      return [
        ['Faces', String(g.faces)],
        ['Kind', g.kind === 'solid' ? 'Closed solid' : g.kind === 'surface' ? 'Surface' : 'Open polysurface'],
      ]
    case 'polycurve':
      return [
        ['Length', fmt(length(g))],
        ['Segments', String(g.segments.length)],
        ['Closed', isClosed(g) ? 'Yes' : 'No'],
      ]
    case 'hatch':
      return [['Loops', String(g.loops.length)]]
    case 'instance': {
      const m = new Matrix4().fromArray(g.matrix)
      const scale = new Vector3().setFromMatrixScale(m)
      const x = new Vector3().setFromMatrixColumn(m, 0)
      return [
        ['Block', g.definition.name],
        ['Insertion point', point(new Vector3().setFromMatrixPosition(m))],
        ['Scale', [scale.x, scale.y, scale.z].every((s) => Math.abs(s - scale.x) < 1e-9) ? fmt(scale.x) : `${fmt(scale.x)}, ${fmt(scale.y)}, ${fmt(scale.z)}`],
        ['Rotation', `${fmt((Math.atan2(x.y, x.x) * 180) / Math.PI)}°`],
        ['Objects', String(g.definition.objects.length)],
      ]
    }
    case 'annotation':
      if (g.kind === 'text' || g.kind === 'leader') return [['Insertion point', point(g.points[g.kind === 'text' ? 0 : g.points.length - 1])]]
      return [['Value', g.kind === 'angle' ? `${fmt(measure(g))}°` : fmt(measure(g))]]
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
      const groups = new Set(selected.flatMap((o) => o.groups ?? []))
      const object = this.section('Object', [
        ['Type', selected.length === 1 ? capitalize(typeName(selected[0].geometry)) : type],
        ...(groups.size > 0 ? ([['Grouped', groups.size === 1 ? 'Yes' : `In ${groups.size} groups`]] as Row[]) : []),
      ])
      object.querySelector('dl')!.append(...this.layerField(selected))
      sections.push(object)
      if (selected.length === 1) {
        const g = selected[0].geometry
        sections.push(this.section('Geometry', geometryRows(g)))
        if (g.type === 'annotation') sections.push(this.annotationSection(selected[0].id, g))
        if (g.type === 'hatch') sections.push(this.hatchSection(selected[0].id, g))
      }
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

  /** Editable pattern, scale and rotation of a hatch. */
  private hatchSection(id: number, g: HatchGeometry): HTMLElement {
    const section = this.section('Hatch', [])
    const list = section.querySelector('dl')!
    const update = (patch: Partial<HatchGeometry>) => {
      if (this.runner.busy) return
      this.doc.begin()
      this.doc.setGeometry(id, { ...g, ...patch })
      this.doc.commit()
    }
    const field = (label: string, input: HTMLElement) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.appendChild(input)
      list.append(dt, dd)
    }
    const pattern = document.createElement('select')
    for (const name of PATTERN_NAMES) pattern.add(new Option(name, name, false, g.pattern === name))
    pattern.addEventListener('change', () => update({ pattern: pattern.value }))
    field('Pattern', pattern)
    const number = (value: number, apply: (v: number) => void) => {
      const input = document.createElement('input')
      input.type = 'number'
      input.step = 'any'
      input.value = String(Number(value.toFixed(6)))
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (Number.isFinite(v)) apply(v)
      })
      return input
    }
    field('Scale', number(g.scale, (v) => v > 0 && update({ scale: v })))
    field('Rotation', number((g.rotation * 180) / Math.PI, (v) => update({ rotation: (v * Math.PI) / 180 })))
    return section
  }

  /** Editable text, height, arrows and precision of a text, dimension or leader. */
  private annotationSection(id: number, g: AnnotationGeometry): HTMLElement {
    const section = this.section(g.kind === 'text' || g.kind === 'leader' ? 'Text' : 'Dimension', [])
    const list = section.querySelector('dl')!
    const update = (patch: Partial<AnnotationGeometry>) => {
      if (this.runner.busy) return
      this.doc.begin()
      this.doc.setGeometry(id, { ...g, ...patch })
      this.doc.commit()
    }
    const field = (label: string, input: HTMLElement) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.appendChild(input)
      list.append(dt, dd)
    }
    const isDim = g.kind !== 'text' && g.kind !== 'leader'
    const text = document.createElement('textarea')
    text.rows = isDim ? 1 : 3
    text.value = g.text
    text.placeholder = isDim ? '<> (measured value)' : ''
    text.title = isDim ? '<> stands for the measured value' : ''
    text.addEventListener('change', () => update({ text: text.value }))
    field(isDim ? 'Text' : 'Content', text)
    const height = document.createElement('input')
    height.type = 'number'
    height.min = '0'
    height.step = 'any'
    height.value = String(Number(g.height.toFixed(6)))
    height.addEventListener('change', () => {
      const value = Number(height.value)
      if (value > 0) update({ height: value })
    })
    field('Height', height)
    if (g.kind === 'text') return section
    const arrow = document.createElement('select')
    arrow.add(new Option('Arrow', 'arrow', false, g.arrow === 'arrow'))
    arrow.add(new Option('Tick', 'tick', false, g.arrow === 'tick'))
    arrow.addEventListener('change', () => update({ arrow: arrow.value === 'tick' ? 'tick' : 'arrow' }))
    field('Arrowheads', arrow)
    if (!isDim) return section
    const precision = document.createElement('select')
    for (let i = 0; i <= 4; i++) precision.add(new Option(i === 0 ? '1' : (0).toFixed(i).replace(/0$/, '1'), String(i), false, g.precision === i))
    precision.addEventListener('change', () => update({ precision: Number(precision.value) }))
    field('Precision', precision)
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
