// A grid of columns: 4 bays by 3, 6 m apart, on the current level.
// Run it with File > Run Script.
const bays = { x: 4, y: 3 }
const spacing = 6000

for (let i = 0; i <= bays.x; i++) {
  for (let j = 0; j <= bays.y; j++) {
    // Column asks for each centre, and ends on Enter.
    await archi.command('Column', `${i * spacing},${j * spacing}`, '')
  }
}
archi.log(`${(bays.x + 1) * (bays.y + 1)} columns placed`)
