// A two-storey house: walls with doors and windows, floors, a stair, a hip roof and rooms.
// Help > Open Example House runs it on a new model; or run it with File > Run Script.
// Then try DrawingSet for its plans, elevations and sections, or ExportIFC for BIM.
const [width, depth] = [10000, 7000]
const storey = 2800
const outline = [`0,0`, `${width},0`, `${width},${depth}`, `0,${depth}`]
const win = (at, w = 1500) => ({ kind: 'window', at, width: w, height: 1200, sill: 900 })
const door = (at) => ({ kind: 'door', at, width: 1000, height: 2100, sill: 0 })
const walls = () => archi.objects((o) => o.command === 'Wall').map((o) => o.id)
const withIds = (openings) => openings.map((o, i) => ({ ...o, id: i + 1 }))

for (const [n, name] of ['Level 0', 'Level 1'].entries()) {
  const exists = archi.levels().some((l) => l.name === name)
  await archi.command('Level', exists ? 'Edit' : 'New', name, n * storey, storey, '')
}

// Ground floor. The ring of walls is measured along its line from the first corner, going round:
// the south side from 0 to 10000, the east side to 17000, the north to 27000, the west to 34000.
archi.setLevel('Level 0')
await archi.command('Wall', ...outline, 'Close')
const ground = walls().at(-1)
await archi.setParams(ground, { openings: withIds([door(2000), win(5000), win(8000), win(13500, 2400), win(19000), win(24000, 2400), win(30500)]) })
// An inner wall between the living room and the kitchen, with a doorway.
await archi.command('Wall', '6000,0', '6000,7000', '')
await archi.setParams(walls().at(-1), { openings: withIds([door(5500)]) })
// The first floor slab, its top at the next level; then the stair up through it.
await archi.command('Slab', ...outline.map((p) => `${p},${storey}`), '')
await archi.command('Stair', '9300,1000', '9300,5400', '')
await archi.command('Room', '3000,3500', 'Living', '7500,5000', 'Kitchen', '')

// First floor.
archi.setLevel('Level 1')
await archi.command('Wall', ...outline, 'Close')
await archi.setParams(walls().at(-1), { openings: withIds([win(2500), win(7500), win(13500), win(19500), win(24500), win(30500)]) })
await archi.command('Wall', '5000,0', '5000,7000', '')
await archi.setParams(walls().at(-1), { openings: withIds([door(1500)]) })
await archi.command('Room', '2500,3500', 'Bedroom', '7000,2000', 'Bedroom 2', '')
// A hip roof over it, its eaves on the walls.
await archi.command('Roof', ...outline, '')

await archi.command('Zoom', 'All')
archi.log('Example house made. Try DrawingSet for its drawings, Schedule for its doors, windows and rooms, or ExportIFC.')
