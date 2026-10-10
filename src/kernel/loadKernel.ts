import { setOC } from 'replicad'
import { clearAlgorithmsOnDelete } from './occtFixes'

let loading: Promise<void> | null = null
let memory: WebAssembly.Memory | null = null

const inNode = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node

type Instantiate = (...args: unknown[]) => Promise<unknown>

/** Runs `load` noting the memory of the WebAssembly module it instantiates. */
async function noticingMemory<T>(load: () => Promise<T>): Promise<T> {
  const wasm = WebAssembly as unknown as Record<'instantiate' | 'instantiateStreaming', Instantiate>
  const originals = { instantiate: wasm.instantiate, instantiateStreaming: wasm.instantiateStreaming }
  for (const key of ['instantiate', 'instantiateStreaming'] as const) {
    const original = originals[key]
    if (!original) continue
    wasm[key] = async (...args: unknown[]) => {
      const result = (await original.apply(WebAssembly, args)) as { instance?: WebAssembly.Instance } & WebAssembly.Instance
      const exports = (result.instance ?? result).exports
      memory ??= (Object.values(exports).find((e) => e instanceof WebAssembly.Memory) as WebAssembly.Memory | undefined) ?? null
      return result
    }
  }
  try {
    return await load()
  } finally {
    Object.assign(wasm, originals)
  }
}

/** Bytes of WebAssembly memory the kernel holds (it grows as needed and never shrinks). */
export const kernelMemoryBytes = () => memory?.buffer.byteLength ?? 0

/**
 * Loads the Open CASCADE kernel (about 23 MB of WebAssembly) where it runs: in the kernel worker,
 * or in the page itself when there are no workers (and in tests, under Node).
 */
export function loadOC(): Promise<void> {
  loading ??= noticingMemory(async () => {
    const module = await import('replicad-opencascadejs')
    if (inNode) setOC(await module.default())
    else {
      const wasm = await import('replicad-opencascadejs/wasm?url')
      setOC(await module.default({ locateFile: () => wasm.default }))
    }
    clearAlgorithmsOnDelete()
  })
  // Let a failed load be retried next time.
  loading.catch(() => (loading = null))
  return loading
}
