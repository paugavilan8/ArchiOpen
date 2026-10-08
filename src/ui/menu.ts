export interface MenuItem {
  label: string
  shortcut?: string
  action: () => void
  checked?: () => boolean
  disabled?: () => boolean
}

export type MenuEntry = MenuItem | 'separator'

interface OpenMenu {
  el: HTMLElement
  anchor: HTMLElement
  onClose?: () => void
}

let current: OpenMenu | null = null

export function isMenuOpen(): boolean {
  return current !== null
}

export function closeMenu(): void {
  if (!current) return
  const { el, onClose } = current
  current = null
  el.remove()
  onClose?.()
}

/** Opens a dropdown under the anchor. Only one menu is open at a time. */
export function openMenu(anchor: HTMLElement, entries: MenuEntry[], options: { onClose?: () => void } = {}): void {
  closeMenu()
  const el = document.createElement('div')
  el.className = 'menu'
  el.setAttribute('role', 'menu')

  for (const entry of entries) {
    if (entry === 'separator') {
      el.appendChild(document.createElement('hr'))
      continue
    }
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'menu-item'
    item.setAttribute('role', 'menuitem')
    item.disabled = entry.disabled?.() ?? false
    const check = document.createElement('span')
    check.className = 'menu-check'
    check.textContent = entry.checked?.() ? '✓' : ''
    const label = document.createElement('span')
    label.textContent = entry.label
    const shortcut = document.createElement('kbd')
    shortcut.textContent = entry.shortcut ?? ''
    item.append(check, label, shortcut)
    item.addEventListener('click', () => {
      closeMenu()
      entry.action()
    })
    el.appendChild(item)
  }

  document.body.appendChild(el)
  const rect = anchor.getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - el.offsetWidth - 4)
  el.style.left = `${Math.max(4, left)}px`
  el.style.top = `${rect.bottom + 2}px`
  current = { el, anchor, onClose: options.onClose }
}

/** The element that opened the current menu, if any. */
export function menuAnchor(): HTMLElement | null {
  return current?.anchor ?? null
}

// Close on a press outside the menu and its anchor, on Escape, and when the window changes.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!current) return
    const target = e.target as Node
    if (!current.el.contains(target) && !current.anchor.contains(target)) closeMenu()
  },
  true,
)
document.addEventListener(
  'keydown',
  (e) => {
    if (current && e.key === 'Escape') {
      e.stopPropagation()
      closeMenu()
    }
  },
  true,
)
window.addEventListener('resize', closeMenu)
window.addEventListener('blur', closeMenu)
