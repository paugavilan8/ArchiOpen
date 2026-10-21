# The .archi file format

`.archi` is ArchiOpen's own file: the whole model as one JSON document, in UTF-8. It is meant to be
kept for years, so it follows a few rules.

## Compatibility

- **Every .archi file opens in every later version of ArchiOpen.** Each file says which version of
  the format it is written in (`version`); when the format changes, the new version comes with a
  step that brings files of the previous one up to date as they are read. Files from before the
  format had a version are version 1.
- **A file from a newer ArchiOpen opens as far as this one understands it.** Objects of a kind it
  does not know are left out, and it says so. The file itself is not changed unless it is saved
  again (and then what was left out is not in the copy).
- A file saved by each version of the format is kept in the tests
  (`src/core/fixtures/archi-format-<version>.archi.gz.b64`) and must always open with everything in
  it.

## Layout

```json
{
  "format": "ArchiOpen",
  "version": 1,
  "app": "0.9.0",
  "units": "Millimeters",
  "layers": [{ "id": 1, "name": "Walls", "color": "#000000", "visible": true, "locked": false }],
  "currentLayerId": 1,
  "blocks": [{ "name": "Column", "objects": [{ "layerId": 1, "geometry": { } }] }],
  "objects": [{ "id": 1, "layerId": 1, "geometry": { } }],
  "levels": [{ "name": "Level 0", "elevation": 0, "height": 2800 }],
  "currentLevel": "Level 0",
  "layouts": [],
  "namedViews": [],
  "namedCPlanes": [],
  "materials": [],
  "renderSettings": { }
}
```

| Key | What it holds |
| --- | --- |
| `format` | Always `"ArchiOpen"` (files from before 0.9 do not have it). |
| `version` | The version of the format. |
| `app` | The version of ArchiOpen that saved it (for information only). |
| `units` | The model's units: `Millimeters`, `Centimeters`, `Meters`, `Inches`, `Feet`, ... |
| `layers` | Layers with their color, visibility, lock, linetype, print width and material. |
| `blocks` | Block definitions; a linked file's block also has `link: { source, fileName }`. |
| `objects` | The model's objects: `id`, `layerId`, the `geometry`, and optionally `groups`, `hidden`, `locked`, `material` and `history` (what made it, so building elements such as walls can be made again when their inputs change). |
| `levels`, `currentLevel` | The building's floors. |
| `layouts` | Drawing sheets with their details and title blocks. |
| `namedViews`, `namedCPlanes` | Saved views and construction planes. |
| `materials`, `renderSettings` | Materials and the sun, environment and ground for rendering. |

Points are `[x, y, z]` arrays. Each `geometry` has a `type`:

| `type` | Fields |
| --- | --- |
| `polyline` | `points`, `closed` |
| `circle` | `center`, `xaxis`, `yaxis` (unit vectors of its plane), `radius` |
| `arc` | as a circle, and `angle` (radians, from `xaxis` toward `yaxis`) |
| `curve` | NURBS curve: `degree`, `points`, `knots` (full knot vector), optional `weights` |
| `polycurve` | `segments`, each a curve geometry |
| `point` | `point` |
| `mesh` | `vertices` (flat x, y, z list) and `faces` (four indices each; a triangle repeats its third) |
| `brep` | Surface or solid: `brep` (OpenCASCADE BRep text), `kind` (`surface`, `polysurface` or `solid`), `matrix`, and a display mesh |
| `annotation` | Text, dimension or leader: `kind`, `points`, `xaxis`, `yaxis`, `text`, `height`, `arrow`, `precision` |
| `hatch` | `loops` (closed curves), `pattern`, `scale`, `rotation`, `origin`, `xaxis`, `yaxis` |
| `instance` | A block placed: `block` (its name) and `matrix` (4 × 4, column by column) |
| `clipping` | Clipping plane: `center`, `xaxis`, `yaxis`, `width`, `height`, `views` |
