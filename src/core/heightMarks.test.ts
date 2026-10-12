import { describe, expect, it } from 'vitest'
import { distinctHeights, formatHeight, heightMarks, marksReach } from './heightMarks'

describe('height marks', () => {
  it('writes heights in meters from zero', () => {
    expect(formatHeight(0, 1e-3)).toBe('±0.00')
    expect(formatHeight(3000, 1e-3)).toBe('+3.00')
    expect(formatHeight(-450, 1e-3)).toBe('-0.45')
    expect(formatHeight(2.755, 1)).toBe('+2.76')
    expect(distinctHeights([3000, 0, 3000.01, 900], 1)).toEqual([0, 900, 3000])
  })

  it('marks each level and the top on the left, clear of the drawing, and chains heights on the right', () => {
    const heights = {
      levels: [
        { name: 'Level 0', z: 0 },
        { name: 'Level 1', z: 3000 },
      ],
      openings: [
        { sill: 900, head: 2100 },
        { sill: 900, head: 2100 },
      ],
    }
    const out = heightMarks(heights, 0, 8000, 6000, 100, 1e-3)
    const texts = out.flatMap((g) => (g.type === 'annotation' && g.kind === 'text' ? [g] : []))
    expect(texts.map((t) => t.text)).toEqual(['Level 0  ±0.00', 'Level 1  +3.00', '+6.00'])
    // All of the marks lie left of the drawing.
    for (const g of out) if (g.type !== 'annotation' || g.kind === 'text') for (const p of g.type === 'polyline' ? g.points : g.type === 'annotation' ? g.points : []) expect(p.x).toBeLessThan(0)
    const dims = out.flatMap((g) => (g.type === 'annotation' && g.kind === 'aligned' ? [g] : []))
    // Inner: 0-900-2100-3000-6000; outer: 0-3000-6000, further out.
    const spans = (x: number) => dims.filter((d) => d.points[0].x === x).map((d) => [d.points[0].y, d.points[1].y])
    const xs = [...new Set(dims.map((d) => d.points[0].x))].sort((a, b) => a - b)
    expect(xs.length).toBe(2)
    expect(xs[0]).toBeGreaterThan(8000)
    expect(spans(xs[0])).toEqual([
      [0, 900],
      [900, 2100],
      [2100, 3000],
      [3000, 6000],
    ])
    expect(spans(xs[1])).toEqual([
      [0, 3000],
      [3000, 6000],
    ])
    // Without openings, one chain only; the top at a level is not marked twice.
    const plain = heightMarks({ levels: heights.levels, openings: [] }, 0, 8000, 3000, 100, 1e-3)
    expect(plain.filter((g) => g.type === 'annotation' && g.kind === 'aligned')).toHaveLength(1)
    expect(plain.filter((g) => g.type === 'annotation' && g.kind === 'text')).toHaveLength(2)
    // The room the marks take, for spacing drawings apart.
    const reach = marksReach(heights, 100)
    const leftmost = Math.min(...out.flatMap((g) => (g.type === 'polyline' ? g.points.map((p) => p.x) : [])))
    expect(reach.left).toBeGreaterThanOrEqual(-leftmost)
    expect(reach.right).toBeGreaterThanOrEqual(Math.max(...xs) - 8000)
  })
})
