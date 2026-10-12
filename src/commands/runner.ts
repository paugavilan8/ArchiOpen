import type { HistoryManager } from '../app/historyManager'
import type { FileManager } from '../app/files'
import type { Document } from '../core/document'
import type { Settings } from '../core/settings'
import { CancelError, Interaction } from '../input/interaction'
import type { Display } from '../view/display'

export interface CommandContext {
  doc: Document
  display: Display
  input: Interaction
  settings: Settings
  files: FileManager
  /** Construction history; missing where history is not followed (e.g. in tests). */
  history?: HistoryManager
  log(text: string): void
}

export interface Command {
  name: string
  /** Set to false for commands that manage the undo stack themselves. */
  history?: boolean
  /** Set to false to keep Enter from repeating this command. */
  repeat?: boolean
  run(ctx: CommandContext): Promise<void> | void
}

export class CommandRunner {
  onStart: () => void = () => {}
  onIdle: () => void = () => {}

  private readonly commands = new Map<string, Command>()
  private readonly aliases = new Map<string, string>()
  private current: Promise<void> | null = null
  private lastMacro: string | null = null
  /** The error the last command ended with, if any (for scripts). */
  private lastError: string | null = null

  constructor(private readonly ctx: CommandContext) {
    ctx.input.onIdleEnter = () => this.repeat()
  }

  register(...commands: Command[]): void {
    for (const command of commands) this.commands.set(command.name.toLowerCase(), command)
  }

  /** An alias expands to a macro: a command name followed by scripted answers to its prompts. */
  alias(name: string, macro: string): void {
    this.aliases.set(name.toLowerCase(), macro)
  }

  get busy(): boolean {
    return this.current !== null
  }

  get names(): string[] {
    return [...this.commands.values()].map((c) => c.name).sort((a, b) => a.localeCompare(b))
  }

  /** Returns the macro for a command name or alias, or null if there is no exact match. */
  resolve(text: string): string | null {
    const key = text.trim().toLowerCase()
    return this.aliases.get(key) ?? this.commands.get(key)?.name ?? null
  }

  cancel(): void {
    this.ctx.input.cancel()
  }

  repeat(): void {
    if (this.lastMacro) void this.run(this.lastMacro)
  }

  /** Runs a macro, cancelling whatever command is in progress first. */
  async run(macro: string): Promise<void> {
    if (this.current) {
      this.cancel()
      await this.current
    }
    // Quoted answers can hold spaces: Insert "Mesa redonda".
    const [name, ...script] = (macro.trim().match(/"[^"]*"|\S+/g) ?? ['']).map((t) => t.replace(/^"(.*)"$/, '$1'))
    const command = this.commands.get(name.toLowerCase())
    if (!command) {
      this.ctx.log(`Unknown command: ${name}`)
      return
    }
    if (command.repeat !== false) this.lastMacro = macro
    this.current = this.execute(command, script)
    await this.current
  }

  /**
   * Runs a command with its answers given one by one (an empty one is Enter), as scripts do: when
   * they run out, the command is given Enter until it ends, so it never waits for the user.
   */
  async runWith(name: string, answers: string[]): Promise<void> {
    const command = this.commands.get(name.trim().toLowerCase())
    if (!command) throw new Error(`Unknown command: ${name}`)
    if (this.current) {
      this.cancel()
      await this.current
    }
    this.ctx.input.unattended = 50
    this.lastError = null
    try {
      this.current = this.execute(command, answers)
      await this.current
    } finally {
      this.ctx.input.unattended = 0
    }
    if (this.lastError) throw new Error(this.lastError)
  }

  /** Runs a command object that is not registered by name, such as an edit made with the gumball. */
  async runCommand(command: Command): Promise<void> {
    if (this.current) {
      this.cancel()
      await this.current
    }
    this.current = this.execute(command, [])
    await this.current
  }

  private async execute(command: Command, script: string[]): Promise<void> {
    const { doc, input, log } = this.ctx
    const tracked = command.history !== false
    log(`Command: ${command.name}`)
    this.onStart()
    input.setScript(script)
    if (tracked) doc.begin()
    try {
      await command.run(this.ctx)
    } catch (error) {
      if (!(error instanceof CancelError)) {
        console.error(error)
        this.lastError = `Error in ${command.name}: ${error instanceof Error ? error.message : String(error)}`
        log(this.lastError)
      }
    } finally {
      // Work done before a cancel (e.g. the copies already placed) is kept as one undo step.
      if (tracked) doc.commit()
      input.setScript([])
      this.current = null
      this.onIdle()
    }
  }
}
