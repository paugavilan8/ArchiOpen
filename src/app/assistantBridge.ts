import type { CommandContext, CommandRunner } from '../commands/runner'
import type { Display } from '../view/display'
import type { ViewKind } from '../view/viewport'
import { runScript, scriptApi } from './scripting'
import { framesFor, wallPieces } from './ifcNative'
import { ifcModel } from '../io/ifcModel'
import { writeIfc } from '../io/ifc'
import { writePdf } from '../io/pdf'
import { quantitiesCsv, sumQuantities } from '../core/quantities'
import { quantityItems } from '../commands/quantities'

/**
 * The bridge to an AI assistant (Claude or any MCP client): the ArchiOpen MCP server (in `mcp/`)
 * listens on this computer only, and the app connects to it when asked (McpConnect). The assistant's
 * tool calls arrive as requests; each runs here, in the app, and its answer goes back. Nothing is
 * reachable from outside this computer, and the app only connects while the user has it on.
 */

export interface BridgeRequest {
  id: number
  tool: string
  args?: Record<string, unknown>
}

export interface BridgeResponse {
  id: number
  result?: unknown
  /** A PNG image, base64, for view captures. */
  image?: string
  error?: string
}

export type BridgeState = 'off' | 'waiting' | 'connected'

export const DEFAULT_PORT = 47800
const SETTINGS_KEY = 'archiopen:assistant'
const VIEWS: ViewKind[] = ['Top', 'Front', 'Right', 'Perspective']

