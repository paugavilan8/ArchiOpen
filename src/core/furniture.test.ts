import { describe, expect, it } from 'vitest'
import { FURNITURE, furnitureItem, furnitureSize } from './furniture'

describe('furniture library', () => {
  it('has items of usual sizes, standing on the floor with their backs at y = 0', () => {
    expect(furnitureSize(furnitureItem('DoubleBed')!)).toEqual([1500, 2050, 900])
    expect(furnitureSize(furnitureItem('sofa')!).slice(0, 2)).toEqual([2000, 900])
    expect(furnitureSize(furnitureItem('Dining table')!)).toEqual([1600, 900, 760])
    for (const item of FURNITURE) {
      const zs = item.parts.map((p) => ('box' in p ? p.box[2] : p.cylinder[2]))
      const ys = item.parts.map((p) => ('box' in p ? p.box[1] : p.cylinder[1] - p.cylinder[3]))
      expect(Math.min(...zs)).toBe(0)
      expect(Math.min(...ys)).toBe(0)
      // Centred across.
      const [w] = furnitureSize(item)
      const xs = item.parts.flatMap((p) => ('box' in p ? [p.box[0], p.box[0] + p.box[3]] : [p.cylinder[0] - p.cylinder[3], p.cylinder[0] + p.cylinder[3]]))
      expect(Math.min(...xs)).toBeCloseTo(-w / 2, 9)
    }
  })

  it('finds items by key or label, in any case', () => {
    expect(furnitureItem('kitchencounter')?.label).toBe('Kitchen counter')
    expect(furnitureItem('Single bed')?.key).toBe('SingleBed')
    expect(furnitureItem('piano')).toBeUndefined()
  })
})
