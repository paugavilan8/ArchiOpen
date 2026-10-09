import { PNG } from '../app/files'
import { MATERIAL_PRESETS } from '../core/materials'
import { canvasToPng, showRenderWindow } from '../ui/renderWindow'
import { isOption, plural, valueOption, yesNo } from './helpers'
import type { Command, CommandContext } from './runner'

/** Rendering: images of the model with materials, sun and shadows. */

const SIZES: Record<string, [number, number] | null> = {
  Viewport: null,
  HD: [1280, 720],
  FullHD: [1920, 1080],
  '4K': [3840, 2160],
}

const memory = { size: 'FullHD', captureScale: 2, captureGrid: false }

/** The pixel size of the active viewport at a scale. */
const viewportSize = (ctx: CommandContext, scale: number): [number, number] => [Math.round(ctx.display.active.width * scale), Math.round(ctx.display.active.height * scale)]

async function saveImage(ctx: CommandContext, canvas: HTMLCanvasElement): Promise<void> {
  const name = await ctx.files.exportFile(PNG, () => canvasToPng(canvas))
  if (name) ctx.log(`Saved ${canvas.width} × ${canvas.height} image to ${name}`)
}

const render: Command = {
  name: 'Render',
  history: false,
  repeat: false,
  async run(ctx) {
    const { display, input, log } = ctx
    const names = Object.keys(SIZES)
    for (;;) {
      const option = await input.getOption('Render the active view. Press Enter to start', [`Size=${memory.size}`])
      if (option === null) break
      if (isOption(option, 'Size')) memory.size = names[(names.indexOf(memory.size) + 1) % names.length]
    }
    const [width, height] = SIZES[memory.size] ?? viewportSize(ctx, 1)
    log(`Rendering ${width} × ${height}…`)
    // Let the message show before the work starts.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const started = performance.now()
    // Large images are sharp enough without drawing them twice the size, which would take long.
    const image = display.captureImage(display.active, width, height, { mode: 'rendered', supersample: Math.max(width, height) > 2000 ? 1 : 2, occlusion: true })
    log(`Rendered in ${((performance.now() - started) / 1000).toFixed(1)} s`)
    await showRenderWindow(image, `Render — ${display.active.kind}, ${width} × ${height}`, () => saveImage(ctx, image))
  },
}

const viewCaptureToFile: Command = {
  name: 'ViewCaptureToFile',
  history: false,
  repeat: false,
  async run(ctx) {
    const { display, input } = ctx
    for (;;) {
      const option = await input.getOption('Save an image of the active view. Press Enter to save', [valueOption('Scale', memory.captureScale), yesNo('Grid', memory.captureGrid)])
      if (option === null) break
      if (isOption(option, 'Grid')) memory.captureGrid = !memory.captureGrid
      else {
        const n = await input.getNumber('Image size, times the view’s size', memory.captureScale)
        if (typeof n === 'number' && n > 0 && n <= 8) memory.captureScale = n
      }
    }
    const [width, height] = viewportSize(ctx, memory.captureScale)
    const image = display.captureImage(display.active, width, height, { grid: memory.captureGrid, supersample: 2 })
    await saveImage(ctx, image)
  },
}

const BACKGROUNDS = ['Studio', 'White', 'Sky'] as const

const sun: Command = {
  name: 'Sun',
  history: false,
  async run(ctx) {
    const { doc, input, log } = ctx
    for (;;) {
      const s = doc.renderSettings
      const option = await input.getOption('Sun and backdrop for rendering. Press Enter when done', [
        valueOption('Azimuth', s.sunAzimuth),
        valueOption('Altitude', s.sunAltitude),
        valueOption('Intensity', s.sunIntensity),
        `Background=${s.background}`,
        yesNo('GroundShadows', s.groundShadows),
      ])
      if (option === null) break
      if (isOption(option, 'Background')) doc.setRenderSettings({ background: BACKGROUNDS[(BACKGROUNDS.indexOf(s.background) + 1) % BACKGROUNDS.length] })
      else if (isOption(option, 'GroundShadows')) doc.setRenderSettings({ groundShadows: !s.groundShadows })
      else {
        const [key, prompt] = isOption(option, 'Azimuth')
          ? (['sunAzimuth', 'Direction the sun shines from, in degrees from north (90 is east)'] as const)
          : isOption(option, 'Altitude')
            ? (['sunAltitude', 'Height of the sun above the horizon, in degrees'] as const)
            : (['sunIntensity', 'Sun intensity (2.5 is a clear day)'] as const)
        const n = await input.getNumber(prompt, s[key])
        if (typeof n !== 'number') continue
        if (key === 'sunAltitude' && (n < 1 || n > 90)) log('The altitude must be between 1 and 90 degrees')
        else if (key === 'sunIntensity' && n < 0) log('The intensity cannot be negative')
        else doc.setRenderSettings({ [key]: key === 'sunAzimuth' ? ((n % 360) + 360) % 360 : n })
      }
    }
  },
}

/** Gives the selected objects a material, by name (a preset is added to the document if needed). */
const setObjectMaterial: Command = {
  name: 'SetObjectMaterial',
  async run(ctx) {
    const { doc, input, log } = ctx
    const ids = await input.getObjects('Select objects')
    const known = [...doc.materials.map((m) => m.name), ...MATERIAL_PRESETS.map((m) => m.name).filter((n) => !doc.materials.some((m) => m.name === n))]
    const typed = (await input.getString(`Material name, or "ByLayer" (${known.slice(0, 8).join(', ')}, …)`))?.trim()
    if (!typed) return
    if (typed.toLowerCase() === 'bylayer') {
      for (const id of ids) doc.setState(id, { material: undefined })
      log(`${plural('object', ids.length)} use their layer’s material`)
      return
    }
    const lower = typed.toLowerCase()
    const name = known.find((n) => n.toLowerCase() === lower) ?? known.find((n) => n.toLowerCase().startsWith(lower))
    if (!name) throw new Error(`There is no material named "${typed}"`)
    const preset = MATERIAL_PRESETS.find((m) => m.name === name)
    if (!doc.materials.some((m) => m.name === name) && preset) doc.setMaterials([...doc.materials, { ...preset }])
    for (const id of ids) doc.setState(id, { material: name })
    log(`${plural('object', ids.length)} now ${name}`)
  },
}

export const renderCommands: Command[] = [render, viewCaptureToFile, sun, setObjectMaterial]
