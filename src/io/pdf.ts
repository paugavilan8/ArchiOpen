/**
 * A minimal vector PDF writer: one page of stroked polylines and filled regions, which is all a
 * line drawing needs. Coordinates are millimeters on the sheet, from its lower left corner.
 */

type Point = [number, number]

export interface SheetItem {
  /** Open or closed polylines to stroke. */
  lines: Point[][]
  /** Regions to fill; each is a list of loops filled with the even-odd rule (inner loops are holes). */
  fills: Point[][][]
  /** Hex color, e.g. '#1f6fb5'. */
  color: string
  /** Stroke width in millimeters. */
  width: number
  /** Dash pattern in millimeters (drawn, gap, drawn, gap…); empty for a continuous line. */
  dashes: number[]
}

export interface Sheet {
  width: number
  height: number
  items: SheetItem[]
  title?: string
  /** Rectangle [x, y, width, height] outside which nothing is drawn. */
  clip?: [number, number, number, number]
}

const PT = 72 / 25.4
const num = (v: number) => {
  const s = v.toFixed(3)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

function rgb(hex: string): string {
  const v = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => num(c / 255)).join(' ')
}

/** The page's drawing operators. */
export function contentStream(sheet: Sheet): string {
  const out: string[] = ['1 J 1 j']
  if (sheet.clip) out.push(`${sheet.clip.map((v) => num(v * PT)).join(' ')} re W n`)
  const at = ([x, y]: Point) => `${num(x * PT)} ${num(y * PT)}`
  // Fills first, so line work stays on top of solid hatches.
  for (const item of sheet.items) {
    if (item.fills.length === 0) continue
    out.push(`${rgb(item.color)} rg`)
    for (const region of item.fills) {
      for (const loop of region) {
        if (loop.length < 3) continue
        out.push(`${at(loop[0])} m`, ...loop.slice(1).map((p) => `${at(p)} l`), 'h')
      }
      out.push('f*')
    }
  }
  for (const item of sheet.items) {
    if (item.lines.length === 0) continue
    // A zero dash with round caps is a dot.
    const dashes = item.dashes.map((d) => num(Math.abs(d) * PT))
    out.push(`${rgb(item.color)} RG`, `${num(item.width * PT)} w`, `[${dashes.join(' ')}] 0 d`)
    for (const line of item.lines) {
      if (line.length < 2) continue
      out.push(`${at(line[0])} m`, ...line.slice(1).map((p) => `${at(p)} l`), 'S')
    }
  }
  return out.join('\n')
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 255)

/** Escapes a string for a PDF literal; characters outside Latin-1 become '?'. */
const pdfString = (text: string) => `(${text.replace(/[^\x20-\xff]/g, '?').replace(/[\\()]/g, '\\$&')})`

/** Writes the sheet as a one-page PDF file. */
export async function writePdf(sheet: Sheet): Promise<Uint8Array> {
  const content = await deflate(latin1(contentStream(sheet)))
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (bytes: Uint8Array) => {
    parts.push(bytes)
    length += bytes.length
  }
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length
    push(latin1(`${n} 0 obj\n${body}\n`))
    if (stream) {
      push(latin1('stream\n'))
      push(stream)
      push(latin1('\nendstream\n'))
    }
    push(latin1('endobj\n'))
  }

  push(latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'))
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(sheet.width * PT)} ${num(sheet.height * PT)}] /Contents 4 0 R /Resources << >> >>`)
  object(4, `<< /Length ${content.length} /Filter /FlateDecode >>`, content)
  object(5, `<< /Producer (ArchiOpen)${sheet.title ? ` /Title ${pdfString(sheet.title)}` : ''} >>`)

  const xref = length
  const rows = offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
  push(latin1(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${rows.join('')}`))
  push(latin1(`trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`))

  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Standard paper sizes in millimeters, portrait. */
export const PAPER_SIZES: Record<string, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  Letter: [215.9, 279.4],
  Tabloid: [279.4, 431.8],
}
