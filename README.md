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
- Dibujo: `Line`, `Polyline`, `Rectangle`, `Circle`, `Arc`, `Curve`.
- Transformación: `Move`, `Copy`, `Rotate`, `Scale`, `Mirror`, `Array`, `ArrayPolar`.
- Edición de curvas: `Trim`, `Split`, `Join`, `Explode`, `Offset`, `Fillet` (entre dos líneas),
  `FilletCorners` (todas las esquinas de una polilínea).
- Superficies y sólidos (núcleo [Open CASCADE](https://dev.opencascade.org) a través de
  [replicad](https://replicad.xyz), cargado la primera vez que se usa):
  `Box`, `Cylinder`, `Sphere`, `ExtrudeCrv` (con opción `Solid` para tapar curvas cerradas
  planas), `Revolve`, `Loft`, `PlanarSrf`, `BooleanUnion`, `BooleanDifference`,
  `BooleanIntersection` y `FilletEdge` (elige aristas con clic). Se ven sombreados en Perspective
  (cambia Wireframe/Shaded desde el menú de cada vista) y se mueven, giran, escalan y copian como
  cualquier objeto. Alias: `EXT`, `REV`, `BU`, `BD`, `BI`, `FE`.
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

## Licencia

Por decidir.
