/**
 * Shows a rendered image over the app, with buttons to save it or close. Resolves when closed;
 * `save` runs when the user asks to save (and may be called more than once).
 */
export function showRenderWindow(image: HTMLCanvasElement, title: string, save: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'render-window'
    const frame = document.createElement('div')
    frame.className = 'render-frame'
    const header = document.createElement('div')
    header.className = 'render-header'
    const label = document.createElement('span')
    label.textContent = title
    const button = (text: string, primary: boolean, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      if (primary) b.className = 'primary'
      b.addEventListener('click', onClick)
      return b
    }
    const close = () => {
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    header.append(label, button('Save PNG…', true, () => void save()), button('Close', false, close))
    image.className = 'render-image'
    frame.append(header, image)
    backdrop.append(frame)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.append(backdrop)
  })
}

/** PNG bytes of a canvas. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('Could not encode the image'))), 'image/png'),
  )
}
