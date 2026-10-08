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
    const [name, ...script] = macro.trim().split(/\s+/)
    const command = this.commands.get(name.toLowerCase())
    if (!command) {
      this.ctx.log(`Unknown command: ${name}`)
      return
    }
    if (command.repeat !== false) this.lastMacro = macro
    this.current = this.execute(command, script)
    await this.current
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
        log(`Error in ${command.name}: ${error instanceof Error ? error.message : String(error)}`)
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
