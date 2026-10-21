import { t } from './language'
import { version } from '../../package.json'

/**
 * Updates of the desktop app, from the project's GitHub releases: each release publishes a signed
 * description of itself (latest.json), and the app checks it, asks, downloads, verifies the
 * signature against the key built into it, installs, and starts again.
 */

const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Looks for a newer version and offers to install it. `quiet` (the check at start) says nothing when
 * there is none or the check fails (no internet, say).
 */
export async function checkForUpdates(log: (text: string) => void, unsavedChanges: () => boolean, quiet = false): Promise<void> {
  if (!isDesktop) {
    if (!quiet) log('Updates are for the desktop app; the web version is always the latest')
    return
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      if (!quiet) log(`ArchiOpen ${version} is the latest version`)
      return
    }
    const { ask } = await import('@tauri-apps/plugin-dialog')
    const unsaved = unsavedChanges() ? `\n\n${t('The model has unsaved changes: save it first, or choose Later.')}` : ''
    const install = await ask(`${t('ArchiOpen {version} is available (this is {current}). Install it now? ArchiOpen restarts to finish.', { version: update.version, current: update.currentVersion })}${unsaved}`, {
      title: t('Update available'),
      kind: 'info',
      okLabel: t('Install'),
      cancelLabel: t('Later'),
    })
    if (!install) {
      log(`ArchiOpen ${update.version} is available: Help > Check for Updates installs it`)
      return
    }
    log(`Downloading ArchiOpen ${update.version}…`)
    await update.downloadAndInstall()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    if (!quiet) log(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`)
  }
}
