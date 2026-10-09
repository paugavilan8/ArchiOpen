import { Box3, Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { displayText, measure } from './annotation'
import { transform } from './curves'
import { AnnotationGeometry, geometryFromJSON, geometryToJSON, wireframe } from './geometry'
import { textShape } from '../text/strokeFont'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const X = v(1, 0)
const Y = v(0, 1)

const annotation = (kind: AnnotationGeometry['kind'], points: Vector3[], text = ''): AnnotationGeometry => ({
  type: 'annotation',
  kind,
  points,
  xaxis: X.clone(),
  yaxis: Y.clone(),
  text,
  height: 1,
  arrow: 'arrow',
  precision: 2,
})

const bounds = (g: AnnotationGeometry) => new Box3().setFromPoints(wireframe(g).flat())

describe('single-stroke text', () => {
  it('measures text in cap heights', () => {
    const { strokes, widths } = textShape('HI')
    expect(strokes.length).toBeGreaterThan(3)
    const ys = strokes.flat().map(([, y]) => y)
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(widths).toHaveLength(1)
  })

  it('draws accents, symbols and several lines', () => {
    expect(textShape('ñ').strokes.length).toBe(textShape('n').strokes.length + 1)
    expect(textShape('í').strokes.length).toBe(textShape('i').strokes.length)
    expect(textShape('Ø25 ±1 45°').strokes.length).toBeGreaterThan(5)
    expect(textShape('Planta\nbaja').widths).toHaveLength(2)
  })
})

describe('dimensions', () => {
  it('measures linear dimensions along the plane axis and aligned ones along the points', () => {
    const points = [v(0, 0), v(3, 4), v(0, -2)]
    expect(measure(annotation('linear', points))).toBeCloseTo(3, 9)
    expect(measure(annotation('aligned', points))).toBeCloseTo(5, 9)
    expect(displayText(annotation('aligned', points))).toBe('5.00')
    expect(displayText(annotation('linear', points, 'L = <> m'))).toBe('L = 3.00 m')
  })

  it('draws the dimension line at the picked offset with the text above it', () => {
    const g = annotation('linear', [v(0, 0), v(10, 0), v(5, 3)])
    const b = bounds(g)
    expect(b.min.x).toBeCloseTo(0, 6)
    expect(b.max.x).toBeCloseTo(10, 6)
    // Extension lines start a gap away from the measured points; text sits 0.4 above the line.
    expect(b.min.y).toBeCloseTo(0.5, 6)
    expect(b.max.y).toBeCloseTo(3 + 0.4 + 1, 6)
  })

  it('measures radius, diameter and angle', () => {
    expect(displayText(annotation('radius', [v(0, 0), v(3, 0), v(5, 5)]))).toBe('R3.00')
    expect(displayText(annotation('diameter', [v(0, 0), v(0, 3), v(5, 5)]))).toBe('Ø6.00')
    const right = annotation('angle', [v(0, 0), v(5, 0), v(0, 5), v(2, 2)])
    expect(measure(right)).toBeCloseTo(90, 9)
    // An arc point outside the rays measures the other side.
    expect(measure({ ...right, points: [v(0, 0), v(5, 0), v(0, 5), v(-2, -2)] })).toBeCloseTo(270, 9)
  })

  it('updates the value when moved, scaled or mirrored, and keeps text readable', () => {
    const g = annotation('aligned', [v(0, 0), v(4, 0), v(2, 1)])
    const scaled = transform(g, new Matrix4().makeScale(2, 2, 2))
    expect(measure(scaled)).toBeCloseTo(8, 9)
    expect(scaled.height).toBeCloseTo(2, 9)
    const mirrored = transform(g, new Matrix4().makeScale(-1, 1, 1))
    expect(measure(mirrored)).toBeCloseTo(4, 9)
    expect(mirrored.xaxis.x).toBeCloseTo(1, 9)
    expect(mirrored.yaxis.y).toBeCloseTo(1, 9)
  })

  it('round-trips through JSON', () => {
    const g = annotation('leader', [v(0, 0), v(3, 2), v(5, 2)], 'Muro de\nhormigón')
    const back = geometryFromJSON(JSON.parse(JSON.stringify(geometryToJSON(g)))) as AnnotationGeometry
    expect(back).toEqual(g)
    expect(wireframe(back).length).toBe(wireframe(g).length)
  })
})
