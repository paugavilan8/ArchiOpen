import './style.css'
import { registerCommands } from './commands'
import { CommandContext, CommandRunner } from './commands/runner'
import { Document } from './core/document'
import { Settings } from './core/settings'
import { Interaction } from './input/interaction'
import { CommandLine } from './ui/commandLine'
import { LayersPanel } from './ui/layersPanel'
import { StatusBar } from './ui/statusBar'
import { buildToolbar } from './ui/toolbar'
import { Display } from './view/display'

const STORAGE_KEY = 'nurbs-cad:document'
const SAVE_DELAY = 300

const doc = new Document()
try {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) doc.load(JSON.parse(saved))
} catch (error) {
  console.warn('Could not restore the saved document', error)
}

const settings = new Settings()
const display = new Display(document.getElementById('viewports')!, doc)
const input = new Interaction(doc, display, settings)
const ctx: CommandContext = { doc, display, input, settings, log: (text) => commandLine.log(text) }
const runner = new CommandRunner(ctx)
registerCommands(runner)

const commandLine = new CommandLine(runner, input)
const statusBar = new StatusBar(doc, settings)
new LayersPanel(document.getElementById('side')!, doc, ctx.log)
buildToolbar(document.getElementById('toolbar')!, runner)

input.ui = {
  setPrompt: (text, options) => commandLine.setPrompt(text, options),
  log: ctx.log,
  setCoords: (x, y, z) => statusBar.setCoords(x, y, z),
}
runner.onIdle = () => commandLine.setIdle()

// Autosave to the browser so a reload does not lose the model.
let saveTimer = 0
doc.on((kind) => {
  if (kind === 'selection') return
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc.toJSON()))
    } catch (error) {
      console.warn('Could not save the document', error)
    }
  }, SAVE_DELAY)
})

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && (target.type === 'text' || target.type === '')
}

const SHORTCUTS: Record<string, string> = { z: 'Undo', y: 'Redo', a: 'SelAll' }
const FUNCTION_KEYS = { F3: 'osnap', F8: 'ortho', F9: 'gridSnap' } as const

// The command line owns the keyboard: typing anywhere goes to it, as long as no other text field has focus.
document.addEventListener('keydown', (e) => {
  const inCommandLine = commandLine.hasFocus
  if (isTextEntry(e.target) && !inCommandLine) return

  if (e.key === 'Escape') {
    commandLine.clear()
    if (runner.busy) runner.cancel()
    else doc.clearSelection()
    return
  }
  if (e.ctrlKey || e.metaKey) {
    const macro = SHORTCUTS[e.key.toLowerCase()]
    if (macro && !runner.busy) {
      e.preventDefault()
      void runner.run(macro)
    }
    return
  }
  if (e.key in FUNCTION_KEYS) {
    e.preventDefault()
    settings.toggle(FUNCTION_KEYS[e.key as keyof typeof FUNCTION_KEYS])
    return
  }
  if (e.key === 'Delete' && !runner.busy && commandLine.isEmpty && doc.selection.size > 0) {
    e.preventDefault()
    void runner.run('Delete')
    return
  }
  if (inCommandLine) return

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    commandLine.submit()
  } else if (e.key.length === 1 && !e.altKey) {
    commandLine.focus()
  }
})

// Clicking buttons or viewports hands the keyboard back to the command line.
document.addEventListener('click', (e) => {
  if (!(e.target instanceof HTMLInputElement)) commandLine.focus()
})

commandLine.log('Type a command name, or pick one from the toolbar. Enter, Space or right click repeats the last command.')
commandLine.focus()

if (import.meta.env.DEV) Object.assign(window, { cad: { doc, display, runner, settings } })
