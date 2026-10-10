import type { CommandRunner } from '../commands/runner'
import type { Interaction } from '../input/interaction'

const IDLE_PROMPT = 'Command'
const MAX_SUGGESTIONS = 8
const MAX_HISTORY_LINES = 200

/** Command history, prompt and input field, with autocompletion of command names. */
export class CommandLine {
  private readonly history = document.getElementById('cmd-history') as HTMLDivElement
  private readonly prompt = document.getElementById('cmd-prompt') as HTMLSpanElement
  private readonly input = document.getElementById('cmd-input') as HTMLInputElement
  private readonly suggest = document.getElementById('cmd-suggest') as HTMLUListElement
  private suggestions: string[] = []
  private highlighted = 0

  constructor(
    private readonly runner: CommandRunner,
    private readonly interaction: Interaction,
  ) {
    this.setPrompt(IDLE_PROMPT, [])
    this.input.addEventListener('input', () => this.updateSuggestions())
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.input.addEventListener('blur', () => this.hideSuggestions())
  }

  log(text: string): void {
    const line = document.createElement('div')
    line.textContent = text
    this.history.appendChild(line)
    while (this.history.childElementCount > MAX_HISTORY_LINES) this.history.firstElementChild!.remove()
    this.history.scrollTop = this.history.scrollHeight
  }

  setPrompt(text: string, options: string[]): void {
    this.prompt.replaceChildren(text)
    if (options.length > 0) {
      this.prompt.append(' ( ')
      for (const option of options) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'cmd-option'
        button.textContent = option
        button.addEventListener('click', () => this.interaction.handleText(option))
        this.prompt.append(button, ' ')
      }
      this.prompt.append(')')
    }
    this.prompt.append(':')
  }

  setIdle(): void {
    this.setPrompt(IDLE_PROMPT, [])
    // Lines typed ahead that the finished command did not need: the next command and its answers.
    const [next, ...rest] = this.interaction.takeTypeAhead()
    if (next === undefined) return
    for (const line of rest) this.interaction.typeAheadLine(line)
    this.run(next)
  }

  focus(): void {
    this.input.focus()
  }

  /** True if some of the typed text is selected (so Ctrl+C copies text, not objects). */
  get hasSelectedText(): boolean {
    return this.input.selectionStart !== this.input.selectionEnd
  }

  get hasFocus(): boolean {
    return document.activeElement === this.input
  }

  get isEmpty(): boolean {
    return this.input.value === ''
  }

  clear(): void {
    this.input.value = ''
    this.hideSuggestions()
  }

  /** Enter or Space: answers the active command, runs the typed one, or repeats the last. */
  submit(): void {
    const text = this.input.value.trim()
    const picked = this.suggestions[this.highlighted]
    this.input.value = ''
    this.hideSuggestions()

    if (this.runner.busy) {
      if (text !== '') this.log(text)
      // A command at work (on the kernel, say) asks for nothing yet: keep the line for it.
      if (this.interaction.busy) this.interaction.handleText(text)
      else this.interaction.typeAheadLine(text)
    } else this.run(text, picked)
  }

  /** Runs a typed command (or a suggestion picked for it); an empty line repeats the last one. */
  private run(text: string, picked?: string): void {
    if (text === '') {
      this.runner.repeat()
      return
    }
    const macro = this.runner.resolve(text) ?? picked
    if (macro) void this.runner.run(macro)
    else this.log(`Unknown command: ${text}`)
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case ' ':
        if (this.interaction.wantsText) break
      // falls through
      case 'Enter':
        e.preventDefault()
        this.submit()
        break
      case 'Tab':
        e.preventDefault()
        if (this.suggestions.length > 0) {
          this.input.value = this.suggestions[this.highlighted]
          this.updateSuggestions()
        }
        break
      case 'ArrowDown':
      case 'ArrowUp':
        if (this.suggestions.length > 0) {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          this.highlighted = (this.highlighted + step + this.suggestions.length) % this.suggestions.length
          this.renderSuggestions()
        }
        break
    }
  }

  private updateSuggestions(): void {
    const text = this.input.value.trim().toLowerCase()
    if (text === '' || this.runner.busy) return this.hideSuggestions()
    const names = this.runner.names
    const starts = names.filter((n) => n.toLowerCase().startsWith(text))
    const contains = names.filter((n) => !starts.includes(n) && n.toLowerCase().includes(text))
    this.suggestions = [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
    this.highlighted = 0
    this.renderSuggestions()
  }

  private renderSuggestions(): void {
    this.suggest.hidden = this.suggestions.length === 0
    this.suggest.replaceChildren(
      ...this.suggestions.map((name, i) => {
        const item = document.createElement('li')
        item.textContent = name
        item.classList.toggle('highlighted', i === this.highlighted)
        // mousedown rather than click, so it fires before the input loses focus.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault()
          this.input.value = ''
          this.hideSuggestions()
          void this.runner.run(name)
        })
        return item
      }),
    )
  }

  private hideSuggestions(): void {
    this.suggestions = []
    this.suggest.hidden = true
  }
}
