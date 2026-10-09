export type SnapKind = 'end' | 'near' | 'mid' | 'cen' | 'quad'
export type ToggleKey = 'gridSnap' | 'ortho' | 'osnap' | 'gumball' | 'history'

export class Settings {
  gridSnap = false
  ortho = false
  osnap = true
  gumball = true
  /** Surfaces made from curves remember them and update when the curves change. */
  history = true
  gridSpacing = 1
  readonly snaps: Record<SnapKind, boolean> = { end: true, near: false, mid: true, cen: true, quad: false }

  private listeners = new Set<() => void>()

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  toggle(key: ToggleKey): boolean {
    this[key] = !this[key]
    this.emit()
    return this[key]
  }

  setSnap(kind: SnapKind, on: boolean): void {
    this.snaps[kind] = on
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
