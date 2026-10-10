import './style.css'
import { FileManager, isDesktop } from './app/files'
import { HistoryManager } from './app/historyManager'
import { registerCommands } from './commands'
import { CommandContext, CommandRunner } from './commands/runner'
import { Document } from './core/document'
import { Settings } from './core/settings'
import { Interaction } from './input/interaction'
import { CommandLine } from './ui/commandLine'
import { LayersPanel } from './ui/layersPanel'
import { BlocksPanel } from './ui/blocksPanel'
import { ViewsPanel } from './ui/viewsPanel'
import { MaterialsPanel } from './ui/materialsPanel'
import { installBlockEditBanner } from './ui/blockEditBanner'
import { LayoutEditor } from './ui/layoutEditor'
import { Gumball } from './ui/gumball'
import { closeMenu, isMenuOpen } from './ui/menu'
import { buildMenuBar } from './ui/menuBar'
import { PropertiesPanel } from './ui/propertiesPanel'
import { buildTabs } from './ui/sidePanel'
import { StatusBar } from './ui/statusBar'
import { cancelKernel, kernelBusy, onKernelBusy } from './kernel/client'
import { buildToolbars } from './ui/toolbar'
import { installTooltips } from './ui/tooltip'
import { installViewportMenus } from './ui/viewportMenus'
import { Display } from './view/display'

const STORAGE_KEY = 'archiopen:session'
const SAVE_DELAY = 300

const doc = new Document()
const files = new FileManager(doc)
const settings = new Settings()
const display = new Display(document.getElementById('viewports')!, doc)
const input = new Interaction(doc, display, settings)
const history = new HistoryManager(doc, settings, (text) => commandLine.log(text))
const ctx: CommandContext = { doc, display, input, settings, files, history, log: (text) => commandLine.log(text) }
const runner = new CommandRunner(ctx)
registerCommands(runner)

const commandLine = new CommandLine(runner, input)
const statusBar = new StatusBar(document.getElementById('status-bar')!, doc, settings)
onKernelBusy((busy) => statusBar.setKernelBusy(busy))
const [propertiesPane, layersPane, materialsPane, blocksPane, viewsPane] = buildTabs(document.getElementById('side')!, ['Properties', 'Layers', 'Materials', 'Blocks', 'Views'])
new PropertiesPanel(propertiesPane, doc, runner)
new LayersPanel(layersPane, doc, ctx.log)
new MaterialsPanel(materialsPane, doc, runner, ctx.log, files)
new BlocksPanel(blocksPane, doc, runner, ctx.log)
new ViewsPanel(viewsPane, doc, display, runner)
installBlockEditBanner(document.getElementById('viewports')!, doc, runner)
new LayoutEditor(document.getElementById('viewports')!, doc, display, runner, ctx.log)
buildMenuBar(document.getElementById('menus')!, runner, ctx)
buildToolbars(document.getElementById('toolbar')!, document.getElementById('standard-bar')!, runner)
installViewportMenus(display, runner)
new Gumball(display, doc, settings, runner, ctx.log)
installTooltips()

input.ui = {
  setPrompt: (text, options) => commandLine.setPrompt(text, options),
  log: ctx.log,
  setCoords: (x, y, z) => statusBar.setCoords(x, y, z),
}
runner.onStart = () => display.requestRender()
runner.onIdle = () => {
  commandLine.setIdle()
  display.requestRender()
}

// --- Window title ----------------------------------------------------------------

const docTitle = document.getElementById('doc-title')!
let shownTitle = ''

function updateTitle(): void {
  const title = `${files.name}${doc.modified ? ' •' : ''} — ArchiOpen`
  if (title === shownTitle) return
  shownTitle = title
  document.title = title
  docTitle.textContent = files.name
  docTitle.classList.toggle('modified', doc.modified)
  if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
}
doc.on(updateTitle)
files.onChange(updateTitle)

