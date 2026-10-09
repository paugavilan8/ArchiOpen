import type { CadObject } from '../core/document'
import { millimetersPer } from '../core/units'
import { DXF, PDF } from '../app/files'
import { writeDxf } from '../io/dxf'
import { PAPER_SIZES, writePdf } from '../io/pdf'
import { plotSheet, PlotOptions } from '../io/plot'
import { formatValue, isOption } from './helpers'
import type { Command, CommandContext } from './runner'

const PAPERS = Object.keys(PAPER_SIZES)

/** Print settings, remembered between commands (and shared with the DXF linetype scale). */
const memory: PlotOptions = { paper: 'A3', landscape: true, scale: null, area: 'Extents', black: false }

/** The selection if there is one, otherwise everything visible. */
function chosenObjects(ctx: CommandContext): CadObject[] {
  const { doc } = ctx
  const chosen = doc.selection.size > 0 ? [...doc.selection].map((id) => doc.objects.get(id)!) : [...doc.objects.values()].filter((o) => doc.isVisible(o))
  if (chosen.length === 0) throw new Error('There is nothing to export')
  return chosen
}

async function askScale(ctx: CommandContext): Promise<void> {
  const value = await ctx.input.getNumber('Drawing scale 1:n (0 to fit the paper)', memory.scale ?? 0)
  if (typeof value === 'number' && value >= 0) memory.scale = value > 0 ? value : null
}

const exportPdf: Command = {
  name: 'ExportPDF',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, display, input, files, log } = ctx
    const objects = chosenObjects(ctx)
    for (;;) {
      const option = await input.getOption(`Print the ${display.active.kind} view to PDF. Press Enter to save`, [
        `Paper=${memory.paper}`,
        `Orientation=${memory.landscape ? 'Landscape' : 'Portrait'}`,
        `Scale=${memory.scale ? `1:${formatValue(memory.scale)}` : 'Fit'}`,
        `Area=${memory.area}`,
        `Color=${memory.black ? 'Black' : 'Display'}`,
      ])
      if (option === null) break
      if (isOption(option, 'Paper')) memory.paper = PAPERS[(PAPERS.indexOf(memory.paper) + 1) % PAPERS.length]
      else if (isOption(option, 'Orientation')) memory.landscape = !memory.landscape
      else if (isOption(option, 'Scale')) await askScale(ctx)
      else if (isOption(option, 'Area')) memory.area = memory.area === 'Extents' ? 'View' : 'Extents'
      else if (isOption(option, 'Color')) memory.black = !memory.black
    }
    const sheet = plotSheet(doc, display.active, objects, memory)
    sheet.title = files.name
    if (memory.scale && display.active.kind === 'Perspective') log('Perspective views are fitted to the paper')
    const fileName = await files.exportFile(PDF, () => writePdf(sheet))
    if (fileName) log(`Saved ${fileName} (${memory.paper} ${memory.landscape ? 'landscape' : 'portrait'})`)
  },
}

const exportDxf: Command = {
  name: 'ExportDXF',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, files, log } = ctx
    const objects = chosenObjects(ctx)
    const fileName = await files.exportFile(DXF, () =>
      new TextEncoder().encode(
        writeDxf({
          units: doc.units,
          layers: doc.layers,
          objects,
          linetypeScale: memory.scale ?? 1,
          millimetersPerUnit: millimetersPer(doc.units),
        }),
      ),
    )
    if (fileName) log(`Exported ${objects.length} object${objects.length === 1 ? '' : 's'} to ${fileName}`)
  },
}

export const plotCommands: Command[] = [exportPdf, exportDxf]
