import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AccountManager } from './account-manager'
import type { HubNotifications } from './notifications'
import type { ViewManager } from './view-manager'
import type { HubState, Preferences } from './types'
import { CUSTOM_APP_ID, getCatalogApp } from '../shared/apps'
import { getGoogleIdToken } from './google-oauth'

const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertSidebar(event: IpcMainInvokeEvent, window: BrowserWindow, devUrl?: string): void {
  if (event.sender !== window.webContents) throw new Error('Unauthorized IPC sender.')
  const senderUrl = event.senderFrame?.url ?? ''
  let valid = false
  if (devUrl?.startsWith('file:')) {
    valid = senderUrl.startsWith(devUrl)
  } else if (devUrl) {
    try {
      valid = new URL(senderUrl).origin === new URL(devUrl).origin
    } catch {
      valid = false
    }
  } else {
    valid = senderUrl.startsWith('file://')
  }
  if (!valid) throw new Error('IPC sender origin is not trusted.')
}

function assertAccountId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !accountIdPattern.test(id)) throw new Error('Invalid account id.')
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) {
    throw new Error('Account name must be between 1 and 100 characters.')
  }
}

function isHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export function registerIpc(
  window: BrowserWindow,
  accounts: AccountManager,
  views: ViewManager,
  notifications: HubNotifications,
  getState: () => HubState,
  onPreferencesChanged: (preferences: Preferences) => void,
  devUrl: string | undefined,
  googleOAuthClientId: string
): void {
  const guard = (event: IpcMainInvokeEvent) => assertSidebar(event, window, devUrl)
  ipcMain.handle('hub:google-auth-token', async (event) => {
    guard(event)
    return getGoogleIdToken(googleOAuthClientId)
  })
  ipcMain.handle('hub:get-state', (event) => {
    guard(event)
    return getState()
  })
  ipcMain.handle('hub:add-account', (event, value: unknown) => {
    guard(event)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account.')
    const candidate = value as Record<string, unknown>
    assertName(candidate.name)
    if (typeof candidate.appId !== 'string') throw new Error('Select an app or website.')
    if (candidate.appId === CUSTOM_APP_ID) {
      if (!isHttpsUrl(candidate.url)) throw new Error('Enter a valid HTTPS website URL.')
      return views.addAccount(candidate.name, CUSTOM_APP_ID, new URL(candidate.url).href)
    }
    const app = getCatalogApp(candidate.appId)
    if (!app) throw new Error('Select an app or website.')
    return views.addAccount(candidate.name, app.id, app.url)
  })
  ipcMain.handle('hub:activate-account', (event, id: unknown) => {
    guard(event)
    assertAccountId(id)
    views.activate(id)
  })
  ipcMain.handle('hub:rename-account', (event, id: unknown, name: unknown) => {
    guard(event)
    assertAccountId(id)
    assertName(name)
    return views.rename(id, name)
  })
  ipcMain.handle('hub:set-muted', (event, id: unknown, muted: unknown) => {
    guard(event)
    assertAccountId(id)
    if (typeof muted !== 'boolean') throw new Error('Muted must be a boolean.')
    const account = views.setMuted(id, muted)
    window.webContents.send('hub:state', getState())
    return account
  })
  ipcMain.handle('hub:reload-account', (event, id: unknown) => {
    guard(event)
    assertAccountId(id)
    views.reload(id)
  })
  ipcMain.handle('hub:clear-cache', async (event, id: unknown) => {
    guard(event)
    assertAccountId(id)
    await views.clearCache(id)
  })
  ipcMain.handle('hub:remove-account', async (event, id: unknown) => {
    guard(event)
    assertAccountId(id)
    await views.removeAccount(id)
  })
  ipcMain.handle('hub:update-preferences', (event, value: unknown) => {
    guard(event)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preferences.')
    const candidate = value as Record<string, unknown>
    const patch: Partial<Preferences> = {}
    for (const key of ['doNotDisturb', 'minimizeToTray', 'launchAtStartup'] as const) {
      if (key in candidate) {
        if (typeof candidate[key] !== 'boolean') throw new Error(`Invalid preference: ${key}.`)
        patch[key] = candidate[key]
      }
    }
    const preferences = accounts.updatePreferences(patch)
    onPreferencesChanged(preferences)
    return preferences
  })
  ipcMain.on('hub:set-sidebar-overlay', (event, active: unknown) => {
    if (event.sender !== window.webContents) {
      console.warn('Rejected sidebar-overlay IPC from an untrusted sender.')
      return
    }
    if (typeof active !== 'boolean') {
      console.warn('Rejected sidebar-overlay IPC with an invalid value.')
      return
    }
    views.setSidebarOverlayActive(active)
  })
  ipcMain.on('social:notification-click', (event) => {
    const accountId = views.accountForWebContents(event.sender)
    if (!accountId || !views.isAccountOrigin(accountId, event.senderFrame?.url ?? '')) {
      console.warn('Rejected notification-click IPC from an untrusted frame.')
      return
    }
    notifications.focusAccount(accountId)
  })
}
