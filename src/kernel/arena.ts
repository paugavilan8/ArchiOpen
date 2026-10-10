import * as R from 'replicad'

/**
 * Frees the Open CASCADE objects a kernel job makes. The kernel's JavaScript bindings never free
 * objects by themselves: every point, explorer, adaptor or shape copy made and not deleted stays in
 * WebAssembly memory for good. Jobs hand their results back as plain data, so whatever kernel object
 * a job made is of no use once it has answered: the bindings are wrapped once so that each object
 * they make while a job runs is noted, and deleted when the job is done.
 */

interface Deletable {
  delete(): void
  isDeleted?(): boolean
}

/** The objects made by the job running now, or null between jobs. */
let current: Deletable[] | null = null
let wrapped = false

/** A bindings object: it has delete() and isDeleted() (embind's handles). */
const isKernelObject = (value: unknown): value is Deletable =>
  typeof value === 'object' && value !== null && typeof (value as Deletable).delete === 'function' && typeof (value as Deletable).isDeleted === 'function'

/** Notes kernel objects in a result: the object itself, or those in a result envelope ({ returnValue, ... }). */
function note(value: unknown): void {
  if (!current || typeof value !== 'object' || value === null) return
  if (isKernelObject(value)) {
    current.push(value)
    return
  }
  if (Array.isArray(value)) return
  for (const v of Object.values(value)) if (isKernelObject(v)) current.push(v)
}

function wrapFunction<F extends (...args: unknown[]) => unknown>(f: F): F {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const result = f.apply(this, args)
    note(result)
    return result
  } as F
  // Overloaded methods find their variants in a table on the method itself (embind's overloadTable).
  return Object.assign(wrapper, f)
}

/** Wraps the bindings' classes (constructors, static and instance methods), once. */
function wrapBindings(): void {
  if (wrapped) return
  wrapped = true
  const oc = R.getOC() as unknown as Record<string, unknown>
  const done = new Set<object>()
  for (const [name, value] of Object.entries(oc)) {
    if (typeof value !== 'function' || !value.prototype || typeof value.prototype.delete !== 'function') continue
    const cls = value as unknown as { prototype: Record<string, unknown> } & Record<string, unknown>
    // Methods, on each class's own prototype (inherited ones are wrapped on their own class).
    if (!done.has(cls.prototype)) {
      done.add(cls.prototype)
      for (const key of Object.getOwnPropertyNames(cls.prototype)) {
        if (key === 'constructor' || key === 'delete' || key === 'isDeleted' || key === 'deleteLater' || key === 'isAliasOf' || key === 'clone') continue
        const d = Object.getOwnPropertyDescriptor(cls.prototype, key)
        if (d && typeof d.value === 'function') cls.prototype[key] = wrapFunction(d.value)
      }
    }
    // Static methods.
    for (const key of Object.getOwnPropertyNames(cls)) {
      const d = Object.getOwnPropertyDescriptor(cls, key)
      if (d && typeof d.value === 'function' && d.writable) cls[key] = wrapFunction(d.value)
    }
    // Constructors, through a proxy: embind checks that `new` built its own kind of object, which a
    // subclass would not. `instanceof` and static methods go to the class itself.
    oc[name] = new Proxy(value, {
      construct(target, args) {
        const made = Reflect.construct(target, args, target) as object
        note(made)
        return made
      },
    })
  }
}

const noop = () => {}

/** Deletes what a job made, newest first, and makes later deletes of them (by replicad) harmless. */
/** How many kernel objects the last job made (for tests). */
export let lastJobObjects = 0

function release(objects: Deletable[]): void {
  lastJobObjects = objects.length
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]
    try {
      if (!o.isDeleted?.()) o.delete()
    } catch {
      // Already gone (deleted by the job itself, or the same object noted twice).
    }
    ;(o as { delete: () => void }).delete = noop
  }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs a job with its kernel objects noted and deleted once `job` has resolved (its result must not
 * hold kernel objects by then). Jobs go one at a time, so each frees only its own.
 */
export function inArena<T>(job: () => Promise<T>): Promise<T> {
  const run = async () => {
    wrapBindings()
    current = []
    const made = current
    try {
      return await job()
    } finally {
      current = null
      release(made)
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}
