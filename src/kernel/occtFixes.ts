import * as R from 'replicad'

/**
 * Open CASCADE's boolean algorithms (union, difference, intersection, section, splitting) keep
 * their working data until Clear() is called: deleting one without it loses some 160 KB of
 * WebAssembly memory each time, for good. Their delete() is made to clear first, for every caller
 * (replicad deletes the ones it makes itself).
 */
export function clearAlgorithmsOnDelete(): void {
  const oc = R.getOC() as unknown as Record<string, { prototype?: Record<string, unknown> } | undefined>
  for (const [name, cls] of Object.entries(oc)) {
    if (!/^(BRepAlgoAPI_|BOPAlgo_)/.test(name)) continue
    const proto = cls?.prototype
    if (!proto || typeof proto.Clear !== 'function' || typeof proto.delete !== 'function' || Object.prototype.hasOwnProperty.call(proto, 'delete')) continue
    const remove = proto.delete as (this: unknown) => void
    proto.delete = function (this: { Clear(): void; isDeleted(): boolean }) {
      try {
        if (!this.isDeleted()) this.Clear()
      } catch {
        // Nothing to clear.
      }
      remove.call(this)
    }
  }
}
