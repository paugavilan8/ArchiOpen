import { describe, expect, it } from 'vitest'
import type { Level } from '../core/architecture'
import type { MeshGeometry } from '../core/geometry'
import { levelsWithBuilding } from './drawingSet'

/** A box as a mesh (its corners are enough to place it). */
const block = (z0: number, z1: number): MeshGeometry => ({
  type: 'mesh',
  vertices: [0, 0, z0, 1000, 0, z0, 1000, 1000, z0, 0, 1000, z1],
  faces: [0, 1, 2, 3],
})

const levels: Level[] = [
  { name: 'Level 0', elevation: 0, height: 3000 },
  { name: 'Level 1', elevation: 3000, height: 3000 },
  { name: 'Level 2', elevation: 6000, height: 3000 },
]

describe('DrawingSet plans', () => {
  it('makes a plan for each level with something of the building in it', () => {
    // Walls on the first two levels; the slab of level 2 only reaches its floor.
    const building = [block(0, 3000), block(3000, 6000), block(5800, 6000)]
    expect(levelsWithBuilding(levels, levels[0], building).map((l) => l.name)).toEqual(['Level 0', 'Level 1'])
    // Something on the top level too.
    expect(levelsWithBuilding(levels, levels[0], [...building, block(6000, 8000)]).map((l) => l.name)).toEqual(['Level 0', 'Level 1', 'Level 2'])
  })

  it('falls back to the current level', () => {
    expect(levelsWithBuilding(levels, levels[1], [])).toEqual([levels[1]])
  })
})