// --- Session recovery ------------------------------------------------------------
// The model, its file name and its unsaved state are kept in browser storage, so a crash or reload
// brings back exactly what was on screen. Saving to a file is still what keeps work for good.

interface Session {
  name: string
  path: string | null
  modified: boolean
  document: unknown
}

try {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    const session: Session = JSON.parse(saved)
    doc.load(session.document)
    doc.modified = session.modified
    files.restore(session.name, session.path)
  }
} catch (error) {
  console.warn('Could not restore the previous session', error)
}

let saveTimer = 0
function scheduleSessionSave(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const session: Session = { name: files.name, path: files.path, modified: doc.modified, document: doc.toJSON() }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } catch (error) {
      console.warn('Could not store the session', error)
    }
  }, SAVE_DELAY)
}
doc.on((kind) => {
  if (kind !== 'selection') scheduleSessionSave()
})
files.onChange(scheduleSessionSave)

// --- Closing with unsaved changes ------------------------------------------------

if (isDesktop) {
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await files.confirmDiscard())) event.preventDefault()
    }),
  )
} else {
  window.addEventListener('beforeunload', (e) => {
    if (doc.modified) e.preventDefault()
  })
}

// --- Keyboard --------------------------------------------------------------------

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return target instanceof HTMLInputElement && (target.type === 'text' || target.type === '')
}

const SHORTCUTS: Record<string, string> = { z: 'Undo', y: 'Redo', a: 'SelAll', n: 'New', o: 'Open', s: 'Save', h: 'Hide', l: 'Lock' }
const SHIFT_SHORTCUTS: Record<string, string> = { s: 'SaveAs', z: 'Redo' }
// As in Rhino: Ctrl+H hides and Ctrl+L locks; with Alt they show and unlock.
const ALT_SHORTCUTS: Record<string, string> = { h: 'Show', l: 'Unlock' }
const FUNCTION_KEYS = { F3: 'osnap', F8: 'ortho', F9: 'gridSnap' } as const
const FUNCTION_COMMANDS: Record<string, string> = { F10: 'PointsOn', F11: 'PointsOff' }

// The command line owns the keyboard: typing anywhere goes to it, as long as no other text field has focus.
document.addEventListener('keydown', (e) => {
  const inCommandLine = commandLine.hasFocus
  if (isTextEntry(e.target) && !inCommandLine) return

  if (e.key === 'Escape') {
    commandLine.clear()
    // A long kernel job stops too (the kernel starts again for the next one).
    if (kernelBusy()) cancelKernel()
    if (runner.busy) runner.cancel()
    else if (doc.selectedPointCount > 0) doc.clearPointSelection()
    else doc.clearSelection()
    return
  }
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase()
    const macro = (e.altKey ? ALT_SHORTCUTS : e.shiftKey ? SHIFT_SHORTCUTS : SHORTCUTS)[e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : key]
    // Undo, redo and select all wait for the running command; file commands may interrupt it.
    const fileCommand = key === 'n' || key === 'o' || key === 's'
    if (macro && (fileCommand || !runner.busy)) {
      e.preventDefault()
      closeMenu()
      void runner.run(macro)
    }
    return
  }
  if (e.key in FUNCTION_COMMANDS) {
    e.preventDefault()
    void runner.run(FUNCTION_COMMANDS[e.key])
    return
  }
  if (e.key in FUNCTION_KEYS) {
    e.preventDefault()
    settings.toggle(FUNCTION_KEYS[e.key as keyof typeof FUNCTION_KEYS])
    return
  }
  if (isMenuOpen()) return
  if (e.key === 'Delete' && !runner.busy && commandLine.isEmpty && (doc.selection.size > 0 || doc.selectedPointCount > 0)) {
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
  const target = e.target as Element
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) commandLine.focus()
})

commandLine.log('ArchiOpen 0.1. Type a command name, or pick one from the menus or toolbars. Enter, Space or right click repeats the last command.')
commandLine.focus()
updateTitle()

if (import.meta.env.DEV) Object.assign(window, { cad: { doc, display, runner, settings, files, history } })
