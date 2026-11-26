import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AccountManager } from './account-manager'
import type { HubNotifications } from './notifications'
import type { ViewManager } from './view-manager'
import type { PasswordManager } from './password-manager'
import type { AccountPermissions, HubState, Preferences } from './types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from './types'
import { CUSTOM_APP_ID, getCatalogApp, resolvePlatformName } from '../shared/apps'
import { cancelGoogleAuth, getGoogleIdToken } from './google-oauth'

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

const CALL_STATUS_REGEX =
  /^(incoming|voice|video|audio|call|calls|calling|whatsapp|appel|vocal|vidéo|entrant|llamada|entrante|chamada|recebida|eingehend|sprachanruf|videoanruf|answer|accept|decline|reject|atender|responder|recusar|rechazar|ablehnen|annehmen|ringing|sonando|sonnerie|dismiss|ignore|wordmark|wa-wordmark|logo|icon|button|available|now)$/i

const GENERIC_PHRASE_REGEX =
  /\b(voice and video|video and voice|calling is now available|is now available|end-to-end encrypted|end-to-end encryption|download whatsapp|use whatsapp|make calls|send and receive|keep your phone|whatsapp web|incoming call|incoming voice|incoming video|voice call|video call|audio call|appel vocal|appel vidéo|llamada de voz|videollamada|anruf|wa-wordmark|wordmark)\b/i

function sanitizeCallerName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().slice(0, 100)
  if (!trimmed || /wordmark/i.test(trimmed)) return undefined
  if (GENERIC_PHRASE_REGEX.test(trimmed)) return undefined
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(trimmed) || /^\d+$/.test(trimmed)) return undefined
  if (CALL_STATUS_REGEX.test(trimmed)) return undefined
  const words = trimmed.toLowerCase().split(/\s+/)
  const isAllStatusWords = words.every((w) => {
    const cleanedWord = w.replace(/[^\p{L}\p{N}]/gu, '')
    return !cleanedWord || CALL_STATUS_REGEX.test(cleanedWord)
  })
  if (isAllStatusWords) return undefined
  return trimmed
}

