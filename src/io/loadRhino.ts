import type { RhinoModule } from 'rhino3dm'

let loading: Promise<RhinoModule> | null = null

/**
 * Loads the rhino3dm WebAssembly module the first time a .3dm file is read or written, so the
 * 2.6 MB download does not slow down starting the app.
 */
export function loadRhino(): Promise<RhinoModule> {
  loading ??= Promise.all([import('rhino3dm/rhino3dm.module.js'), import('rhino3dm/rhino3dm.wasm?url')]).then(([module, wasm]) =>
    module.default({ locateFile: () => wasm.default }),
  )
  // Let a failed load (e.g. no network in the browser) be retried next time.
  loading.catch(() => (loading = null))
  return loading
}
