// A twisting tower, as a parametric script: run it with File > Parametric Script and move the
// sliders. Each floor is a slab turned a little more than the one under it.
const floors = archi.param('Floors', 12, { min: 1, max: 40 })
const height = archi.param('Floor height', 3200, { min: 2500, max: 5000, step: 100 })
const width = archi.param('Width', 20000, { min: 8000, max: 40000, step: 500 })
const depth = archi.param('Depth', 14000, { min: 8000, max: 40000, step: 500 })
const twist = archi.param('Twist (°)', 4, { min: 0, max: 15, step: 0.5 })

const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
for (let n = 1; n <= floors; n++) {
  const a = (n * twist * Math.PI) / 180
  const z = n * height
  const points = corners.map(([sx, sy]) => {
    const [x, y] = [(sx * width) / 2, (sy * depth) / 2]
    // "w": world coordinates, whatever the current level.
    return `w${Math.round(x * Math.cos(a) - y * Math.sin(a))},${Math.round(x * Math.sin(a) + y * Math.cos(a))},${z}`
  })
  await archi.command('Slab', ...points, '')
}
archi.log(`Tower of ${floors} floors, ${twist}° a floor`)
