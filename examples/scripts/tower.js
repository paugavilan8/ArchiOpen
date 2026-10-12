// A small tower: a number of levels, each with a ring of walls and a slab on top.
// Run it with File > Run Script.
const storeys = 5
const height = 3200
const [width, depth] = [12000, 9000]
const outline = [`0,0`, `${width},0`, `${width},${depth}`, `0,${depth}`]

for (let n = 0; n < storeys; n++) {
  const name = `Level ${n}`
  // A level that is already there (Level 0 in a new model) is set to the tower's floor height.
  const exists = archi.levels().some((l) => l.name === name)
  await archi.command('Level', exists ? 'Edit' : 'New', name, n * height, height, '')
  // Points are typed from the current level's floor.
  archi.setLevel(name)
  // Walls round the floor, and the slab over them (its top at the next level).
  await archi.command('Wall', ...outline, 'Close')
  await archi.command('Slab', ...outline.map((p) => `${p},${height}`), '')
}
archi.log(`Tower of ${storeys} levels made: ${archi.objects((o) => o.command === 'Wall').length} walls`)
