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
        item('Open (.archi, .3dm)…', 'Open', `${mod}O`),
        'separator',
        item('Save', 'Save', `${mod}S`),
        item('Save As…', 'SaveAs', `${mod}Shift+S`),
        'separator',
        item('Import .3dm…', 'Import'),
        item('Export .3dm…', 'Export'),
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
        'separator',
        item('Offset', 'Offset', 'OF'),
        item('Fillet', 'Fillet', 'F'),
        item('Fillet Corners', 'FilletCorners'),
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
