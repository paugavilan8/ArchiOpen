# Scripts, macros and the AI assistant

ArchiOpen can be driven from outside its menus in three ways: **macros** (a command name followed
by its answers, as typed at the command line), **scripts** (JavaScript files run with `RunScript`
or `Parametric`) and the **AI assistant** (an MCP client such as Claude, connected with
`McpConnect`). This page describes what they can rely on.

## Compatibility

From version 1.0, what is listed here is kept in every later version:

- **Command names and aliases** stay as they are, in every interface language. Commands may get
  new options; existing options keep their names.
- **The script API** (`archi`) only grows: functions are added, never removed or changed.
  `archi.apiVersion` tells which version a script runs with (1 at ArchiOpen 1.0), for scripts
  that use something added later.
- **The assistant's tools** keep their names and arguments; new ones may be added.

A test (`src/app/stableApi.test.ts`) holds the lists as they were at 1.0 and fails if anything
goes missing.

## Macros

A macro is a line as typed at the command line: a command and its answers, separated by spaces
(`''` or an empty answer is Enter). For example `Zoom All`, `SetDisplayMode Shaded`,
`Box 0,0 4000,3000 2800`. Menu items and toolbar buttons are macros too.

Points are typed as `x,y` (on the construction plane), `x,y,z`, `r20,10` or `@20,10` (relative to
the last point) and `w0,0,6400` (world coordinates). A single number while drawing from a point
is a distance.

## Scripts

A script runs as the body of an async function, with `archi` and `Vector3` (from three.js) in
scope:

| | |
| --- | --- |
| `await archi.command(name, ...answers)` | Runs a command with its answers in order (`''` is Enter; when they run out, Enter until it ends). Resolves to the ids it left selected (what it made); a command error stops the script. |
| `archi.add(geometry, layer?)` | Adds geometry (a curve, mesh or point, as in [the file format](archi-format.md)) to a layer by name (made if missing), as one undo step. Returns its id. |
| `archi.remove(ids)` | Deletes objects, as one undo step. |
| `archi.objects(filter?)` | The objects: `id`, `type`, `layer`, and the `command` and `params` of those made with history. |
| `archi.select(ids)` | Selects objects, for commands that act on the selection. |
| `archi.levels()`, `archi.setLevel(name)` | The levels (`name`, `elevation`, `height`), and the current one: points typed in commands are measured from its floor. |
| `await archi.setParams(id, params)` | Changes the parameters of an object made with history (a wall's `openings`, `thickness` or `height`, a slab's `thickness`, ...); it is made again, as from Properties. |
| `await archi.step(edits)` | Several edits as one undo step. |
| `archi.param(name, value, { min, max, step })` | A parameter, with a slider when run with `Parametric`; otherwise its value. |
| `archi.v(x, y, z)` | A point. |
| `archi.log(...values)` | A line in the command history. |
| `archi.apiVersion` | The version of this API. |
| `archi.doc` | The document itself. Advanced: it is the app's own model and is not covered by the compatibility promise. |

Examples are in [examples/scripts](../examples/scripts). Scripts have the same access as the
application: run only those you trust.

## The AI assistant (MCP)

The MCP server in [mcp](../mcp) gives an assistant these tools; see [mcp/README.md](../mcp/README.md)
to set it up.

| Tool | What it does |
| --- | --- |
| `get_model` | Units, levels, layers with object counts, objects counted by kind, and the selection. |
| `list_commands` | The command names, optionally only those containing some text. |
| `list_objects` | Objects with id, type, layer, history parameters and bounds; filtered by layer, command or type. |
| `run_command` | Runs a macro (a command and its answers). |
| `run_script` | Runs a script, as above. |
| `view` | An image of a view, in a display mode. |
| `export` | Writes the model to a file on this computer: `archi`, `ifc`, `pdf`, `dxf`, `glb` or quantities as `csv`. |
| `open_model`, `new_model` | Opens a file or starts an empty model (refused with unsaved changes unless told to discard them). |
| `set_params` | Changes the parameters of an object made with history. |
| `delete_objects` | Deletes objects by id, as one undo step. |
| `undo` | Undoes the last steps. |
