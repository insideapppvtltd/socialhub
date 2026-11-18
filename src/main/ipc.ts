import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AccountManager } from './account-manager'
import type { HubNotifications } from './notifications'
import type { ViewManager } from './view-manager'
import type { AccountPermissions, HubState, Preferences } from './types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from './types'
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
  const broadcastNotifications = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('hub:notifications', accounts.getNotifications())
    }
  }
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
    let workspaceId: string | undefined
    if (candidate.workspaceId !== undefined) {
      if (typeof candidate.workspaceId !== 'string' || !candidate.workspaceId.trim()) {
        throw new Error('Invalid workspace ID.')
      }
      workspaceId = candidate.workspaceId.trim()
    }
    if (candidate.appId === CUSTOM_APP_ID) {
      if (!isHttpsUrl(candidate.url)) throw new Error('Enter a valid HTTPS website URL.')
      return views.addAccount(
        candidate.name,
        CUSTOM_APP_ID,
        new URL(candidate.url).href,
        workspaceId,
        candidate.permissions as Partial<AccountPermissions> | undefined
      )
    }
    const app = getCatalogApp(candidate.appId)
    if (!app) throw new Error('Select an app or website.')
    return views.addAccount(
      candidate.name,
      app.id,
      app.url,
      workspaceId,
      candidate.permissions as Partial<AccountPermissions> | undefined
    )
  })
  ipcMain.handle('hub:add-workspace', (event, name: unknown) => {
    guard(event)
    assertName(name)
    const workspace = accounts.addWorkspace(name)
    window.webContents.send('hub:state', getState())
    return workspace
  })
  ipcMain.handle('hub:rename-workspace', (event, id: unknown, name: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid workspace ID.')
    assertName(name)
    const workspace = accounts.renameWorkspace(id, name)
    window.webContents.send('hub:state', getState())
    return workspace
  })
  ipcMain.handle('hub:delete-workspace', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid workspace ID.')
    accounts.deleteWorkspace(id)
    views.switchWorkspace(accounts.activeWorkspaceId())
    window.webContents.send('hub:state', getState())
    broadcastNotifications()
  })
  ipcMain.handle('hub:activate-workspace', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid workspace ID.')
    views.switchWorkspace(id)
    window.webContents.send('hub:state', getState())
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
  ipcMain.handle('hub:set-account-permissions', (event, id: unknown, permissions: unknown) => {
    guard(event)
    assertAccountId(id)
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('Permissions must be an object.')
    }
    const account = views.setAccountPermissions(id, permissions as Partial<AccountPermissions>)
    window.webContents.send('hub:state', getState())
    return account
  })
  ipcMain.handle('hub:get-global-default-permissions', (event) => {
    guard(event)
    return accounts.getGlobalDefaultPermissions()
  })
  ipcMain.handle('hub:update-global-default-permissions', (event, permissions: unknown) => {
    guard(event)
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('Permissions must be an object.')
    }
    const updated = accounts.updateGlobalDefaultPermissions(permissions as Partial<AccountPermissions>)
    window.webContents.send('hub:state', getState())
    return updated
  })
  ipcMain.handle('hub:reset-global-default-permissions', (event) => {
    guard(event)
    const reset = accounts.resetGlobalDefaultPermissions()
    window.webContents.send('hub:state', getState())
    return reset
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
    broadcastNotifications()
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
    if ('theme' in candidate) {
      const theme = candidate.theme
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') {
        throw new Error(`Invalid theme: "${String(theme)}". Expected 'system', 'light', or 'dark'.`)
      }
      patch.theme = theme
    }
    const preferences = accounts.updatePreferences(patch)
    onPreferencesChanged(preferences)
    return preferences
  })
  ipcMain.handle('hub:get-notifications', (event) => {
    guard(event)
    return accounts.getNotifications()
  })
  ipcMain.handle('hub:mark-notification-read', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim() || id.length > 100) {
      throw new Error('Invalid notification id.')
    }
    accounts.markNotificationRead(id)
    broadcastNotifications()
  })
  ipcMain.handle('hub:mark-all-notifications-read', (event) => {
    guard(event)
    accounts.markAllNotificationsRead()
    broadcastNotifications()
  })
  ipcMain.handle('hub:remove-notification', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim() || id.length > 100) {
      throw new Error('Invalid notification id.')
    }
    accounts.removeNotification(id)
    broadcastNotifications()
  })
  ipcMain.handle('hub:clear-notifications', (event) => {
    guard(event)
    accounts.clearNotifications()
    broadcastNotifications()
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
  ipcMain.on('social:chat-notification', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== event.sender.mainFrame) {
      console.warn('Rejected chat-notification IPC: sender frame is not the main frame.')
      return
    }
    const accountId = views.accountForWebContents(event.sender)
    const frameUrl = senderFrame.url ?? ''
    if (!accountId || !views.isAccountOrigin(accountId, frameUrl)) {
      console.warn('Rejected chat-notification IPC: untrusted frame or unknown account.')
      return
    }
    const account = accounts.get(accountId)
    if (!account) return

    const perms = account.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS
    if (perms.notifications !== 'allow') {
      return
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const candidate = payload as Record<string, unknown>
    const title = typeof candidate.title === 'string' ? candidate.title.trim().slice(0, 100) : ''
    if (!title) return
    const body = typeof candidate.body === 'string' ? candidate.body.trim().slice(0, 300) : ''
    const tag = typeof candidate.tag === 'string' ? candidate.tag.trim().slice(0, 100) : undefined

    const workspace = accounts.getWorkspace(account.workspaceId)
    const workspaceName = workspace?.name ?? 'Workspace'

    const recent = accounts.getNotifications()
    const isDuplicate = recent.slice(0, 10).some(
      (n) =>
        n.accountId === accountId &&
        n.type === 'chat' &&
        n.title === title &&
        n.body === body &&
        Math.abs(Date.now() - n.timestamp) < 2000
    )
    if (isDuplicate) return

    accounts.addNotification({
      workspaceId: account.workspaceId,
      workspaceName,
      accountId: account.id,
      accountName: account.name,
      accountAppId: account.appId,
      type: 'chat',
      title,
      body,
      tag
    })

    broadcastNotifications()
  })
  ipcMain.on('hub:incoming-call-start', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== event.sender.mainFrame) {
      console.warn('[CALL][IPC] Rejected incoming-call-start: sender frame is not the main frame')
      return
    }
    const accountId = views.accountForWebContents(event.sender)
    const frameUrl = senderFrame.url ?? ''
    if (!accountId || !views.isAccountOrigin(accountId, frameUrl)) {
      console.warn(`[CALL][IPC] Rejected incoming-call-start: untrusted frame or unknown account (origin: "${frameUrl}", accountId: ${accountId})`)
      return
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.warn('[CALL][IPC] Rejected incoming-call-start: payload is not a valid object')
      return
    }
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.callId !== 'string' || !candidate.callId.trim() || candidate.callId.length > 100) {
      console.warn('[CALL][IPC] Rejected incoming-call-start: invalid callId')
      return
    }
    const callType: 'voice' | 'video' = candidate.callType === 'video' ? 'video' : 'voice'
    const callerName = typeof candidate.callerName === 'string' && candidate.callerName.trim()
      ? candidate.callerName.trim().slice(0, 100)
      : undefined

    console.log(`[CALL][IPC] Received hub:incoming-call-start for account: ${accountId} | callId: ${candidate.callId} | type: ${callType}`)

    const account = accounts.get(accountId)
    if (!account) {
      console.warn(`[CALL][IPC] Account ${accountId} not found in store`)
      return
    }

    const perms = account.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS
    if (perms.notifications === 'allow') {
      const callIdClean = candidate.callId.trim()
      const existingCalls = accounts.getNotifications()
      const alreadyRecorded = existingCalls.some(
        (n) => n.type === 'call' && n.tag === callIdClean && n.accountId === accountId
      )
      if (!alreadyRecorded) {
        const workspace = accounts.getWorkspace(account.workspaceId)
        accounts.addNotification({
          workspaceId: account.workspaceId,
          workspaceName: workspace?.name ?? 'Workspace',
          accountId: account.id,
          accountName: account.name,
          accountAppId: account.appId,
          type: 'call',
          title: callerName ?? account.name,
          body: callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call',
          callType,
          tag: callIdClean
        })
        broadcastNotifications()
      }
    }

    const eligible = views.areNotificationsEnabled(accountId)
    if (!eligible) {
      const reason = account.muted
        ? 'Account is muted'
        : accounts.preferences().doNotDisturb
          ? 'Do Not Disturb is active'
          : perms.notifications !== 'allow'
            ? 'Notification permission is blocked'
            : 'Notifications disabled'
      console.log(`[CALL][ELIGIBILITY] Notification suppressed for account ${accountId}: ${reason}`)
      return
    }

    console.log(`[CALL][ELIGIBILITY] Account ${accountId} is eligible for incoming call notification`)
    notifications.showIncomingCall(account, {
      callId: candidate.callId.trim(),
      callerName,
      callType
    })
  })
  ipcMain.on('hub:incoming-call-end', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== event.sender.mainFrame) {
      console.warn('[CALL][IPC] Rejected incoming-call-end: sender frame is not the main frame')
      return
    }
    const accountId = views.accountForWebContents(event.sender)
    const frameUrl = senderFrame.url ?? ''
    if (!accountId || !views.isAccountOrigin(accountId, frameUrl)) {
      console.warn(`[CALL][IPC] Rejected incoming-call-end: untrusted frame or unknown account (origin: "${frameUrl}", accountId: ${accountId})`)
      return
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.warn('[CALL][IPC] Rejected incoming-call-end: payload is not a valid object')
      return
    }
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.callId !== 'string' || !candidate.callId.trim() || candidate.callId.length > 100) {
      console.warn('[CALL][IPC] Rejected incoming-call-end: invalid callId')
      return
    }
    const callId = candidate.callId.trim()

    console.log(`[CALL][IPC] Received hub:incoming-call-end for account: ${accountId} | callId: ${callId}`)
    notifications.dismissIncomingCall(accountId, callId)
  })
}
