const DELAY = 450

/** Shows the `data-tip` text of whatever is under the pointer, after a short delay. */
export function installTooltips(): void {
  const tip = document.createElement('div')
  tip.className = 'tooltip'
  tip.hidden = true
  document.body.appendChild(tip)

  let timer = 0
  let target: HTMLElement | null = null

  const hide = () => {
    window.clearTimeout(timer)
    target = null
    tip.hidden = true
  }

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-tip]')
    if (el === target) return
    hide()
    if (!el) return
    target = el
    timer = window.setTimeout(() => {
      tip.textContent = el.dataset.tip ?? ''
      tip.hidden = false
      const rect = el.getBoundingClientRect()
      // Tools in the vertical toolbar get their tip on the right; everything else below.
      const beside = el.closest('#toolbar') !== null
      let x = beside ? rect.right + 8 : rect.left + rect.width / 2 - tip.offsetWidth / 2
      let y = beside ? rect.top + rect.height / 2 - tip.offsetHeight / 2 : rect.bottom + 6
      x = Math.max(4, Math.min(x, window.innerWidth - tip.offsetWidth - 4))
      if (y + tip.offsetHeight > window.innerHeight - 4) y = rect.top - tip.offsetHeight - 6
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    }, DELAY)
  })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('pointerleave', hide)
}
