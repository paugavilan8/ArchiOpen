import type { Box3, Vector3 } from 'three'
import type { AnyShape } from 'replicad'
import type { BrepGeometry } from '../core/geometry'
import { CancelError } from '../input/interaction'
import type { KernelApi } from './api'
import { decode, encode, failureOf, type JobAnswer, type JobRequest, type ShapeRef } from './wire'

/**
 * The geometry kernel as the app sees it: jobs sent to a Web Worker, so the window stays responsive
 * while Open CASCADE works, and a long job can be stopped. Where workers are not available (Node,
 * in tests) the jobs run in the page instead, with the same results.
 */

/** A job's argument types as the app passes them: kernel shapes become shape references. */
type In<T> = T extends AnyShape ? ShapeRef : T extends readonly (infer U)[] ? In<U>[] : T
type InArgs<A extends unknown[]> = { [K in keyof A]: In<A[K]> }
/** A job's result type as the app gets it: kernel shapes come back as document geometry. */
type Out<T> = T extends AnyShape
  ? BrepGeometry
  : T extends Vector3 | Box3 | Uint8Array | string | number | boolean | null | undefined
    ? T
    : T extends (infer U)[]
      ? Out<U>[]
      : T extends object
        ? { [K in keyof T]: Out<T[K]> }
        : T

type Job = keyof KernelApi
export type JobResult<K extends Job> = Out<Awaited<ReturnType<KernelApi[K]>>>

/**
 * A failure inside the kernel (an Open CASCADE exception), as opposed to an Error of our own that
 * says what is wrong with the input. Callers turn it into a "Could not …" message.
 */
export class KernelFailure {
  constructor(readonly message: string) {}
  toString(): string {
    return `Kernel failure: ${this.message}`
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

let worker: Worker | null = null
/** A fresh worker getting ready to take over from one that holds too much memory. */
let spare: Worker | null = null
let spareReady = false
/** The worker's WebAssembly memory after its last job. */
let workerMemory = 0
/** Above this, an idle worker is swapped for a fresh one, which gives its memory back. */
let memoryLimit = 1024 ** 3
let restarts = 0
let starting: Promise<void> | null = null
let ready = false
let nextId = 1
const pending = new Map<number, Pending>()
const busyListeners = new Set<(busy: boolean) => void>()

const useWorker = () => typeof Worker !== 'undefined'

function setBusy(): void {
  for (const listener of busyListeners) listener(pending.size > 0)
}

/** Calls `listener` with true when the kernel starts working and false when it is done. */
export function onKernelBusy(listener: (busy: boolean) => void): () => void {
  busyListeners.add(listener)
  return () => busyListeners.delete(listener)
}

export const kernelReady = () => ready

function settle(answer: JobAnswer): void {
  const job = pending.get(answer.id)
  if (!job) return
  pending.delete(answer.id)
  if (answer.memory !== undefined) workerMemory = answer.memory
  if ('result' in answer) job.resolve(decode(answer.result))
  else job.reject(answer.own ? new Error(answer.error) : new KernelFailure(answer.error))
  setBusy()
  recycleWhenIdle()
}

/**
 * WebAssembly memory only grows: a worker that once needed a lot (a big import, say) keeps it. When
 * it holds more than the limit, a fresh worker loads in the background and takes over once the
 * kernel is idle, so jobs never wait for it.
 */
function recycleWhenIdle(): void {
  if (!worker || pending.size > 0) return
  if (spare) {
    if (!spareReady) return
    worker.terminate()
    worker = spare
    spare = null
    spareReady = false
    workerMemory = 0
    restarts++
    return
  }
  if (workerMemory <= memoryLimit) return
  spare = spawn(
    () => {
      spareReady = true
      recycleWhenIdle()
    },
    () => {
      spare?.terminate()
      spare = null
      spareReady = false
    },
  )
}

/** Sets the memory above which the kernel's worker is renewed (for tests and diagnostics). */
export function setKernelMemoryLimit(bytes: number): void {
  memoryLimit = bytes
}

/** The kernel worker's memory after its last job, and how many times a fresh worker took over. */
export const kernelMemory = () => ({ bytes: workerMemory, restarts })

/** A kernel worker; its answers settle jobs, whichever worker it is. */
function spawn(onReady: () => void, onFailed: (error: Error) => void): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (event: MessageEvent) => {
    const data = event.data as JobAnswer | { ready: true } | { failed: string }
    if ('ready' in data) onReady()
    else if ('failed' in data) onFailed(new Error(`The geometry kernel did not load: ${data.failed}`))
    else settle(data)
  }
  w.onerror = (event) => onFailed(new Error(`The geometry kernel stopped: ${event.message || 'unknown error'}`))
  return w
}

/** Stops the worker; what it was doing fails with `reason`, and the next job starts a new one. */
function stop(reason: unknown): void {
  worker?.terminate()
  worker = null
  spare?.terminate()
  spare = null
  spareReady = false
  workerMemory = 0
  starting = null
  ready = false
  const jobs = [...pending.values()]
  pending.clear()
  for (const job of jobs) job.reject(reason)
  setBusy()
}

/** Starts the kernel (the first time a surface or solid needs it), resolving once it is loaded. */
export function loadKernel(): Promise<void> {
  starting ??= new Promise<void>((resolve, reject) => {
    if (!useWorker()) {
      import('./loadKernel')
        .then(({ loadOC }) => loadOC())
        .then(() => {
          ready = true
          resolve()
        }, reject)
      return
    }
    worker = spawn(
      () => {
        ready = true
        resolve()
      },
      (error) => {
        stop(error)
        reject(error)
      },
    )
  })
  // Let a failed start be tried again next time.
  starting.catch(() => (starting = null))
  return starting
}

/**
 * Runs a kernel job (see api.ts) and resolves to its result. Surfaces and solids go in as
 * shapeRef(geometry) and come back as geometry.
 */
export async function kernelJob<K extends Job>(name: K, ...args: InArgs<Parameters<KernelApi[K]>>): Promise<JobResult<K>> {
  await loadKernel()
  const id = nextId++
  const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
  setBusy()
  const request: JobRequest = { id, name, args: args.map((a) => encode(a)) }
  if (worker) worker.postMessage(request)
  else {
    // No worker: the same job, in the page, after the caller has had a chance to go on.
    const { runJob } = await import('./api')
    await Promise.resolve()
    runJob(request.name, request.args).then(
      (value) => settle({ id, result: value }),
      (error) => settle(failureOf(id, error)),
    )
  }
  return (await result) as JobResult<K>
}

/** True while a kernel job is running. */
export const kernelBusy = () => pending.size > 0

/**
 * Stops the kernel job in progress (Esc): the worker is stopped and the job fails as cancelled.
 * Nothing happens if the kernel is idle, so it stays loaded.
 */
export function cancelKernel(): void {
  if (worker && pending.size > 0) stop(new CancelError())
}
