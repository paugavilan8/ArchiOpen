# Getting started with ArchiOpen

**English** · [Español](getting-started.es.md)

This guide takes you from installing ArchiOpen to a small building with its drawings, in about
twenty minutes. Every command named here can be typed at the command line or found in the menus.

## 1. Install and open

Download the installer for your system from the
[Releases](https://github.com/paugavilan8/ArchiOpen/releases) page and run it. On first start the
window shows four views (Top, Perspective, Front, Right), the command line at the top, toolbars on
the left and the Properties, Layers, Materials, Blocks and Views panels on the right.

To see what it can do straight away, choose **Help > Open Example House** (the `Example` command):
it makes a two-storey house with walls, doors and windows, a stair, a roof and labelled rooms.

## 2. The command line

ArchiOpen works like other professional NURBS modelers: you start a command, and it asks for what it
needs.

- Type a command name (`Line`, `Box`, `Wall`) and press Enter. Matching names are suggested as you
  type.
- Read the prompt: it says what to give next. Options appear in it as `Name=Value`; click one, or
  type its name.
- Give points by clicking, or type them: `100,50` (on the construction plane), `100,50,30`, `r200,0`
  or `@200,0` (relative to the last point), `w100,50,30` (world coordinates). A single number while
  drawing from a point fixes the distance; then click for the direction.
- Enter, Space or a right click ends a command, or repeats the last one when none is running.
  Escape cancels.

## 3. Moving around

- Right drag: orbit (in Perspective) or pan. Shift+right drag or middle drag: pan. Wheel: zoom.
- `Zoom` > `Extents` fits the model; double-click a view's title to maximize it.
- `SetDisplayMode`: `Wireframe`, `Shaded`, `Rendered`, `Ghosted`, `XRay`.

## 4. Drawing precisely

- Object snaps (status bar, F3): End, Mid, Cen, Int, Perp, Tan and more.
- Ortho (F8) keeps lines at right angles; Grid Snap (F9) snaps to the grid.
- The gumball (on by default) moves, rotates and scales the selection by dragging its handles; click
  a handle and type a value for an exact move.

## 5. A small building

1. **Levels.** `Level` > `New` adds a floor (name, elevation, height). The current level's floor is
   where typed points start.
2. **Walls.** `Wall`: click or type the corners; `Close` ends a ring. Options set the thickness,
   height and justification. Each wall has its line on the Construction layer: edit the line, or
   the wall's parameters in Properties, and the wall is made again.
3. **Doors and windows.** `Door` and `Window`: click a wall where the opening goes. Sizes and sill
   heights are in Properties.
4. **Floors and stairs.** `Slab` by its outline; `Stair` from its bottom step to its top, which cuts
   the opening in the slab above.
5. **Roof.** `Roof` over an outline: hip, gable or shed, with pitch, overhang and thickness.
6. **Rooms.** `Room`: click inside a room and name it; its floor area is worked out from the walls.

## 6. Drawings and schedules

- `DrawingSet` makes plans of every level, elevations and sections, laid out on sheets with title
  blocks, dimensions and level marks. `UpdateDrawings` brings them up to date after changes.
- `Schedule` draws the doors and windows table, the rooms table or quantities; `Tags` marks each
  opening in plan.
- `ExportPDF` prints the sheets; `ExportDXF` writes them for CAD.

## 7. Free-form modeling

The NURBS tools work alongside the building elements:

- Curves: `Curve`, `InterpCrv`, `Arc`, `Ellipse`, `Offset`, `Fillet`, `BlendCrv`, `CurveBoolean`.
- Surfaces: `Loft`, `Sweep1`, `Sweep2`, `NetworkSrf`, `Patch`, `ExtendSrf`, `MatchSrf`.
- Solids: `Box`, `Cylinder`, `Cone`, `Torus`, `ExtrudeCrv`, `BooleanUnion` and the other Booleans,
  `FilletEdge`, `Shell`.
- Changes: `Scale1D`, `Twist`, `Taper`, `Bend`, `Flow`, `ArrayCrv`.

With **Record History** on (status bar), surfaces made from curves follow the curves when you edit
them.

## 8. Rendering

Give layers or objects materials in the Materials panel, set the sun with `Sun`, and switch the view
to `Rendered`. `Render` saves an image of up to 4K.

## 9. Files

- `Save` writes the native `.archi` file. `Autosave` keeps copies in a folder.
- `Open` and `Import` read `.3dm` (Rhino), `.ifc`, `.dxf`, `.step`, `.stl` and `.obj`; `.dwg` too in the
  desktop app, with the free ODA File Converter installed.
- `Export` writes `.3dm` with exact surfaces; also `ExportIFC`, `ExportSTEP`, `ExportGLTF`,
  `ExportSTL`, `ExportOBJ`.

## 10. Going further

- **Scripts:** `RunScript` runs JavaScript that drives the modeler (`archi.command(...)`); see
  `examples/scripts`, including the example house. `Parametric` turns a script's parameters into
  sliders.
- **AI assistant:** with `McpConnect`, Claude or another MCP client can model in the app; see
  [mcp/README.md](../mcp/README.md).
- **Help > Command List** lists every command.