/** What a tool call does in the app, given the app's parts. */
export function toolHandlers(ctx: CommandContext, runner: CommandRunner, display: Display | null) {
  const { doc } = ctx
  // The lines the app writes to its history while a call runs, to answer with.
  const logged = async <T>(run: () => Promise<T>): Promise<{ value: T; log: string[] }> => {
    const lines: string[] = []
    const original = ctx.log
    ctx.log = (text: string) => {
      lines.push(text)
      original(text)
    }
    try {
      return { value: await run(), log: lines }
    } finally {
      ctx.log = original
    }
  }
  const box = (vertices: ArrayLike<number> | undefined) => {
    if (!vertices || vertices.length < 3) return undefined
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < vertices.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], vertices[i + k])
        hi[k] = Math.max(hi[k], vertices[i + k])
      }
    return { min: lo.map((v) => Math.round(v)), max: hi.map((v) => Math.round(v)) }
  }
  return {
    get_model: async () => {
      const counts: Record<string, number> = {}
      for (const o of doc.objects.values()) {
        const key = o.history?.command ?? o.geometry.type
        counts[key] = (counts[key] ?? 0) + 1
      }
      return {
        units: doc.units,
        levels: doc.levels,
        currentLevel: doc.currentLevel,
        layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, objects: [...doc.objects.values()].filter((o) => o.layerId === l.id).length })),
        objects: counts,
        selected: [...doc.selection],
      }
    },
    list_commands: async (args: Record<string, unknown>) => {
      const filter = String(args.filter ?? '').toLowerCase()
      return runner.names.filter((n) => n.toLowerCase().includes(filter))
    },
    list_objects: async (args: Record<string, unknown>) => {
      const limit = Math.min(Number(args.limit ?? 200), 1000)
      const out = []
      for (const o of doc.objects.values()) {
        const layer = doc.layerOf(o).name
        if (args.layer && layer !== args.layer) continue
        if (args.command && o.history?.command !== args.command) continue
        if (args.type && o.geometry.type !== args.type) continue
        const g = o.geometry
        const vertices = g.type === 'brep' ? g.display.vertices : g.type === 'mesh' ? g.vertices : undefined
        out.push({ id: o.id, type: g.type, layer, ...(o.history ? { command: o.history.command, params: o.history.params } : {}), ...(vertices ? { bounds: box(vertices) } : {}) })
        if (out.length >= limit) break
      }
      return out
    },
    run_command: async (args: Record<string, unknown>) => {
      const name = String(args.name ?? '')
      const answers = Array.isArray(args.answers) ? args.answers.map(String) : []
      const { log } = await logged(() => runner.runWith(name, answers))
      return { log, selected: [...doc.selection], objects: doc.objects.size }
    },
    run_script: async (args: Record<string, unknown>) => {
      const { log } = await logged(() => runScript(String(args.code ?? ''), scriptApi(ctx, runner)))
      return { log, selected: [...doc.selection], objects: doc.objects.size }
    },
    undo: async (args: Record<string, unknown>) => {
      const steps = Math.max(1, Math.min(Number(args.steps ?? 1), 50))
      const { log } = await logged(async () => {
        for (let i = 0; i < steps; i++) await runner.runWith('Undo', [])
      })
      return { log, objects: doc.objects.size }
    },
    export: async (args: Record<string, unknown>) => {
      const format = String(args.format ?? '').toLowerCase()
      const bytes = await exportBytes(ctx, format)
      return { data: toBase64(bytes), format, bytes: bytes.length }
    },
    open_model: async (args: Record<string, unknown>) => {
      if (doc.modified && args.discard_changes !== true) throw new Error('The open model has unsaved changes: save it first (export format "archi"), or pass discard_changes: true')
      const fileName = String(args.file_name ?? 'model.archi')
      const message = await ctx.files.openFile(fileName, fromBase64(String(args.data ?? '')))
      if (ctx.files.nativeWalls.length > 0) {
        await framesFor(ctx, ctx.files.nativeWalls)
        await ctx.history?.settled
        doc.modified = false
      }
      ctx.display?.fit(ctx.display.viewports)
      ctx.log(message)
      return { message, objects: doc.objects.size }
    },
    new_model: async (args: Record<string, unknown>) => {
      if (doc.modified && args.discard_changes !== true) throw new Error('The open model has unsaved changes: save it first (export format "archi"), or pass discard_changes: true')
      doc.clear()
      ctx.files.restore('Untitled', null)
      return { objects: doc.objects.size }
    },
    set_params: async (args: Record<string, unknown>) => {
      const id = Number(args.id)
      const record = doc.objects.get(id)?.history
      if (!record) throw new Error(`Object ${id} has no parameters to change (it was not made by an architecture command with history)`)
      const params = { ...(record.params ?? {}), ...((args.params as Record<string, unknown>) ?? {}) }
      if (!ctx.history) throw new Error('Construction history is not available here')
      await ctx.history.remakeStep(id, { ...record, params })
      return { id, command: record.command, params: doc.objects.get(id)?.history?.params ?? params }
    },
    delete_objects: async (args: Record<string, unknown>) => {
      const ids = (Array.isArray(args.ids) ? args.ids : []).map(Number).filter((id) => doc.objects.has(id))
      if (ids.length === 0) throw new Error('None of those objects exist')
      doc.begin()
      for (const id of ids) doc.remove(id)
      doc.commit()
      return { deleted: ids, objects: doc.objects.size }
    },
    view: async (args: Record<string, unknown>) => {
      if (!display) throw new Error('There is no view to capture here')
      const kind = VIEWS.find((v) => v.toLowerCase() === String(args.view ?? 'Perspective').toLowerCase()) ?? 'Perspective'
      const vp = display.viewports.find((v) => v.kind === kind) ?? display.active
      display.setActive(vp)
      if (args.zoom_extents !== false) await runner.runWith('Zoom', ['Extents'])
      if (args.display_mode) await runner.runWith('SetDisplayMode', [String(args.display_mode)])
      const width = Math.max(200, Math.min(Number(args.width ?? 1024), 2048))
      const rect = vp.el.getBoundingClientRect()
      const height = Math.round((width * Math.max(rect.height, 1)) / Math.max(rect.width, 1))
      const canvas = display.captureImage(vp, width, height, { grid: false, supersample: 1 })
      return { image: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), view: kind }
    },
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** The model as a file of some format, as an export from the menus would write it. */
async function exportBytes(ctx: CommandContext, format: string): Promise<Uint8Array> {
  const { doc } = ctx
  const text = (t: string) => new TextEncoder().encode(t)
  const visible = [...doc.objects.values()].filter((o) => doc.isVisible(o))
  switch (format) {
    case 'archi':
      return ctx.files.archiData()
    case 'ifc': {
      const model = ifcModel(doc, ctx.files.name, await wallPieces(doc))
      if (model.elements.length === 0 && model.spaces.length === 0) throw new Error('There is nothing to export to IFC')
      return text(writeIfc(model))
    }
    case 'csv': {
      const rows = sumQuantities(quantityItems(ctx), doc.levels.map((l) => l.name))
      if (rows.length === 0) throw new Error('There are no building elements to measure')
      return text(quantitiesCsv(rows))
    }
    case 'dxf':
      return text((await import('../commands/plot')).dxfText(ctx, visible))
    case 'pdf': {
      // The layouts (sheets) if there are any, else the active view on one sheet.
      const { layoutSheets, viewSheet } = await import('../commands/plot')
      return writePdf(doc.layouts.length > 0 ? await layoutSheets(ctx, doc.layouts, false) : viewSheet(ctx, visible))
    }
    case 'glb':
      return (await import('../commands/meshes')).glbOf(ctx, visible)
    default:
      throw new Error('The format must be archi, ifc, pdf, dxf, glb or csv')
  }
}

