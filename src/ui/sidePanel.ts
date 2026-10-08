/** A tab strip over a stack of panes; returns the pane element for each tab, in order. */
export function buildTabs(container: HTMLElement, titles: string[]): HTMLElement[] {
  const strip = document.createElement('div')
  strip.className = 'tabs'
  strip.setAttribute('role', 'tablist')
  const panes = titles.map(() => {
    const pane = document.createElement('div')
    pane.className = 'tab-pane'
    pane.setAttribute('role', 'tabpanel')
    return pane
  })
  const tabs = titles.map((title, i) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'tab'
    tab.setAttribute('role', 'tab')
    tab.textContent = title
    tab.addEventListener('click', () => select(i))
    return tab
  })

  function select(index: number): void {
    tabs.forEach((tab, i) => {
      tab.classList.toggle('active', i === index)
      tab.setAttribute('aria-selected', String(i === index))
      panes[i].hidden = i !== index
    })
  }

  strip.append(...tabs)
  container.append(strip, ...panes)
  select(0)
  return panes
}
