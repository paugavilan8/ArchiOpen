import type { CommandRunner } from '../commands/runner'
import type { Display } from '../view/display'
import type { DisplayMode } from '../view/viewport'
import { icon } from './icons'
import { closeMenu, menuAnchor, openMenu } from './menu'

/** Turns each viewport title into a button that opens a menu of view actions. */
export function installViewportMenus(display: Display, runner: CommandRunner): void {
  for (const vp of display.viewports) {
    const title = vp.titleEl
    title.dataset.tip = 'Click for view options, double-click to maximize'
    title.appendChild(icon('chevron'))

    title.addEventListener('click', () => {
      if (menuAnchor() === title) return closeMenu()
      display.setActive(vp)
      const setMode = (mode: DisplayMode) => {
        vp.mode = mode
        display.requestRender()
      }
      openMenu(title, [
        { label: 'Maximize', action: () => display.toggleMaximize(vp), checked: () => display.isMaximized },
        'separator',
        { label: 'Wireframe', action: () => setMode('wireframe'), checked: () => vp.mode === 'wireframe' },
        { label: 'Shaded', action: () => setMode('shaded'), checked: () => vp.mode === 'shaded' },
        { label: 'Rendered', action: () => setMode('rendered'), checked: () => vp.mode === 'rendered' },
        { label: 'Ghosted', action: () => setMode('ghosted'), checked: () => vp.mode === 'ghosted' },
        { label: 'X-Ray', action: () => setMode('xray'), checked: () => vp.mode === 'xray' },
        'separator',
        { label: 'Set CPlane…', action: () => void runner.run('CPlane') },
        { label: 'Reset CPlane to World', action: () => void runner.run('CPlane World') },
        'separator',
        { label: 'Zoom Extents', shortcut: 'ZE', action: () => void runner.run('Zoom Extents') },
        { label: 'Zoom Selected', shortcut: 'ZS', action: () => void runner.run('Zoom Selected') },
        { label: 'Zoom Extents, All Viewports', shortcut: 'ZEA', action: () => void runner.run('Zoom All') },
      ])
    })
    // The double-click that maximizes (handled by the display) should not leave the menu open.
    title.addEventListener('dblclick', closeMenu)
  }
}