/** The app end of the bridge: connects to the MCP server, answers its requests, and reconnects. */
export class AssistantBridge {
  state: BridgeState = 'off'
  port = DEFAULT_PORT
  private socket: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(state: BridgeState) => void>()
  private readonly handlers: ReturnType<typeof toolHandlers>

  constructor(
    private readonly ctx: CommandContext,
    runner: CommandRunner,
    display: Display | null,
  ) {
    this.handlers = toolHandlers(ctx, runner, display)
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
      if (Number.isInteger(saved.port)) this.port = saved.port
      if (saved.enabled) this.enable(this.port)
    } catch {
      // No saved settings.
    }
  }

  onChange(listener: (state: BridgeState) => void): void {
    this.listeners.add(listener)
  }

  enable(port = this.port): void {
    this.port = port
    this.store(true)
    this.close()
    this.connect()
  }

  disable(): void {
    this.store(false)
    this.close()
    this.set('off')
  }

  private store(enabled: boolean): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled, port: this.port }))
    } catch {
      // Lasts for this session.
    }
  }

  private set(state: BridgeState): void {
    if (state === this.state) return
    const was = this.state
    this.state = state
    if (state === 'connected') this.ctx.log('AI assistant connected: it can now run commands in this model (McpConnect to disconnect)')
    else if (was === 'connected') this.ctx.log('AI assistant disconnected')
    for (const l of this.listeners) l(state)
  }

  private close(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const s = this.socket
    this.socket = null
    if (s) {
      s.onclose = null
      s.close()
    }
  }

  private connect(): void {
    this.set('waiting')
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.port}`)
    } catch {
      this.retry = setTimeout(() => this.connect(), 3000)
      return
    }
    this.socket = socket
    socket.onopen = () => {
      socket.send(JSON.stringify({ hello: 'archiopen' }))
      this.set('connected')
    }
    socket.onmessage = (event) => {
      let request: BridgeRequest
      try {
        request = JSON.parse(String(event.data))
      } catch {
        return
      }
      // One call at a time, in order, as a person would work.
      this.queue = this.queue.then(() => this.answer(socket, request))
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.set('waiting')
      // The server may not be running yet (Claude starts it): try again shortly.
      this.retry = setTimeout(() => this.connect(), 3000)
    }
  }

  private async answer(socket: WebSocket, request: BridgeRequest): Promise<void> {
    const response: BridgeResponse = { id: request.id }
    try {
      const handler = (this.handlers as Record<string, (args: Record<string, unknown>) => Promise<unknown>>)[request.tool]
      if (!handler) throw new Error(`Unknown tool: ${request.tool}`)
      const result = await handler(request.args ?? {})
      if (request.tool === 'view') {
        const { image, ...rest } = result as { image: string }
        response.image = image
        response.result = rest
      } else response.result = result
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error)
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response))
  }
}

let current: AssistantBridge | null = null
export const assistantBridge = () => current
export function setAssistantBridge(bridge: AssistantBridge): void {
  current = bridge
}
