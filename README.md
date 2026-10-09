# ArchiOpen

Modelador NURBS de código abierto para proyectos de arquitectura, con un flujo de trabajo basado en
línea de comandos: escribes el nombre de un comando (o lo eliges en un menú o una barra de
herramientas) y el programa te va pidiendo puntos, opciones o distancias.

Es una aplicación de escritorio para Windows, macOS y Linux. La interfaz está hecha con
TypeScript y Three.js, y se empaqueta como aplicación nativa con [Tauri](https://tauri.app).

## Descargar

Los instaladores se generan en GitHub Actions:

1. Ve a la pestaña **Actions** del repositorio y abre el flujo **Desktop app**.
2. Pulsa **Run workflow** (o abre la última ejecución terminada).
3. Al acabar, descarga el artefacto de tu sistema, por ejemplo `ArchiOpen-Windows`, que contiene
   el instalador `.msi` y el `.exe`.

Al publicar una etiqueta de versión (`git tag v0.1.0 && git push --tags`) los instaladores también
se adjuntan a un borrador de *release*.

## Qué hace ahora

- Cuatro vistas (Top, Front, Right, Perspective) con rejilla, gizmo de ejes y menú por vista.
- Órbita (botón derecho en Perspective), encuadre (Shift + botón derecho o botón central) y zoom
  con la rueda.
- Dibujo: `Line`, `Polyline`, `Rectangle`, `Circle`, `Arc`, `Curve` (por puntos de control),
  `InterpCrv` (curva que pasa por los puntos), `Ellipse` (exacta, como curva racional), `Polygon`
  (inscrito o circunscrito, con `NumSides`) y `Helix` (con `Turns`). Las curvas NURBS racionales
  (elipses, cónicas) se leen y escriben exactas en `.3dm`, DXF y el núcleo.
- Transformación: `Move`, `Copy`, `Rotate`, `Scale`, `Mirror`, `Array`, `ArrayPolar`.
- Edición de curvas: `Trim`, `Split`, `Join`, `Explode`, `Offset`, `Fillet` (entre dos líneas),
  `FilletCorners` (todas las esquinas de una polilínea), `Chamfer` (chaflán entre dos líneas con dos
  distancias), `Extend` (alarga curvas hasta otras: rectas en línea recta, arcos siguiendo su
  círculo), `BlendCrv` (curva de transición entre dos extremos con continuidad de posición,
  tangencia o curvatura) y `Rebuild` (rehace una curva con los puntos de control y el grado que
  se pidan, e indica cuánto se separa de la original).
- Superficies y sólidos (núcleo [Open CASCADE](https://dev.opencascade.org) a través de
  [replicad](https://replicad.xyz), cargado la primera vez que se usa):
  `Box`, `Cylinder`, `Sphere`, `ExtrudeCrv` (con opción `Solid` para tapar curvas cerradas
  planas), `Revolve`, `Loft`, `PlanarSrf`, `BooleanUnion`, `BooleanDifference`,
  `BooleanIntersection`, `FilletEdge` (elige aristas con clic), `Sweep1` (perfil a lo largo de
  un carril), `Shell` (vaciar un sólido dejando abiertas las caras elegidas), `Section` (curvas de
  corte por un plano vertical dibujado con dos puntos) y `Contour` (cortes a intervalos, p. ej.
  plantas por niveles). `Explode` separa una polisuperficie en caras y `Join` las une de nuevo. Se ven sombreados en Perspective
  (cambia Wireframe/Shaded desde el menú de cada vista) y se mueven, giran, escalan y copian como
  cualquier objeto. Alias: `EXT`, `REV`, `BU`, `BD`, `BI`, `FE`, `SW`.
- Edición de superficies:
  - `Split` y `Trim` también parten y recortan superficies, polisuperficies y sólidos, con curvas
    (que cortan tal como se ven en la vista: una curva dibujada en planta corta todo lo que tiene
    debajo) o con otras superficies y sólidos. En `Trim` se hace clic en la parte que sobra (mejor
    en una vista sombreada). Los sólidos se parten en sólidos.
  - `Cap` tapa los agujeros planos de una polisuperficie abierta y, si queda cerrada, la convierte
    en sólido; `ExtrudeSrf` extruye una superficie en un sólido; `OffsetSrf` desfasa superficies a
    una distancia (opción `Solid` para darles espesor); `ExtractSrf` separa caras elegidas con clic.
  - Curvas sobre superficies: `Project` (a lo largo de la normal del plano de construcción, sobre
    todas las caras donde caen), `Pull` (al punto más cercano), `Intersect` (curvas donde se cortan
    superficies y sólidos), `DupBorder` (bordes abiertos) y `DupEdge` (aristas elegidas).
- Planos 2D: `Make2D` dibuja la selección vista desde una dirección, con eliminación de líneas
  ocultas, como curvas planas en el plano XY (alzados, plantas y axonometrías). Opciones: `View`
  (la vista activa, `Top`, `Front`, `Right`, `Back`, `Left` o `FourView`, que coloca alzado, planta,
  perfil y axonometría en el sistema americano) y `HiddenLines` (dibuja también las ocultas). Las
  líneas visibles van a la capa *Make2D Visible* y las ocultas a *Make2D Hidden*. Las vistas en
  perspectiva se dibujan como proyección paralela.
- Textos y cotas, dibujados como líneas con una tipografía técnica de un solo trazo (Hershey, con
  acentos, ñ, ¿¡, Ø, ±, ° y ²): `Text`, `Dim` (cota horizontal o vertical según hacia dónde se
  arrastre), `DimAligned`, `DimRadius`, `DimDiameter`, `DimAngle` (eligiendo dos líneas o con la
  opción `Points`) y `Leader` (directriz con texto). Opciones `Height` (altura del texto) y
  `Arrow` (flecha o trazo oblicuo de arquitectura). Las cotas se actualizan solas al mover,
  escalar o editar sus puntos (`PointsOn`). En el panel de propiedades se cambian el texto (`<>`
  es el valor medido, p. ej. `L = <> m`), la altura, las flechas y los decimales. `Explode` las
  convierte en líneas; al exportar a `.3dm` o STEP van como líneas.
- Sombreados: `Hatch` (alias `H`) rellena el interior de curvas cerradas planas (las curvas
  dentro de otras son huecos) con un relleno sólido o un patrón: `Lines`, `Cross`, `Grid`, `Brick`
  y `Dashes`, con opciones `Pattern`, `Scale` y `Rotation` (también editables en el panel de
  propiedades).
- Tipos de línea y grosores por capa (en el panel de capas): `Continuous`, `Dashed`, `Hidden`,
  `Center`, `DashDot` y `Dots`, y plumillas de 0,13 a 1 mm. `Make2D` pone las ocultas en
  discontinua.
- Planos: `ExportPDF` (alias `Print`) imprime la vista activa a PDF vectorial con opciones
  `Paper` (A4 a A0, Letter, Tabloid), `Orientation`, `Scale` (p. ej. 1:50, o ajustar al papel),
  `Area` (todo o lo que se ve en la vista) y `Color` (de pantalla o todo en negro). Usa los
  grosores y tipos de línea de cada capa. `ExportDXF` escribe la selección (o todo lo visible) en
  DXF R12, que leen AutoCAD, LibreCAD, Illustrator y casi cualquier programa de CAD: capas con su
  color, tipo de línea y unidades; líneas, polilíneas, círculos y arcos exactos; el resto como
  polilíneas y los sombreados sólidos como relleno.
- Láminas (layouts): `Layout` crea una lámina (A3 apaisado, con una vista en planta ajustada a
  escala y un cajetín) y las pestañas de abajo (*Model*, cada lámina y *+*) cambian entre el modelo
  y las láminas (doble clic en una pestaña para renombrarla). En la lámina:
  - las vistas de detalle se mueven arrastrando, se redimensionan por las esquinas y con Mayús +
    arrastrar se desplaza el modelo dentro; la rueda acerca la lámina;
  - cada detalle tiene vista (planta, alzados, isométricas o la perspectiva actual), escala (1:1 a
    1:10000), modo de dibujo (alámbrico o con líneas ocultas eliminadas, calculadas con el núcleo)
    y un título que se rotula debajo con su escala;
  - el cajetín muestra proyecto, plano, número, autor, fecha, escala y número de hoja (1/3…);
  - el papel y la orientación se cambian en el panel y los detalles se recolocan;
  - `ExportPDF` con una lámina abierta imprime esa lámina o todas (opción `Sheets`) en un PDF de
    varias páginas, con los grosores y tipos de línea de cada capa.
- Abrir e importar DXF (ASCII, de R12 a 2018): `Open` abre un `.dxf` como modelo nuevo e `Import`
  lo añade al actual, convertido a sus unidades. Se leen:
  - las capas con su color (también color verdadero), tipo de línea, grosor, apagadas y
    bloqueadas, y las unidades (`$INSUNITS`; sin unidades se toman milímetros o las del modelo);
  - líneas, polilíneas con arcos, círculos y arcos (también en planos inclinados), elipses,
    splines, caras 3D y `SOLID`;
  - textos y textos de varias líneas (sin formato, con `%%c`, `%%d`, `%%p` y acentos);
  - cotas lineales, alineadas, de radio, diámetro y ángulo, que se convierten en cotas de
    ArchiOpen que siguen midiendo;
  - directrices, sombreados (con huecos; los patrones de AutoCAD se aproximan con los de
    ArchiOpen) y bloques, que siguen siendo bloques (con escala, giro, matrices y bloques
    anidados).
  - Puntos, multilíneas, multidirectrices, sólidos ACIS, imágenes y tablas aún no se cargan y se
    avisa de cuántos hay. Los DXF binarios y los DWG no se leen: guárdalos como DXF ASCII desde
    el programa de origen (o conviértelos con ODA File Converter, gratuito).
- Bloques: `Block` (alias `B`) convierte la selección en un bloque con nombre y punto base;
  `Insert` (alias `I`) coloca copias con escala y giro (en el plano de construcción de la vista);
  `BlockEdit` edita un bloque en su sitio (el resto del modelo se atenúa y no se puede tocar) y al
  terminar (`BlockEditFinish` o el botón *Finish*) se actualizan todas sus copias, también las que
  están dentro de otros bloques; `BlockEditCancel` lo deja como estaba. `Explode` descompone una
  copia en sus objetos y `Purge` borra los bloques sin usar. La pestaña *Blocks* lista los bloques
  con una miniatura y el número de copias, y permite insertar, seleccionar sus copias, renombrar
  (doble clic) y borrar. Se guardan en el `.archi`, se exportan al DXF como bloques e `INSERT`, y
  al abrir o importar un DXF sus bloques se mantienen como bloques (pasados a las unidades del
  modelo; si el nombre ya existe se numera). En `.3dm` y STEP se exportan descompuestos.
- Grupos: `Group` (alias `G`), `Ungroup` (`UG`), `AddToGroup` y `RemoveFromGroup`. Al hacer clic
  en un objeto agrupado se selecciona el grupo entero, y las copias de un grupo forman su propio
  grupo.
- Otros: `PointsOn`, `PointsOff`, `Delete`, `SelAll`, `SelNone`, `Undo`, `Redo`, `Zoom`, `MaxViewport`, `Snap`, `Ortho`,
  `Osnap`, `Units`, `New`, `Open`, `Save`, `SaveAs`, `Import`, `Export`, `ImportSTEP`,
  `ExportSTEP`.
- Alias: `M`, `RO`, `SC`, `MI`, `AR`, `AP`, `TR`, `J`, `X`, `OF`, `F`, `REC`, `A`, `U`, `Z`, `ZE`,
  `ZEA`, `ZS`, `EXT`, `REV`, `BU`, `BD`, `BI`, `FE`.
- Coordenadas escritas: absolutas `x,y,z`, relativas `r dx,dy`, y longitud fija escribiendo un
  número antes de hacer clic.
- Selección por clic, ventana (izquierda a derecha) y captura (derecha a izquierda).
- Gumball sobre la selección: flechas para mover, arcos para girar (Mayús: pasos de 15°), cajas
  para escalar en un eje (Mayús: uniforme) y centro para mover en el plano. Un clic en una
  flecha, arco o caja sin arrastrar pide el valor exacto.
- Arrastrar un objeto o un punto de control seleccionado lo mueve (con referencias a objetos).
- Puntos de control: `PointsOn` (F10) y `PointsOff` (F11) en polilíneas y curvas; se seleccionan,
  arrastran, mueven con el gumball o se borran con Supr.
- Referencias a objetos: End, Near, Mid, Cen, Quad. Ortho (F8), forzado a rejilla (F9).
- Capas con color, visibilidad y bloqueo; panel de propiedades del objeto seleccionado.
- Archivos `.archi` (JSON) con Abrir/Guardar; la sesión se recupera sola si la app se cierra.
- Archivos de Rhino `.3dm` (con [rhino3dm](https://github.com/mcneel/rhino3dm), MIT):
  - `Open` abre `.archi` o `.3dm`. De un `.3dm` se cargan las curvas (líneas, polilíneas, arcos,
    círculos, NURBS y polycurves), las polisuperficies, superficies y extrusiones (reconstruidas
    como geometría exacta y editable: sólidos cerrados, caras recortadas y agujeros), las capas
    con su color, visibilidad y bloqueo, y las unidades. Las mallas, SubD, textos y bloques aún no
    se cargan y se avisa de cuántos hay.
  - `Save` nunca sobrescribe un `.3dm` abierto (podría perder lo que no se cargó): guarda un `.archi`.
  - `Export` escribe un `.3dm` con las curvas, las capas (también las anidadas) y las unidades.
    Las superficies y sólidos se exportan como mallas.
  - `Import` añade un `.3dm` al modelo actual, escalándolo a sus unidades.
  - `Units` cambia las unidades del modelo (sin escalar la geometría).
- Archivos STEP (`.step`, `.stp`, AP242), el formato que leen casi todos los programas de CAD:
  - `ExportSTEP` escribe la selección (o todo lo visible) con geometría exacta: sólidos y
    superficies como B-rep y curvas como curvas, con el nombre y el color de su capa y las
    unidades del modelo.
  - `ImportSTEP` añade los sólidos, superficies y curvas de un STEP a la capa actual, convertidos
    a las unidades del modelo. Líneas, círculos y arcos llegan exactos; otras curvas, ajustadas.

## Desarrollo

Requisitos: Node 22 y, para la app de escritorio, Rust y las
[dependencias de Tauri](https://tauri.app/start/prerequisites/) de tu sistema.

```sh
npm install
npm run dev        # interfaz en el navegador, http://localhost:5173
npm run app:dev    # aplicación de escritorio con recarga en caliente
npm run app:build  # instaladores en src-tauri/target/release/bundle
npm run typecheck
npm test           # pruebas de la geometría
```

## Créditos

- El archivo de prueba `src/io/fixtures/ezdxf-sample.dxf` está generado con
  [ezdxf](https://github.com/mozman/ezdxf) (MIT).

- Tipografía de los textos: fuentes Hershey (A. V. Hershey, U.S. National Bureau of Standards), en
  la conversión de [hersheytext](https://github.com/techninja/hersheytextjs) (MIT).

## Licencia

Por decidir.
