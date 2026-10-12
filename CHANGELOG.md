# Changelog

What changed in each version of ArchiOpen. Installers for every version are on the
[Releases](https://github.com/paugavilan8/ArchiOpen/releases) page.

## 0.7.0

An AI assistant through MCP, and parametric scripts.

- Scripts: `archi.setLevel` moves the construction planes to the level's floor, as `Level` > `Current`
  does, so points typed in commands are measured from it; the tower example now stacks its floors
  exactly.
- **Parametric scripts** (`Parametric`, `archi.param`): sliders for a script's parameters that make
  its result again as they move, with a twisting tower example. Scripts' `archi.step` now takes in
  the commands run inside it as one undo step.
- **AI assistant (MCP)**: an MCP server (`mcp/`) and `McpConnect` let Claude or another MCP client
  model in the app: describe the model, run commands and scripts, change parameters, capture
  views, open, save and export files, and undo. Ready to publish on npm as `archiopen-mcp`.

## 0.6.0

Stairwells, quantities, terrain, wall layers, curtain walls and scripts.

- **Scripts** (`RunScript`): JavaScript files that run commands, read and add geometry through the
  `archi` API, with examples in `examples/scripts`.
- **Curtain walls** (`CurtainWall`): mullions, transoms and glass along a line, following it.
- **Wall layers** (`WallType`, `Wall` > `Type`): build-ups of brick, insulation, concrete, plaster or
  timber, drawn layer by layer in plans and sections and measured by material.
- **Terrain** (`Terrain`): the ground through contour lines and survey points, cut to a boundary and
  with a base so that it is a solid.
- **Quantities**: lengths, areas and volumes of the building's elements by level and material, as a
  table (`Schedule` > `Quantities`) or a CSV file (`ExportQuantities`).
- **Stairwells**: stairs cut their opening through the slab above (`Opening` option and
  `StairOpening`), and are made again when their level's height changes.

## 0.5.0

Drawing sets, schedules, IFC and autosave.

- **IFC** (IFC4): `ExportIFC` writes the building with its storeys, elements, doors, windows and
  spaces for BIM tools; `Open` and `Import` read IFC files as meshes by class, with storeys as levels.
- **Heights on elevations and sections**: level marks at each level and the top, and chains of
  height dimensions through the openings seen and from level to level.
- **Schedules** (`Schedule`): the doors and windows table, by type, and the rooms table with floor
  areas by level, made again by `UpdateDrawings` and placed on their own sheet by `DrawingSet`.
- **Autosave to a folder** (`Autosave`, desktop app): copies of the model every few minutes while
  it has unsaved changes, the newest of each kept, and `Recover` to open one.
- **Drawing set** (`DrawingSet`): a plan of each level, the elevations and the sections laid out on
  A3 sheets in one go, each with its title block and the largest standard scale that fits. Each
  plan is cut above its level's floor and leaves out the levels under it.
- Layout details can be cut by chosen clipping planes only, and section marks are drawn whole on
  every plan.
- **Update drawings** (`UpdateDrawings`): elevations and sections are drawn again from the model,
  each in its place, so the sheets show the changes.
- Clipping planes are no longer drawn on sheets.
- Releases are published by themselves when a version bump is merged.

## 0.4.0

Interiors and a full set of drawings.

- **Floor finishes** (`Floor`) in wood, tiles, marble or concrete, and **skirting** (`Skirting`)
  round rooms, along the walls and round columns, broken at doors.
- **Furniture and fittings** (`Furniture`): beds, sofa, armchair, dining table, chair, desk,
  wardrobe, kitchen counter, fridge, WC, washbasin, bathtub and shower tray, placed as blocks.
- **Elevations and sections** (`Elevations`, `Section`): the four elevations of the building and
  sections along a line drawn in plan, with cut elements filled, ground lines, titles and section
  marks in plan.
- Releases now check that their tag matches the project version. (The 0.3.0 installers were built
  before its version bump and are named 0.2.0.)

## 0.3.0

Plans that read like architectural drawings.

- **Wall dimensions** (`WallDimensions`): chains along the outside faces of the outside walls, from
  corner to corner through the edges of the openings, and the overall length further out.
- **Room labels** (`Room`): click inside a room to get its outline and a label with its name and
  floor area, worked out between the walls and around columns.
- **Door swings and window symbols in plan**: doors drawn open with the arc they sweep, windows
  with their frame and glass, kept in line with their walls. Doors open to the side of the wall
  they are placed on; the Properties panel turns them round or hangs them on the other side.

## 0.2.0

Building elements, and easier downloads.

- **Walls**, **slabs**, **windows** and **doors** on **levels**, made from lines that stay editable,
  with their parameters in the Properties panel.
- Window and door **frames**, glass and leaves, with their own materials.
- **Wall joins**: mitred L corners and T junctions, kept up to date.
- **Roofs**: hip, gable and shed, over convex plans and over L, T and U plans; walls rise to the
  roof over them.
- **Stairs**, straight or with landings (L and U), **columns** and **railings** on stairs and slab
  edges.
- Surface tools: `FilletSrf`, `MatchSrf`, `Untrim` and `RailRevolve`; a clay default material in
  the Rendered view.
- Installers are published as GitHub releases, downloadable without an account.

## 0.1.0

First version: NURBS curves, surfaces and solids on the Open CASCADE kernel, Rhino-style commands
and interface, drawings and layouts, rendering, and Rhino `.3dm`, STEP, DXF, STL and OBJ files.
