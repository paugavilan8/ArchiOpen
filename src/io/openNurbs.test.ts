import { describe, expect, it } from 'vitest'
import { crc32, ISO, isoFlag, type OnCurve } from './openNurbs'

const line = (a: number[], b: number[]): OnCurve => ({ kind: 'nurbs', dim: 2, degree: 1, knots: [0, 1], points: [a, b] })

describe('openNURBS writing', () => {
  it('checks chunks with zlib CRC-32', () => {
    expect(crc32(0, new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    // Continuing a CRC over a second piece gives the CRC of the whole.
    expect(crc32(crc32(0, new TextEncoder().encode('1234')), new TextEncoder().encode('56789'))).toBe(0xcbf43926)
  })

  it('flags trims along the sides and parameter lines of their surface', () => {
    const domain: [[number, number], [number, number]] = [
      [0, 4],
      [-1, 1],
    ]
    expect(isoFlag(line([0, -1], [0, 1]), domain)).toBe(ISO.W)
    expect(isoFlag(line([4, 1], [4, -1]), domain)).toBe(ISO.E)
    expect(isoFlag(line([4, -1], [0, -1]), domain)).toBe(ISO.S)
    expect(isoFlag(line([0, 1], [4, 1]), domain)).toBe(ISO.N)
    expect(isoFlag(line([2, -1], [2, 1]), domain)).toBe(ISO.x)
    expect(isoFlag(line([0, 0.5], [4, 0.5]), domain)).toBe(ISO.y)
    expect(isoFlag(line([0, -1], [4, 1]), domain)).toBe(ISO.none)
  })
})
