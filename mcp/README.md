# ArchiOpen MCP server

Lets Claude (or any client of the [Model Context Protocol](https://modelcontextprotocol.io)) model
in a running ArchiOpen: ask in plain words for a house, a tower or a set of drawings, and the
assistant runs the commands in your model, looks at the result and corrects it.

## How it works

```
Claude Desktop / Claude Code  <-- stdio -->  this server  <-- ws://127.0.0.1:47800 -->  ArchiOpen
```

The assistant starts this server. The server listens on your computer only, and ArchiOpen connects
to it when you turn the connection on with **McpConnect** (*File > Connect AI Assistant*). The
status bar shows when an assistant is connected. Every tool call runs in the app, as if you had
typed it, and can be undone.

## Tools

| Tool | What it does |
| --- | --- |
| `get_model` | Units, levels, layers, objects by kind, selection. |
| `list_commands` | The commands the app has. |
| `list_objects` | Objects with their layer, the parameters of walls, slabs and so on, and their bounds. |
| `run_command` | Runs a command with its answers (points, numbers, options, Enter). |
| `run_script` | Runs JavaScript with the `archi` API, for loops and repetition. |
| `view` | An image of a view (Perspective, Top, Front, Right), so the assistant sees what it made. |
| `undo` | Undoes the last steps. |

## Setting it up

You need [Node.js](https://nodejs.org) 18 or later and a copy of this repository.

```
cd mcp
npm install
```

**Claude Code:**

```
claude mcp add archiopen -- node /path/to/ArchiOpen/mcp/server.mjs
```

**Claude Desktop:** add it to `claude_desktop_config.json` (*Settings > Developer > Edit Config*),
then restart Claude:

```json
{
  "mcpServers": {
    "archiopen": {
      "command": "node",
      "args": ["/path/to/ArchiOpen/mcp/server.mjs"]
    }
  }
}
```

On Windows, write the path with double backslashes, as in `"C:\\Users\\me\\ArchiOpen\\mcp\\server.mjs"`.

Then open ArchiOpen (the desktop app, or `npm run dev` in the browser) and run **McpConnect** >
**Connect**. The app stays connected, also after restarting, until you run McpConnect >
**Disconnect**.

Try asking, for example: *"Model a two-level house of 10 by 8 m with a gable roof, a stair between
the levels and windows on the south side, then make its drawing set."*

## Settings

- `ARCHIOPEN_PORT`: the port to listen on (default 47800; set the same with McpConnect > Port).
- `ARCHIOPEN_ORIGINS`: other pages allowed to connect as the app, comma separated, if you serve it
  at another address. By default only the desktop app and pages on this computer can.

## Safety

The server accepts connections from your own computer only, and the app connects only while you
have it on. A connected assistant can do in your model whatever you can, including running scripts,
so connect it when you want it to work, keep your files saved, and undo what you do not want.
