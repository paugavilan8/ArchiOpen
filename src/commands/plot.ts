import type { CadObject } from '../core/document'
import type { Layout } from '../core/layout'
import { millimetersPer } from '../core/units'
import { DXF, PDF } from '../app/files'
import { writeDxf } from '../io/dxf'
import { PAPER_SIZES, Sheet, writePdf } from '../io/pdf'
import { plotSheet, PlotOptions } from '../io/plot'
import { cachedHiddenLines, computeHiddenLines, HiddenDrawings, layoutSheet, usesHiddenLines } from '../io/layoutSheet'
import { formatValue, isOption } from './helpers'
import { kernel } from './solids'
import type { Command, CommandContext } from './runner'

const PAPERS = Object.keys(PAPER_SIZES)

/** Print settings, remembered between commands (and shared with the DXF linetype scale). */
const memory: PlotOptions = { paper: 'A3', landscape: true, scale: null, area: 'Extents', black: false }

/** The selection if there is one, otherwise everything visible. */
export function chosenObjects(ctx: CommandContext): CadObject[] {
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
    if (display.activeLayout !== null) return printLayouts(ctx)
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

const layoutMemory = { all: false }

/** Layouts as PDF sheets, their hidden line details worked out by the kernel. */
export async function layoutSheets(ctx: CommandContext, layouts: Layout[], black: boolean): Promise<Sheet[]> {
  const { doc, log } = ctx
  const hidden: HiddenDrawings = new Map()
  if (layouts.some((l) => l.details.some(usesHiddenLines))) {
    await kernel(ctx)
    log('Removing hidden lines…')
  }
  const sheets: Sheet[] = []
  for (const layout of layouts) {
    const sheetNumber = doc.layouts.indexOf(layout) + 1
    for (const d of layout.details) if (usesHiddenLines(d)) hidden.set(d.id, cachedHiddenLines(doc, d) ?? (await computeHiddenLines(doc, d)))
    sheets.push(layoutSheet(doc, layout, { black, sheetNumber, sheetCount: doc.layouts.length }, hidden))
    hidden.clear()
  }
  return sheets
}

/** The model's objects as a DXF file. */
export function dxfText(ctx: CommandContext, objects: CadObject[]): string {
  const { doc } = ctx
  return writeDxf({ units: doc.units, layers: doc.layers, objects, linetypeScale: memory.scale ?? 1, millimetersPerUnit: millimetersPer(doc.units) })
}

/** A view printed to one PDF sheet with the remembered print settings. */
export function viewSheet(ctx: CommandContext, objects: CadObject[]): Sheet {
  const sheet = plotSheet(ctx.doc, ctx.display.active, objects, memory)
  sheet.title = ctx.files.name
  return sheet
}

/** Prints the open layout, or all of them, to a PDF with one page per sheet. */
async function printLayouts(ctx: CommandContext): Promise<void> {
  const { doc, display, input, files, log } = ctx
  for (;;) {
    const option = await input.getOption('Print layouts to PDF. Press Enter to save', [
      `Sheets=${layoutMemory.all ? 'All' : 'Current'}`,
      `Color=${memory.black ? 'Black' : 'Display'}`,
    ])
    if (option === null) break
    if (isOption(option, 'Sheets')) layoutMemory.all = !layoutMemory.all
    else if (isOption(option, 'Color')) memory.black = !memory.black
  }
  const layouts = layoutMemory.all ? doc.layouts : doc.layouts.filter((l) => l.id === display.activeLayout)
  if (layouts.length === 0) throw new Error('There is no layout to print')
  const sheets = await layoutSheets(ctx, layouts, memory.black)
  const fileName = await files.exportFile(PDF, () => writePdf(sheets))
  if (fileName) log(`Saved ${fileName} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'})`)
}

const exportDxf: Command = {
  name: 'ExportDXF',
  history: false,
  repeat: false,
  async run(ctx) {
    const { doc, files, log } = ctx
    const objects = chosenObjects(ctx)
    const fileName = await files.exportFile(DXF, () => new TextEncoder().encode(dxfText(ctx, objects)))
    if (fileName) log(`Exported ${objects.length} object${objects.length === 1 ? '' : 's'} to ${fileName}`)
  },
}

export const plotCommands: Command[] = [exportPdf, exportDxf]
