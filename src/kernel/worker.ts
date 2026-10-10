/// <reference lib="webworker" />
import { runJob } from './api'
import { kernelMemoryBytes, loadOC } from './loadKernel'
import { failureOf, type JobAnswer, type JobRequest } from './wire'

/**
 * The kernel worker: loads Open CASCADE once, then runs jobs one at a time as the app sends them,
 * so long operations never freeze the window.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope

const ready = loadOC()
ready.then(
  () => scope.postMessage({ ready: true }),
  (error) => scope.postMessage({ failed: String(error?.message ?? error) }),
)

/** Typed arrays in a result move to the app instead of being copied. */
function transferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer)
  else if (Array.isArray(value)) {
    if (typeof value[0] !== 'number') for (const v of value) transferables(v, out)
  } else if (value && typeof value === 'object') for (const v of Object.values(value)) transferables(v, out)
  return out
}

scope.onmessage = async (event: MessageEvent<JobRequest>) => {
  const { id, name, args } = event.data
  let answer: JobAnswer
  try {
    await ready
    answer = { id, result: await runJob(name, args), memory: kernelMemoryBytes() }
  } catch (error) {
    // Our own errors say what is wrong with the input; the kernel's are exceptions of its own.
    answer = failureOf(id, error)
  }
  try {
    scope.postMessage(answer, transferables('result' in answer ? answer.result : null))
  } catch {
    scope.postMessage(answer)
  }
}
