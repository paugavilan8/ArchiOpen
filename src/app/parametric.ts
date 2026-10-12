import type { CommandContext, CommandRunner } from '../commands/runner'
import { paramDef, runScript, scriptApi, type ParamDef } from './scripting'

/**
 * Parametric scripts, in the spirit of visual programming tools: a script that asks for its
 * parameters with archi.param() gets a slider for each, and moving one makes its output again
 * with the new values. What it made last time is taken away first, and each run is one undo step.
 * Baking keeps what it made as ordinary objects; discarding takes it away.
 */
export class ParametricSession {
  defs: ParamDef[] = []
  readonly values = new Map<string, number>()
  /** The objects the last run made. */
  output: number[] = []
  running = false
  /** The last run's error, if it failed. */
  error: string | null = null
  private again = false
  private ended = false
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly name: string,
    private readonly code: string,
    private readonly ctx: CommandContext,
    private readonly runner: CommandRunner,
  ) {}

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  /** Runs the script with the current values, in place of the last run's output. */
  async run(): Promise<void> {
    if (this.ended) return
    if (this.running) {
      // A newer value came while running: run once more when this run ends.
      this.again = true
      return
    }
    this.running = true
    this.emit()
    const { doc } = this.ctx
    doc.beginGroup()
    try {
      for (const id of this.output) if (doc.objects.has(id)) doc.remove(id)
      this.output = []
      const before = new Set(doc.objects.keys())
      const seen: ParamDef[] = []
      const param = (name: string, value: number, range?: { min?: number; max?: number; step?: number }) => {
        const def = paramDef(name, value, range)
        if (!seen.some((d) => d.name === name)) seen.push(def)
        const v = this.values.get(name)
        return v === undefined ? def.value : Math.min(def.max, Math.max(def.min, v))
      }
      this.error = null
      try {
        await runScript(this.code, scriptApi(this.ctx, this.runner, param))
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.ctx.log(`Error in ${this.name}: ${this.error}`)
      }
      this.output = [...doc.objects.keys()].filter((id) => !before.has(id))
      this.defs = seen
      for (const d of seen) if (!this.values.has(d.name)) this.values.set(d.name, d.value)
    } finally {
      doc.endGroup()
      this.running = false
      this.emit()
    }
    if (this.again) {
      this.again = false
      await this.run()
    }
  }

  /** Sets a parameter and runs again. */
  set(name: string, value: number): Promise<void> {
    this.values.set(name, value)
    return this.run()
  }

  /** Ends the session, keeping what it made as ordinary objects. */
  bake(): number[] {
    this.ended = true
    this.emit()
    return this.output
  }

  /** Ends the session, taking away what it made (as one undo step). */
  discard(): void {
    const { doc } = this.ctx
    doc.beginGroup()
    for (const id of this.output) if (doc.objects.has(id)) doc.remove(id)
    doc.endGroup()
    this.output = []
    this.ended = true
    this.emit()
  }

  get done(): boolean {
    return this.ended
  }
}
