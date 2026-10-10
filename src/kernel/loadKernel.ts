import { setOC } from 'replicad'

let loading: Promise<void> | null = null

const inNode = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node

/**
 * Loads the Open CASCADE kernel (about 23 MB of WebAssembly) where it runs: in the kernel worker,
 * or in the page itself when there are no workers (and in tests, under Node).
 */
export function loadOC(): Promise<void> {
  loading ??= (async () => {
    const module = await import('replicad-opencascadejs')
    if (inNode) {
      setOC(await module.default())
      return
    }
    const wasm = await import('replicad-opencascadejs/wasm?url')
    setOC(await module.default({ locateFile: () => wasm.default }))
  })()
  // Let a failed load be retried next time.
  loading.catch(() => (loading = null))
  return loading
}
