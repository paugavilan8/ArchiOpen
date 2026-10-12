#!/usr/bin/env node
// ArchiOpen MCP server: lets Claude (or any MCP client) model in a running ArchiOpen.
//
// The MCP client starts this server and talks to it over stdio. The server listens for the app on
// this computer only (127.0.0.1); the app connects when the user runs McpConnect. Each tool call
// goes to the app, runs there, and its answer comes back.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.ARCHIOPEN_PORT ?? 47800)
// Pages allowed to connect as the app: the desktop app, and the app served on this computer.
const EXTRA_ORIGINS = (process.env.ARCHIOPEN_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
const allowedOrigin = (origin) =>
  !origin || /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin) || EXTRA_ORIGINS.includes(origin)

const log = (...args) => console.error('[archiopen-mcp]', ...args)

// --- The app's end --------------------------------------------------------------------------

let app = null
let nextId = 1
const pending = new Map()

const sockets = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ origin }) => allowedOrigin(origin),
})
sockets.on('listening', () => log(`waiting for ArchiOpen on 127.0.0.1:${PORT} (run McpConnect in the app)`))
sockets.on('error', (error) => log(`could not listen on port ${PORT}: ${error.message}`))
sockets.on('connection', (socket) => {
  // The newest window is the one to work in.
  if (app && app !== socket) app.close()
  app = socket
  log('ArchiOpen connected')
  socket.on('message', (data) => {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    call.resolve(message)
  })
  socket.on('close', () => {
    if (app !== socket) return
    app = null
    log('ArchiOpen disconnected')
    for (const [id, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new Error('ArchiOpen closed the connection'))
      pending.delete(id)
    }
  })
})

/** Waits a little for the app (it retries every few seconds), then sends it a call. */
async function callApp(tool, args, timeout = 300_000) {
  for (let i = 0; i < 20 && !app; i++) await new Promise((r) => setTimeout(r, 500))
  if (!app) throw new Error('ArchiOpen is not connected. Open the app and run McpConnect (File > Connect AI Assistant), then try again.')
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`ArchiOpen took longer than ${timeout / 1000} s to answer`))
    }, timeout)
    pending.set(id, { resolve, reject, timer })
    app.send(JSON.stringify({ id, tool, args }))
  })
}

// --- The tools ------------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_model',
    description: 'Summary of the open model: units, levels (name, elevation, floor-to-floor height) and the current one, layers with their object counts, objects counted by the command that made them (Wall, Slab, ...) or their type, and the selection.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_commands',
    description: 'Names of the commands the app has (Rhino-like: Line, Polyline, Box, Extrude, Wall, Slab, Roof, Stair, Window, Door, Level, Room, DrawingSet, ...), optionally only those containing some text.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Text the names must contain' } } },
  },
  {
    name: 'list_objects',
    description: 'Objects in the model, with id, type, layer, the command and parameters of those made with history (walls, slabs, ...), and the bounds of solids and meshes. Filter by layer, command or type.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string' },
        command: { type: 'string', description: 'For example Wall, Slab, Roof, Stair, Column' },
        type: { type: 'string', description: 'polyline, brep, mesh, point, annotation, ...' },
        limit: { type: 'number', description: 'At most this many (default 200)' },
      },
    },
  },
  {
    name: 'run_command',
    description:
      'Runs one command with its answers to its prompts, in order, as typed in the command line: points as "x,y" or "x,y,z" (model units, usually millimeters), numbers, option names (e.g. "Close", "Type", "Both"), or "" for Enter. When the answers run out the command gets Enter until it ends, so give every point it needs. Commands usually select what they make: the ids selected after it are returned, with the lines it wrote to the history. Example: name "Wall", answers ["0,0", "8000,0", "8000,5000", "0,5000", "Close"]. Walls, slabs, columns and stairs use the current level; Level ["New", "Level 1", "3000", "3000", ""] adds one.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        answers: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_script',
    description:
      'Runs JavaScript in the app as the body of an async function, with the `archi` API: await archi.command(name, ...answers) (as run_command, resolves to the ids made), archi.add(geometry, layer), archi.remove(ids), archi.objects(filter), archi.select(ids), archi.levels(), archi.setLevel(name), await archi.step(fn) (one undo step), archi.v(x, y, z), archi.log(...). Use it for loops and repetition (grids of columns, many levels, arrays).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'view',
    description: 'An image of a view of the model, to see the result: Perspective (default), Top, Front or Right, zoomed to everything unless zoom_extents is false, optionally in a display mode (Wireframe, Shaded, Rendered, Ghosted, XRay).',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['Perspective', 'Top', 'Front', 'Right'] },
        zoom_extents: { type: 'boolean' },
        display_mode: { type: 'string' },
        width: { type: 'number', description: 'Image width in pixels (default 1024)' },
      },
    },
  },
  {
    name: 'undo',
    description: 'Undoes the last steps (default 1).',
    inputSchema: { type: 'object', properties: { steps: { type: 'number' } } },
  },
]

const server = new Server(
  { name: 'archiopen', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'ArchiOpen is an open-source 3D modeler for architecture, driven like Rhino by commands. Start with get_model to see the units and levels. Build with run_command (or run_script for repetition), then check the result with view. Lengths are in the model units (usually millimeters: a 3 m wall is 3000). Architecture commands: Level, Wall, CurtainWall, Slab, Roof, Stair, Column, Railing, Window, Door, Room, Floor, Skirting, Terrain; drawings: Elevations, Section, Schedule, DrawingSet. Everything can be undone.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  if (!TOOLS.some((t) => t.name === name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  try {
    const answer = await callApp(name, args)
    if (answer.error) return { content: [{ type: 'text', text: answer.error }], isError: true }
    const content = []
    if (answer.image) content.push({ type: 'image', data: answer.image, mimeType: 'image/png' })
    content.push({ type: 'text', text: JSON.stringify(answer.result ?? null, null, 1) })
    return { content }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
