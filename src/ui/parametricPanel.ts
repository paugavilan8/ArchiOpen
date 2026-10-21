import { t } from '../app/language'
import type { ParametricSession } from '../app/parametric'

/**
 * The sliders of a parametric script, floating over the views: one per parameter, showing its value,
 * with Bake (keep what it made) and Discard (take it away). Values apply when a slider is let go.
 */
export function showParametricPanel(session: ParametricSession): void {
  document.querySelector('.parametric-panel')?.remove()
  const panel = document.createElement('div')
  panel.className = 'parametric-panel'
  const title = document.createElement('div')
  title.className = 'parametric-title'
  const rows = document.createElement('div')
  rows.className = 'parametric-rows'
  const status = document.createElement('div')
  status.className = 'parametric-status'
  const buttons = document.createElement('div')
  buttons.className = 'parametric-buttons'
  const button = (text: string, primary: boolean, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = t(text)
    if (primary) b.className = 'primary'
    b.addEventListener('click', onClick)
    return b
  }
  buttons.append(
    button('Bake', true, () => session.bake()),
    button('Discard', false, () => session.discard()),
  )
  panel.append(title, rows, status, buttons)
  document.body.append(panel)

  const format = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))))))
  let shown = ''
  const render = () => {
    if (session.done) {
      panel.remove()
      return
    }
    title.textContent = session.name
    status.textContent = session.running ? t('Making it again…') : session.error ? t('Error: {error}', { error: session.error }) : t(session.output.length === 1 ? '1 object' : '{n} objects', { n: session.output.length })
    status.classList.toggle('error', !!session.error && !session.running)
    // The sliders are made again only when the parameters change (not while one is moved).
    const key = JSON.stringify(session.defs)
    if (key === shown) return
    shown = key
    rows.replaceChildren(
      ...session.defs.map((d) => {
        const row = document.createElement('label')
        row.className = 'parametric-row'
        const name = document.createElement('span')
        name.textContent = d.name
        const value = document.createElement('output')
        const slider = document.createElement('input')
        slider.type = 'range'
        slider.min = String(d.min)
        slider.max = String(d.max)
        slider.step = String(d.step)
        slider.value = String(session.values.get(d.name) ?? d.value)
        value.textContent = format(Number(slider.value), d.step)
        slider.addEventListener('input', () => (value.textContent = format(Number(slider.value), d.step)))
        slider.addEventListener('change', () => void session.set(d.name, Number(slider.value)))
        row.append(name, slider, value)
        return row
      }),
    )
  }
  session.onChange(render)
  render()
}
