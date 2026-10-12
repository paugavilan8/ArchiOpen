# Primeros pasos con ArchiOpen

[English](getting-started.md) · **Español**

Esta guía va desde instalar ArchiOpen hasta un pequeño edificio con sus planos, en unos veinte
minutos. Todos los comandos que aparecen se pueden escribir en la línea de comandos o buscar en los
menús.

## 1. Instalar y abrir

Descarga el instalador para tu sistema en la página de
[Releases](https://github.com/paugavilan8/ArchiOpen/releases) y ejecútalo. Al abrirlo verás cuatro
vistas (Top, Perspective, Front, Right), la línea de comandos arriba, barras de herramientas a la
izquierda y los paneles Properties, Layers, Materials, Blocks y Views a la derecha.

Para ver enseguida lo que hace, elige **Help > Open Example House** (el comando `Example`): crea una
casa de dos plantas con muros, puertas y ventanas, una escalera, una cubierta y estancias rotuladas.

## 2. La línea de comandos

ArchiOpen funciona como otros modeladores NURBS profesionales: empiezas un comando y te va pidiendo
lo que necesita.

- Escribe el nombre de un comando (`Line`, `Box`, `Wall`) y pulsa Intro. Mientras escribes se
  sugieren los nombres que coinciden.
- Lee el mensaje: dice qué hay que dar a continuación. Las opciones aparecen como `Nombre=Valor`;
  haz clic en una o escribe su nombre.
- Los puntos se dan con clic o escribiéndolos: `100,50` (en el plano de construcción), `100,50,30`,
  `r200,0` o `@200,0` (relativos al último punto), `w100,50,30` (coordenadas universales). Un solo
  número mientras se dibuja desde un punto fija la distancia; después se hace clic para la dirección.
- Intro, Espacio o clic derecho terminan un comando, o repiten el último si no hay ninguno en marcha.
  Escape lo cancela.

## 3. Moverse por el modelo

- Arrastrar con el botón derecho: orbitar (en Perspective) o desplazar. Mayúsculas + botón derecho,
  o botón central: desplazar. Rueda: zoom.
- `Zoom` > `Extents` encuadra el modelo; doble clic en el título de una vista la maximiza.
- `SetDisplayMode`: `Wireframe`, `Shaded`, `Rendered`, `Ghosted`, `XRay`.

## 4. Dibujar con precisión

- Referencias a objetos (barra de estado, F3): End, Mid, Cen, Int, Perp, Tan y más.
- Ortho (F8) mantiene los ángulos rectos; Grid Snap (F9) ajusta a la rejilla.
- El gumball (activo por defecto) mueve, gira y escala la selección arrastrando sus tiradores; haz
  clic en un tirador y escribe un valor para un movimiento exacto.

## 5. Un pequeño edificio

1. **Niveles.** `Level` > `New` añade una planta (nombre, cota y altura). Los puntos escritos se
   miden desde el suelo del nivel actual.
2. **Muros.** `Wall`: haz clic o escribe las esquinas; `Close` cierra el anillo. Las opciones fijan
   el grosor, la altura y la alineación. Cada muro tiene su línea en la capa Construction: si editas
   la línea, o los parámetros del muro en Properties, el muro se vuelve a generar.
3. **Puertas y ventanas.** `Door` y `Window`: haz clic en el muro donde va el hueco. Las medidas y
   la altura del alféizar están en Properties.
4. **Forjados y escaleras.** `Slab` por su contorno; `Stair` desde el primer peldaño hasta el
   último, y corta el hueco en el forjado de encima.
5. **Cubierta.** `Roof` sobre un contorno: a cuatro aguas, a dos aguas o a un agua, con pendiente,
   vuelo y grosor.
6. **Estancias.** `Room`: haz clic dentro de una estancia y ponle nombre; su superficie se calcula a
   partir de los muros.

## 6. Planos y tablas

- `DrawingSet` genera las plantas de cada nivel, alzados y secciones, colocados en láminas con
  cajetín, cotas y marcas de nivel. `UpdateDrawings` los actualiza tras los cambios.
- `Schedule` dibuja la tabla de puertas y ventanas, la de estancias o las mediciones; `Tags` marca
  cada hueco en planta.
- `ExportPDF` imprime las láminas; `ExportDXF` las escribe para CAD.

## 7. Modelado libre

Las herramientas NURBS conviven con los elementos constructivos:

- Curvas: `Curve`, `InterpCrv`, `Arc`, `Ellipse`, `Offset`, `Fillet`, `BlendCrv`, `CurveBoolean`.
- Superficies: `Loft`, `Sweep1`, `Sweep2`, `NetworkSrf`, `Patch`, `ExtendSrf`, `MatchSrf`.
- Sólidos: `Box`, `Cylinder`, `Cone`, `Torus`, `ExtrudeCrv`, `BooleanUnion` y las demás booleanas,
  `FilletEdge`, `Shell`.
- Cambios: `Scale1D`, `Twist`, `Taper`, `Bend`, `Flow`, `ArrayCrv`.

Con **Record History** activado (barra de estado), las superficies hechas a partir de curvas siguen
a las curvas cuando las editas.

## 8. Render

Asigna materiales a capas u objetos en el panel Materials, coloca el sol con `Sun` y pon la vista en
`Rendered`. `Render` guarda una imagen de hasta 4K.

## 9. Archivos

- `Save` guarda el archivo propio `.archi`. `Autosave` guarda copias en una carpeta.
- `Open` e `Import` leen `.3dm` (Rhino), `.ifc`, `.dxf`, `.step`, `.stl` y `.obj`; también `.dwg` en la
  aplicación de escritorio, con el ODA File Converter (gratuito) instalado.
- `Export` escribe `.3dm` con superficies exactas; además `ExportIFC`, `ExportSTEP`, `ExportGLTF`,
  `ExportSTL`, `ExportOBJ`.

## 10. Para seguir

- **Scripts:** `RunScript` ejecuta JavaScript que maneja el modelador (`archi.command(...)`); mira
  `examples/scripts`, incluida la casa de ejemplo. `Parametric` convierte los parámetros de un script
  en deslizadores.
- **Asistente de IA:** con `McpConnect`, Claude u otro cliente MCP puede modelar en la aplicación;
  ver [mcp/README.md](../mcp/README.md).
- **Help > Command List** muestra todos los comandos.
