import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { FRAME, wallParams, type Opening } from './architecture'
import { endPoint, startPoint, type AnyCurve } from './geometry'
import { openingSymbol } from './planSymbols'

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)
const path: AnyCurve = { type: 'polyline', points: [v(0, 0), v(6000, 0)], closed: false }
const params = wallParams({ thickness: 200, height: 3000 })
const door: Opening = { id: 1, kind: 'door', at: 3000, width: 900, height: 2100, sill: 0 }
const leaf = 900 - 2 * FRAME.profile

describe('plan symbols', () => {
  it('draws a door open square to the wall, and the quarter arc back to its jamb', () => {
    const swing = openingSymbol(path, params, door, 'swing')
    expect(swing.type).toBe('polycurve')
    // Hinged at the start end, on the left face (y = 100), opening to the left (+y).
    const hinge = startPoint(swing)
    expect(hinge.x).toBeCloseTo(3000 - 450 + FRAME.profile, 9)
    expect(hinge.y).toBeCloseTo(100, 9)
    const shut = endPoint(swing)
    expect(shut.x).toBeCloseTo(hinge.x + leaf, 9)
    expect(shut.y).toBeCloseTo(100, 9)
    if (swing.type !== 'polycurve') return
    const [line, arc] = swing.segments
    expect(endPoint(line).y).toBeCloseTo(100 + leaf, 9)
    expect(arc.type === 'arc' && arc.radius).toBeCloseTo(leaf, 9)
  })

  it('opens the other way and hangs on the other side when asked', () => {
    const swing = openingSymbol(path, params, { ...door, swing: 'right', hinge: 'end' }, 'swing')
    const hinge = startPoint(swing)
    expect(hinge.x).toBeCloseTo(3000 + 450 - FRAME.profile, 9)
    expect(hinge.y).toBeCloseTo(-100, 9)
    expect(endPoint(swing).x).toBeCloseTo(hinge.x - leaf, 9)
  })

  it('draws a window as its frame across the wall and its glass along it', () => {
    const window: Opening = { id: 2, kind: 'window', at: 1500, width: 1200, height: 1200, sill: 900 }
    const frame = openingSymbol(path, params, window, 'planFrame')
    expect(frame.type === 'polyline' && frame.closed).toBe(true)
    if (frame.type !== 'polyline') return
    const ys = frame.points.map((p) => p.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(FRAME.depth, 9)
    const glass = openingSymbol(path, params, window, 'planGlass')
    expect(startPoint(glass).y).toBeCloseTo(0, 9)
    expect(endPoint(glass).x - startPoint(glass).x).toBeCloseTo(1200 - 2 * FRAME.profile, 9)
  })
})
