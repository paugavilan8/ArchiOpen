import { setOC } from 'replicad'

let loading: Promise<void> | null = null
let ready = false

export const kernelReady = () => ready

/**
 * Loads the Open CASCADE kernel (about 23 MB of WebAssembly) the first time a surface or solid
 * operation needs it, so starting the app stays fast.
 */
export function loadKernel(): Promise<void> {
  loading ??= Promise.all([import('replicad-opencascadejs'), import('replicad-opencascadejs/wasm?url')]).then(async ([module, wasm]) => {
    setOC(await module.default({ locateFile: () => wasm.default }))
    ready = true
  })
  // Let a failed load be retried next time.
  loading.catch(() => (loading = null))
  return loading
}