export function registerIpc(
  window: BrowserWindow,
  accounts: AccountManager,
  views: ViewManager,
  notifications: HubNotifications,
  getState: () => HubState,
  onPreferencesChanged: (preferences: Preferences) => void,
  devUrl: string | undefined,
  googleOAuthClientId?: string,
  googleOAuthClientSecret?: string,
  passwordManager?: PasswordManager
): void {
  const guard = (event: IpcMainInvokeEvent) => assertSidebar(event, window, devUrl)
  const broadcastNotifications = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('hub:notifications', accounts.getNotifications())
    }
  }
  const broadcastPasswordsUpdated = (payload?: { workspaceId?: string; accountId?: string }): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('hub:passwords-updated', payload)
    }
  }
  ipcMain.handle('hub:passwords-list', (event) => {
    guard(event)
    return passwordManager?.listSummaries(accounts.listWorkspaces(), accounts.list()) ?? []
  })
  ipcMain.handle('hub:passwords-get-password', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid credential ID.')
    if (!passwordManager) throw new Error('Password manager is not available.')
    return passwordManager.getDecryptedPassword(id.trim())
  })
  ipcMain.handle('hub:passwords-copy-password', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid credential ID.')
    if (!passwordManager) throw new Error('Password manager is not available.')
    const plain = passwordManager.getDecryptedPassword(id.trim())
    clipboard.writeText(plain)
    return true
  })
  ipcMain.handle('hub:passwords-update', (event, payload: unknown) => {
    guard(event)
    if (!passwordManager) throw new Error('Password manager is not available.')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid payload.')
    }
    const data = payload as { id?: unknown; username?: unknown; password?: unknown }
    if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('Invalid credential ID.')
    const username = typeof data.username === 'string' ? data.username : ''
    const password = typeof data.password === 'string' && data.password.trim() ? data.password : undefined
    const existingCred = passwordManager.getCredential(data.id.trim())
    const updated = passwordManager.updateCredential(data.id.trim(), username, password)
    broadcastPasswordsUpdated({ workspaceId: existingCred?.workspaceId })
    return updated
  })
  ipcMain.handle('hub:passwords-delete', (event, id: unknown) => {
    guard(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid credential ID.')
    if (!passwordManager) throw new Error('Password manager is not available.')
    const existingCred = passwordManager.getCredential(id.trim())
    const deleted = passwordManager.deleteCredential(id.trim())
    if (deleted) {
      broadcastPasswordsUpdated({ workspaceId: existingCred?.workspaceId })
    }
    return deleted
  })
  // Cloud Password Plaintext Synchronisation Channels (Local DPAPI)
  ipcMain.handle('hub:passwords-cloud-status', (event) => {
    guard(event)
    return {
      unlocked: true,
      configured: true
    }
  })
  ipcMain.handle('hub:passwords-cloud-setup', (event, masterPassword: unknown) => {
    guard(event)
    if (!passwordManager) throw new Error('Password manager is not available.')
    if (typeof masterPassword !== 'string' || masterPassword.length < 6) {
      throw new Error('Master password must be at least 6 characters long.')
    }
    const metadata = passwordManager.setupCloud(masterPassword)
    return { metadata }
  })
  ipcMain.handle('hub:passwords-cloud-unlock', (event, payload: unknown) => {
    guard(event)
    if (!passwordManager) throw new Error('Password manager is not available.')
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload.')
    const data = payload as { masterPassword?: unknown; metadata?: unknown }
    if (typeof data.masterPassword !== 'string' || !data.masterPassword) {
      throw new Error('Master password is required.')
    }
    if (!data.metadata || typeof data.metadata !== 'object') {
      throw new Error('Cloud encryption metadata is required.')
    }
    const success = passwordManager.unlockCloud(data.masterPassword, data.metadata as any)
    return { success }
  })
  ipcMain.handle('hub:passwords-cloud-lock', (event) => {
    guard(event)
    passwordManager?.lockCloud()
    return true
  })
  ipcMain.handle('hub:passwords-cloud-sync-workspace', (event, payload: unknown) => {
    guard(event)
    if (!passwordManager) throw new Error('Password manager is not available.')
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload.')
    const data = payload as { workspaceId?: unknown; remoteRecords?: unknown }
    if (typeof data.workspaceId !== 'string' || !data.workspaceId.trim()) {
      throw new Error('Workspace ID is required.')
    }
    const remoteRecords = Array.isArray(data.remoteRecords) ? (data.remoteRecords as any[]) : []
    passwordManager.reconcileWorkspaceIds(accounts.listWorkspaces(), accounts.list())
    const result = passwordManager.syncWorkspaceCredentialsWithCloud(data.workspaceId.trim(), remoteRecords)
    if (result.localUpdated) {
      broadcastPasswordsUpdated()
    }
    return result
  })
  ipcMain.handle('hub:passwords-cloud-encrypt-single', (event, credentialId: unknown) => {
    guard(event)
    if (!passwordManager) throw new Error('Password manager is not available.')
    if (typeof credentialId !== 'string' || !credentialId.trim()) {
      throw new Error('Credential ID is required.')
    }
    return passwordManager.encryptCredentialForCloud(credentialId.trim())
  })
  ipcMain.handle('hub:passwords-query-matches', (event, _payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame) return []
    const accountId = views.accountForWebContents(event.sender)
    if (!accountId) return []
    const account = accounts.get(accountId)
    if (!account || !passwordManager) return []

    const origin = senderFrame.url ? new URL(senderFrame.url).origin : ''
    if (!origin || origin.startsWith('data:') || origin.startsWith('about:')) return []

    return passwordManager.queryMatches(account.workspaceId, origin, accounts.list())
  })
  ipcMain.handle('hub:passwords-get-fill', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame) throw new Error('Unauthorized sender.')
    const accountId = views.accountForWebContents(event.sender)
    if (!accountId) throw new Error('Account not found.')
    const account = accounts.get(accountId)
    if (!account || !passwordManager) throw new Error('Account not found.')

    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload.')
    const data = payload as { id?: unknown }
    if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('Invalid ID.')

    const origin = senderFrame.url ? new URL(senderFrame.url).origin : ''
    if (!origin) throw new Error('Invalid origin.')

    return passwordManager.getFillCredential(data.id.trim(), account.workspaceId, origin)
  })
  ipcMain.on('hub:passwords-auto-save', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame) return
    const accountId = views.accountForWebContents(event.sender)
    if (!accountId) return
    const account = accounts.get(accountId)
    if (!account || !passwordManager) return

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const data = payload as { origin?: unknown; username?: unknown; password?: unknown }
    if (typeof data.password !== 'string' || !data.password.trim()) return

    const frameOrigin = senderFrame.url ? new URL(senderFrame.url).origin : ''
    if (!frameOrigin || frameOrigin.startsWith('data:') || frameOrigin.startsWith('about:')) return

    const username = typeof data.username === 'string' ? data.username.trim() : ''

    try {
      passwordManager.saveCredential(account.workspaceId, account.id, frameOrigin, username, data.password)
      broadcastPasswordsUpdated({ workspaceId: account.workspaceId, accountId: account.id })
    } catch (error) {
      console.warn('[PASSWORDS][SAVE] Auto-save failed:', error)
    }
  })
  ipcMain.handle('hub:google-auth-token', async (event) => {
    guard(event)
    return getGoogleIdToken({
      clientId: googleOAuthClientId,
      clientSecret: googleOAuthClientSecret,
      onFocusApp: () => {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          if (process.platform === 'win32') {
            window.setAlwaysOnTop(true)
            window.focus()
            window.setAlwaysOnTop(false)
          }
        }
      }
    })
  })
  ipcMain.handle('hub:google-auth-cancel', (event) => {
    guard(event)
    return cancelGoogleAuth()
  })
  ipcMain.handle('hub:get-active-call-status', (event) => {
    guard(event)
    return {
      hasActiveCall: notifications.hasActiveCalls(),
      count: notifications.getActiveCallCount()
    }
  })
  ipcMain.handle('hub:get-state', (event) => {
    guard(event)
    return getState()
  })
  ipcMain.handle('hub:set-current-user', (event, uid: unknown) => {
    guard(event)
    const userUid = typeof uid === 'string' && uid.trim() ? uid.trim() : null
    const previousUid = accounts.getCurrentUser()
    accounts.setCurrentUser(userUid)
    views.switchUser(userUid)
    if (previousUid !== userUid || userUid === null) {
      passwordManager?.lockCloud()
    }
    window.webContents.send('hub:state', getState())
    broadcastNotifications()
    broadcastPasswordsUpdated()
    return getState()
  })
  ipcMain.handle('hub:claim-workspaces', (event, uid: unknown, workspaceIds: unknown) => {
    guard(event)
    if (typeof uid !== 'string' || !uid.trim()) throw new Error('Invalid UID.')
    if (!Array.isArray(workspaceIds)) throw new Error('workspaceIds must be an array.')
    accounts.claimWorkspaces(uid.trim(), workspaceIds as string[])
    window.webContents.send('hub:state', getState())
    return true
  })
  ipcMain.handle('hub:reconcile-remote-workspaces', (event, remoteWorkspaces: unknown) => {
    guard(event)
    if (!Array.isArray(remoteWorkspaces)) return { added: [], removed: [], updated: [] }
    const result = accounts.reconcileRemoteWorkspaces(remoteWorkspaces as any)
    if (result.removed.length > 0) {
      for (const removedWsId of result.removed) {
        passwordManager?.deleteForWorkspace(removedWsId)
      }
    }
    if (result.added.length > 0 || result.removed.length > 0 || result.updated.length > 0) {
      if (!window.isDestroyed()) window.webContents.send('hub:state', getState())
    }
    return result
  })
  ipcMain.handle('hub:reconcile-remote-accounts', (event, payload: unknown) => {
    guard(event)
    if (!payload || typeof payload !== 'object') return { added: [], removed: [], updated: [] }
    const data = payload as { workspaceId?: unknown; remoteAccounts?: unknown }
    if (typeof data.workspaceId !== 'string' || !Array.isArray(data.remoteAccounts)) {
      return { added: [], removed: [], updated: [] }
    }
    return views.reconcileRemoteAccounts(data.workspaceId, data.remoteAccounts as any)
  })
  ipcMain.handle('hub:mark-account-synced', (event, accountId: unknown) => {
    guard(event)
    if (typeof accountId === 'string' && accountId.trim()) {
      accounts.markAccountSynced(accountId.trim(), true)
      return true
    }
    return false
  })
  ipcMain.handle('hub:mark-workspace-synced', (event, workspaceId: unknown) => {
    guard(event)
    if (typeof workspaceId === 'string' && workspaceId.trim()) {
      accounts.markWorkspaceSynced(workspaceId.trim(), true)
      return true
    }
    return false
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
    passwordManager?.deleteForWorkspace(id)
    accounts.deleteWorkspace(id)
    views.switchWorkspace(accounts.activeWorkspaceId())
    window.webContents.send('hub:state', getState())
    broadcastNotifications()
    broadcastPasswordsUpdated()
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
  ipcMain.handle('hub:update-account', (event, id: unknown, updates: unknown) => {
    guard(event)
    assertAccountId(id)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('Updates must be an object.')
    }
    const data = updates as { name?: unknown; url?: unknown }
    const patch: { name?: string; url?: string } = {}

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('Account name cannot be empty.')
      }
      patch.name = data.name.trim().slice(0, 40)
    }

    if (data.url !== undefined) {
      if (typeof data.url !== 'string' || !data.url.trim()) {
        throw new Error('Website URL cannot be empty.')
      }
      if (!isHttpsUrl(data.url.trim())) {
        throw new Error('Enter a valid HTTPS website URL.')
      }
      patch.url = new URL(data.url.trim()).href
    }

    const updated = views.updateAccount(id, patch)
    window.webContents.send('hub:state', getState())
    return updated
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
    passwordManager?.deleteForAccount(id)
    await views.removeAccount(id)
    broadcastNotifications()
    broadcastPasswordsUpdated()
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
    if ('accountSortBy' in candidate) {
      const sortBy = candidate.accountSortBy
      if (sortBy !== 'name' && sortBy !== 'lastUsed') {
        throw new Error(`Invalid accountSortBy: "${String(sortBy)}". Expected 'name' or 'lastUsed'.`)
      }
      patch.accountSortBy = sortBy
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
    const platformName = resolvePlatformName(account.appId, account.url)

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
      platformName,
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
    const callerName = sanitizeCallerName(candidate.callerName)

    console.log(`[CALL][IPC] Received hub:incoming-call-start for account: ${accountId} | callId: ${candidate.callId} | type: ${callType}`)

    const account = accounts.get(accountId)
    if (!account) {
      console.warn(`[CALL][IPC] Account ${accountId} not found in store`)
      return
    }

    const platformName = resolvePlatformName(account.appId, account.url)
    const isWhatsApp = account.appId === 'whatsapp' || /whatsapp/i.test(platformName) || /whatsapp\.com/i.test(account.url)
    const fallbackTitle = isWhatsApp ? 'Incoming WhatsApp Call' : (platformName && platformName !== 'Web' && platformName !== 'Web App' ? `Incoming ${platformName} Call` : 'Incoming Call')
    const callTitle = callerName || fallbackTitle

    const perms = account.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS
    if (perms.notifications === 'allow') {
      const callIdClean = candidate.callId.trim()
      const existingCalls = accounts.getNotifications()
      const existingCall = existingCalls.find(
        (n) => n.type === 'call' && n.tag === callIdClean && n.accountId === accountId
      )
      if (!existingCall) {
        const workspace = accounts.getWorkspace(account.workspaceId)
        accounts.addNotification({
          workspaceId: account.workspaceId,
          workspaceName: workspace?.name ?? 'Workspace',
          accountId: account.id,
          accountName: account.name,
          accountAppId: account.appId,
          platformName,
          type: 'call',
          title: callTitle,
          body: callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call',
          callType,
          tag: callIdClean
        })
        broadcastNotifications()
      } else if (
        callerName &&
        (existingCall.title === fallbackTitle ||
          /wordmark/i.test(existingCall.title) ||
          GENERIC_PHRASE_REGEX.test(existingCall.title))
      ) {
        accounts.updateCallNotificationCaller(callIdClean, accountId, callerName)
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
  ipcMain.on('hub:incoming-call-update', (event, payload: unknown) => {
    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== event.sender.mainFrame) {
      console.warn('[CALL][IPC] Rejected incoming-call-update: sender frame is not the main frame')
      return
    }
    const accountId = views.accountForWebContents(event.sender)
    const frameUrl = senderFrame.url ?? ''
    if (!accountId || !views.isAccountOrigin(accountId, frameUrl)) {
      console.warn(`[CALL][IPC] Rejected incoming-call-update: untrusted frame or unknown account (origin: "${frameUrl}", accountId: ${accountId})`)
      return
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return
    }
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.callId !== 'string' || !candidate.callId.trim() || candidate.callId.length > 100) {
      return
    }
    const callIdClean = candidate.callId.trim()
    const validCaller = sanitizeCallerName(candidate.callerName)
    if (validCaller) {
      console.log(`[CALL][IPC] Updating caller name for callId: ${callIdClean} to: ${validCaller}`)
      const updated = accounts.updateCallNotificationCaller(callIdClean, accountId, validCaller)
      if (updated) {
        broadcastNotifications()
      }
    }
  })
}
