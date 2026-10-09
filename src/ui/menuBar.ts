import type { CommandContext, CommandRunner } from '../commands/runner'
import { closeMenu, isMenuOpen, menuAnchor, MenuEntry, openMenu } from './menu'

const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'

/** The application menu bar. Every item runs a command macro, so menus, toolbars and typing stay in sync. */
export function buildMenuBar(container: HTMLElement, runner: CommandRunner, ctx: CommandContext): void {
  const { display, settings, log } = ctx
  const run = (macro: string) => () => void runner.run(macro)
  const item = (label: string, macro: string, shortcut?: string): MenuEntry => ({ label, shortcut, action: run(macro) })

  const menus: [string, MenuEntry[]][] = [
    [
      'File',
      [
        item('New', 'New', `${mod}N`),
        item('Open (.archi, .3dm, .dxf)…', 'Open', `${mod}O`),
        'separator',
        item('Save', 'Save', `${mod}S`),
        item('Save As…', 'SaveAs', `${mod}Shift+S`),
        'separator',
        item('Import .3dm or .dxf…', 'Import'),
        item('Export .3dm…', 'Export'),
        'separator',
        item('Import STEP…', 'ImportSTEP'),
        item('Export STEP…', 'ExportSTEP'),
        'separator',
        item('Print to PDF… (view or layouts)', 'ExportPDF'),
        item('Export DXF…', 'ExportDXF'),
      ],
    ],
    [
      'Edit',
      [
        item('Undo', 'Undo', `${mod}Z`),
        item('Redo', 'Redo', `${mod}Y`),
        'separator',
        item('Trim', 'Trim', 'TR'),
        item('Split', 'Split'),
        item('Join', 'Join', 'J'),
        item('Explode', 'Explode', 'X'),
        'separator',
        item('Control Points On', 'PointsOn', 'F10'),
        item('Control Points Off', 'PointsOff', 'F11'),
        'separator',
        item('Delete', 'Delete', 'Del'),
        'separator',
        item('Group', 'Group', 'G'),
        item('Ungroup', 'Ungroup', 'UG'),
        item('Add to Group', 'AddToGroup'),
        item('Remove from Group', 'RemoveFromGroup'),
        'separator',
        item('Make Block…', 'Block', 'B'),
        item('Insert Block…', 'Insert', 'I'),
        item('Edit Block', 'BlockEdit'),
        item('Remove Unused Blocks', 'Purge'),
        'separator',
        item('Select All', 'SelAll', `${mod}A`),
        item('Select None', 'SelNone', 'Esc'),
      ],
    ],
    [
      'View',
      [
        item('Zoom Extents', 'Zoom Extents', 'ZE'),
        item('Zoom Extents, All Viewports', 'Zoom All', 'ZEA'),
        item('Zoom Selected', 'Zoom Selected', 'ZS'),
        'separator',
        {
          label: 'Maximize Viewport',
          action: run('MaxViewport'),
          checked: () => display.isMaximized,
        },
      ],
    ],
    [
      'Curve',
      [
        item('Line', 'Line'),
        item('Polyline', 'Polyline'),
        item('Rectangle', 'Rectangle', 'REC'),
        item('Circle', 'Circle'),
        item('Arc', 'Arc', 'A'),
        item('Control Point Curve', 'Curve'),
        item('Interpolated Curve', 'InterpCrv'),
        item('Ellipse', 'Ellipse', 'EL'),
        item('Polygon', 'Polygon', 'POL'),
        item('Helix', 'Helix'),
        'separator',
        item('Offset', 'Offset', 'OF'),
        item('Fillet', 'Fillet', 'F'),
        item('Fillet Corners', 'FilletCorners'),
        item('Chamfer', 'Chamfer', 'CHA'),
        item('Extend', 'Extend', 'EX'),
        item('Blend Curves', 'BlendCrv'),
        item('Rebuild', 'Rebuild'),
      ],
    ],
    [
      'Surface',
      [
        item('Extrude Curve', 'ExtrudeCrv', 'EXT'),
        item('Revolve', 'Revolve', 'REV'),
        item('Loft', 'Loft'),
        item('Sweep 1 Rail', 'Sweep1'),
        item('Planar Surface', 'PlanarSrf'),
        'separator',
        item('Offset Surface', 'OffsetSrf'),
        item('Extrude Surface', 'ExtrudeSrf'),
        item('Cap Planar Holes', 'Cap'),
        item('Extract Faces', 'ExtractSrf'),
        'separator',
        item('Project Curves', 'Project'),
        item('Pull Curves', 'Pull'),
        item('Intersection Curves', 'Intersect'),
        item('Duplicate Border', 'DupBorder'),
        item('Duplicate Edges', 'DupEdge'),
      ],
    ],
    [
      'Solid',
      [
        item('Box', 'Box'),
        item('Cylinder', 'Cylinder'),
        item('Sphere', 'Sphere'),
        'separator',
        item('Boolean Union', 'BooleanUnion', 'BU'),
        item('Boolean Difference', 'BooleanDifference', 'BD'),
        item('Boolean Intersection', 'BooleanIntersection', 'BI'),
        'separator',
        item('Fillet Edges', 'FilletEdge', 'FE'),
        item('Shell', 'Shell'),
        'separator',
        item('Section', 'Section'),
        item('Contour', 'Contour'),
      ],
    ],
    [
      'Drawing',
      [
        item('New Layout', 'Layout'),
        item('Back to Model', 'ModelView'),
        'separator',
        item('Make 2D Drawing', 'Make2D'),
        'separator',
        item('Text', 'Text'),
        item('Linear Dimension', 'Dim'),
        item('Aligned Dimension', 'DimAligned'),
        item('Radius Dimension', 'DimRadius'),
        item('Diameter Dimension', 'DimDiameter'),
        item('Angle Dimension', 'DimAngle'),
        item('Leader', 'Leader'),
        'separator',
        item('Hatch', 'Hatch', 'H'),
      ],
    ],
    [
      'Transform',
      [
        item('Move', 'Move', 'M'),
        item('Copy', 'Copy'),
        item('Rotate', 'Rotate', 'RO'),
        item('Scale', 'Scale', 'SC'),
        item('Mirror', 'Mirror', 'MI'),
        'separator',
        item('Rectangular Array', 'Array', 'AR'),
        item('Polar Array', 'ArrayPolar', 'AP'),
      ],
    ],
    [
      'Tools',
      [
        { label: 'Grid Snap', shortcut: 'F9', action: () => settings.toggle('gridSnap'), checked: () => settings.gridSnap },
        { label: 'Ortho', shortcut: 'F8', action: () => settings.toggle('ortho'), checked: () => settings.ortho },
        { label: 'Object Snap', shortcut: 'F3', action: () => settings.toggle('osnap'), checked: () => settings.osnap },
        'separator',
        { label: 'Gumball', action: () => settings.toggle('gumball'), checked: () => settings.gumball },
        'separator',
        item('Model Units…', 'Units'),
      ],
    ],
    [
      'Help',
      [
        { label: 'Command List', action: () => log(`Commands: ${runner.names.join(', ')}`) },
        {
          label: 'Mouse and Keyboard',
          action: () =>
            log(
              'Right drag: orbit (Perspective) or pan. Shift+right drag or middle drag: pan. Wheel: zoom. ' +
                'Drag a selected object or control point to move it; use the gumball to move, rotate or scale. ' +
                'Enter, Space or right click: repeat the last command. Double-click a viewport title: maximize.',
            ),
        },
        'separator',
        { label: 'About ArchiOpen', action: () => log('ArchiOpen 0.1 — open source NURBS modeler. github.com/paugavilan8/ArchiOpen') },
      ],
    ],
  ]

  for (const [title, entries] of menus) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'menubar-item'
    button.textContent = title
    const show = () => {
      openMenu(button, entries, { onClose: () => button.classList.remove('open') })
      button.classList.add('open')
    }
    button.addEventListener('click', () => (menuAnchor() === button ? closeMenu() : show()))
    // Once a menu is open, hovering another title switches to it, as in desktop menu bars.
    button.addEventListener('pointerenter', () => {
      if (isMenuOpen() && menuAnchor() !== button && menuAnchor()?.classList.contains('menubar-item')) show()
    })
    container.appendChild(button)
  }
}
