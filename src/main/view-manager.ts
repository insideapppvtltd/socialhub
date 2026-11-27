import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  Menu,
  session,
  shell,
  systemPreferences,
  WebContentsView,
  type BrowserWindow,
  type DownloadItem,
  type Session,
  type WebContents
} from 'electron'
import path from 'node:path'
import { AccountManager } from './account-manager'
import { HubNotifications } from './notifications'
import { SIDEBAR_WIDTH, NAV_BAR_HEIGHT } from '../shared/layout'
import { APP_CATALOG, resolvePlatformName, resolveCatalogAppId } from '../shared/apps'
import type { Account, AccountNavigationState, AccountPermissions, DownloadUpdate } from './types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from './types'

const DEFAULT_APP = APP_CATALOG[0]
const userAgentPlatform =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
const CHROME_USER_AGENT = `Mozilla/5.0 (${userAgentPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'display-capture',
  'geolocation'
])
const externalProtocols = new Set(['mailto:'])

function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function matchesOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === new URL(expected).origin
  } catch {
    return false
  }
}

const AUTH_PROVIDER_HOSTS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'auth0.com',
  'okta.com'
])

function isSameAppFamily(accountUrl: string, targetUrl: string): boolean {
  try {
    const accHost = new URL(accountUrl).hostname.toLowerCase().replace(/^www\./, '')
    const targetHost = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, '')
    const baseAccHost = accHost.replace(/^(web|app|mail|teams|chat|mobile)\./, '')
    if (targetHost === accHost || targetHost.endsWith(`.${accHost}`)) return true
    if (baseAccHost && (targetHost === baseAccHost || targetHost.endsWith(`.${baseAccHost}`))) return true
    // WhatsApp also uses whatsapp.net for media/auth/static links
    if (baseAccHost === 'whatsapp.com' && (targetHost === 'whatsapp.net' || targetHost.endsWith('.whatsapp.net'))) {
      return true
    }
    return false
  } catch {
    return false
  }
}

function isAuthFlowUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl)
    const host = parsed.hostname.toLowerCase()
    if (AUTH_PROVIDER_HOSTS.has(host)) return true
    if (host === 'github.com' && (parsed.pathname.startsWith('/login') || parsed.pathname.startsWith('/sessions'))) {
      return true
    }
    if (
      host.endsWith('.okta.com') ||
      host.endsWith('.auth0.com') ||
      host.startsWith('login.') ||
      host.startsWith('sso.') ||
      host.startsWith('oauth.') ||
      host.startsWith('auth.')
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>()
  private readonly tempViews = new Map<string, WebContentsView>()
  private readonly sessions = new Map<string, Session>()
  private activeId: string | null = null
  private sidebarOverlayActive = false
  private readonly unread = new Map<string, number>()
  private readonly unsupported = new Set<string>()
  private readonly navStates = new Map<string, AccountNavigationState>()
  private readonly bounds = { x: SIDEBAR_WIDTH, y: 0, width: 0, height: 0 }

  constructor(
    private readonly window: BrowserWindow,
    private readonly accounts: AccountManager,
    private readonly notifications: HubNotifications,
    private readonly onStateChanged: () => void,
    private readonly onDownload: (update: DownloadUpdate) => void,
    private readonly onNotificationsChanged?: () => void
  ) {}

  async initialize(): Promise<void> {
    const accounts = this.accounts.list()
    for (const account of accounts) this.createView(account)
    const activeWorkspaceId = this.accounts.activeWorkspaceId()
    const workspaceAccounts = activeWorkspaceId ? accounts.filter((a) => a.workspaceId === activeWorkspaceId) : []
    const savedActiveId = this.accounts.activeId()
    const targetId = workspaceAccounts.some((a) => a.id === savedActiveId)
      ? savedActiveId
      : workspaceAccounts[0]?.id ?? null
    if (targetId) {
      this.activate(targetId)
    } else {
      this.activeId = null
      this.onStateChanged()
    }
  }

  listAccounts(): Account[] {
    return this.accounts.list().map((account) => ({
      ...account,
      unread: this.unread.get(account.id) ?? 0
    }))
  }

  activeAccountId(): string | null {
    return this.activeId
  }

  accountForWebContents(contents: WebContents): string | undefined {
    const primary = [...this.views].find(([, view]) => view.webContents === contents)?.[0]
    if (primary) return primary
    return [...this.tempViews].find(([, view]) => view.webContents === contents)?.[0]
  }

  isAccountOrigin(id: string, raw: string): boolean {
    const account = this.accounts.get(id)
    return Boolean(account && matchesOrigin(raw, account.url))
  }

  areNotificationsEnabled(accountId: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) return false
    const perms = account.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS
    return !account.muted && !this.accounts.preferences().doNotDisturb && perms.notifications === 'allow'
  }

  private syncViewVisibility(): void {
    for (const [accountId, view] of this.views) {
      const isActive = accountId === this.activeId && !this.sidebarOverlayActive
      const tempView = this.tempViews.get(accountId)
      if (isActive && tempView) {
        view.setVisible(false)
        tempView.setVisible(true)
      } else {
        view.setVisible(isActive)
        if (tempView) tempView.setVisible(false)
      }
    }
  }

  activate(id: string): void {
    if (!this.views.has(id)) throw new Error('Account view not found.')
    const account = this.accounts.get(id)
    if (account?.workspaceId && this.accounts.getWorkspace(account.workspaceId)) {
      if (this.accounts.activeWorkspaceId() !== account.workspaceId) {
        this.accounts.setActiveWorkspace(account.workspaceId)
      }
    }
    this.sidebarOverlayActive = false
    this.activeId = id
    this.syncViewVisibility()
    this.accounts.setActive(id)
    this.updateNavigationState(id)
    this.onStateChanged()
  }

  switchUser(uid: string | null): void {
    for (const view of this.views.values()) {
      view.setVisible(false)
    }
    for (const tempView of this.tempViews.values()) {
      tempView.setVisible(false)
    }
    this.activeId = null
    this.accounts.setActive('')

    if (!uid) {
      this.destroyAllTemporaryViews()
      this.onStateChanged()
      return
    }

    const accounts = this.accounts.list()
    for (const account of accounts) {
      if (!this.views.has(account.id)) {
        this.createView(account)
      }
    }

    const activeWorkspaceId = this.accounts.activeWorkspaceId()
    if (!activeWorkspaceId) {
      this.onStateChanged()
      return
    }

    const workspaceAccounts = accounts.filter((a) => a.workspaceId === activeWorkspaceId)
    const savedActiveId = this.accounts.activeId()
    const targetId = workspaceAccounts.some((a) => a.id === savedActiveId)
      ? savedActiveId
      : workspaceAccounts[0]?.id ?? null

    if (targetId) {
      this.activate(targetId)
    } else {
      this.onStateChanged()
    }
  }

  switchWorkspace(workspaceId: string | null): void {
    if (!workspaceId) {
      this.activeId = null
      this.syncViewVisibility()
      this.accounts.setActive('')
      this.onStateChanged()
      return
    }

    this.accounts.setActiveWorkspace(workspaceId)
    const workspaceAccounts = this.accounts.list().filter((a) => a.workspaceId === workspaceId)
    const currentActiveId = this.accounts.activeId()
    const targetId = workspaceAccounts.some((a) => a.id === currentActiveId)
      ? currentActiveId
      : workspaceAccounts[0]?.id ?? null

    if (targetId) {
      this.activate(targetId)
    } else {
      this.activeId = null
      this.syncViewVisibility()
      this.accounts.setActive('')
      this.onStateChanged()
    }
  }

  setSidebarOverlayActive(active: boolean): void {
    if (this.sidebarOverlayActive === active) return
    this.sidebarOverlayActive = active
    this.syncViewVisibility()
  }

  addAccount(
    name: string,
    appId: string,
    url: string,
    workspaceId?: string,
    permissions?: Partial<AccountPermissions>
  ): Account {
    const account = this.accounts.add(name, appId, url, workspaceId, permissions)
    this.createView(account)
    if (this.accounts.activeWorkspaceId() !== account.workspaceId) {
      this.accounts.setActiveWorkspace(account.workspaceId)
    }
    this.activate(account.id)
    return { ...account, unread: 0 }
  }

  async removeAccount(id: string): Promise<void> {
    const account = this.accounts.get(id)
    if (!account) throw new Error('Account not found.')
    this.destroyTemporaryView(id)
    const view = this.views.get(id)
    const accountSession = this.sessions.get(id)
    view?.setVisible(false)
    if (view) {
      this.window.contentView.removeChildView(view)
      view.webContents.close()
    }
    if (accountSession) {
      try {
        await accountSession.clearStorageData()
        await accountSession.clearCache()
      } catch (error) {
        this.views.delete(id)
        this.createView(account)
        this.activate(id)
        throw error
      }
    }
    this.views.delete(id)
    this.sessions.delete(id)
    this.unread.delete(id)
    this.unsupported.delete(id)
    this.navStates.delete(id)
    this.notifications.dismissAllCallsForAccount(id)
    this.accounts.remove(id)
    const nextId = this.accounts.activeId()
    this.activeId = null
    if (nextId) {
      this.activate(nextId)
    } else {
      this.syncViewVisibility()
      this.onStateChanged()
    }
  }

  removeAccountQuietly(id: string): void {
    const account = this.accounts.get(id)
    if (!account) return
    this.destroyTemporaryView(id)
    const view = this.views.get(id)
    view?.setVisible(false)
    if (view) {
      try {
        this.window.contentView.removeChildView(view)
        view.webContents.close()
      } catch {}
    }
    this.views.delete(id)
    this.sessions.delete(id)
    this.unread.delete(id)
    this.unsupported.delete(id)
    this.navStates.delete(id)
    this.notifications.dismissAllCallsForAccount(id)
    this.accounts.remove(id)
    if (this.activeId === id) {
      const nextId = this.accounts.activeId()
      this.activeId = null
      if (nextId) this.activate(nextId)
      else {
        this.syncViewVisibility()
        this.onStateChanged()
      }
    }
  }

  destroyAllTemporaryViews(): void {
    for (const accountId of [...this.tempViews.keys()]) {
      this.destroyTemporaryView(accountId)
    }
  }

  private destroyTemporaryView(accountId: string): void {
    const tempView = this.tempViews.get(accountId)
    if (!tempView) return
    this.tempViews.delete(accountId)
    try {
      tempView.setVisible(false)
      if (!this.window.isDestroyed()) {
        this.window.contentView.removeChildView(tempView)
      }
      if (!tempView.webContents.isDestroyed()) {
        tempView.webContents.close()
      }
    } catch {}
  }

  reconcileRemoteAccounts(
    workspaceId: string,
    remoteApps: Array<{ ws_app_id: string; ws_app_name: string; ws_app_link: string }>
  ): { added: string[]; removed: string[]; updated: string[] } {
    const added: string[] = []
    const removed: string[] = []
    const updated: string[] = []

    const allAccounts = this.accounts.getRawStoreAccounts()
    const localInWs = allAccounts.filter((a) => a.workspaceId === workspaceId)
    const remoteMap = new Map(remoteApps.filter((a) => a.ws_app_id).map((a) => [a.ws_app_id, a]))

    // 1. Process local apps: update modified or remove deleted
    for (const localAcc of localInWs) {
      const remote = remoteMap.get(localAcc.id)
      if (remote) {
        const nameChanged = remote.ws_app_name && remote.ws_app_name.trim() !== localAcc.name
        const urlChanged = remote.ws_app_link && remote.ws_app_link.trim() !== localAcc.url
        if (nameChanged || urlChanged) {
          try {
            this.updateAccount(localAcc.id, {
              name: remote.ws_app_name ? remote.ws_app_name.trim() : undefined,
              url: remote.ws_app_link ? remote.ws_app_link.trim() : undefined
            })
            updated.push(localAcc.id)
          } catch (e) {
            console.warn(`[VIEW_MANAGER] Could not update app ${localAcc.id}:`, e)
          }
        }
        if (!localAcc.syncedToCloud) {
          this.accounts.markAccountSynced(localAcc.id, true)
        }
      } else {
        // Not in remote: if already synced to cloud, it was deleted remotely!
        if (localAcc.syncedToCloud) {
          this.removeAccountQuietly(localAcc.id)
          removed.push(localAcc.id)
        }
      }
    }

    // 2. Add remote apps not present locally
    for (const remote of remoteApps) {
      if (!remote.ws_app_id) continue
      const exists = localInWs.some((a) => a.id === remote.ws_app_id)
      if (!exists) {
        try {
          const imported = this.accounts.addWithId(
            remote.ws_app_id,
            remote.ws_app_name || 'App',
            resolveCatalogAppId(remote.ws_app_link),
            remote.ws_app_link,
            workspaceId,
            { syncedToCloud: true }
          )
          this.createView(imported)
          added.push(remote.ws_app_id)
        } catch (e) {
          console.warn(`[VIEW_MANAGER] Could not import remote app ${remote.ws_app_id}:`, e)
        }
      }
    }

    if (added.length > 0 || removed.length > 0 || updated.length > 0) {
      this.onStateChanged()
    }

    return { added, removed, updated }
  }

  rename(id: string, name: string): Account {
    const account = { ...this.accounts.rename(id, name), unread: this.unread.get(id) ?? 0 }
    this.updateAccountLabel(id, account.name)
    this.onStateChanged()
    return account
  }

  updateAccount(id: string, updates: { name?: string; url?: string }): Account {
    const existing = this.accounts.get(id)
    if (!existing) throw new Error('Account not found.')

    const previousUrl = existing.url
    const updatedStored = this.accounts.updateAccount(id, updates)
    const account: Account = { ...updatedStored, unread: this.unread.get(id) ?? 0 }

    if (updates.name) {
      this.updateAccountLabel(id, account.name)
    }

    const view = this.views.get(id)
    if (view && !view.webContents.isDestroyed() && updates.url) {
      try {
        const oldParsed = new URL(previousUrl)
        const newParsed = new URL(account.url)
        if (oldParsed.href !== newParsed.href) {
          void view.webContents.loadURL(account.url)
        }
      } catch {
        if (previousUrl !== account.url) {
          void view.webContents.loadURL(account.url)
        }
      }
    }

    this.onStateChanged()
    return account
  }

  setMuted(id: string, muted: boolean): Account {
    const updated = this.accounts.setMuted(id, muted)
    if (muted) {
      this.notifications.dismissAllCallsForAccount(id)
    }
    this.onStateChanged()
    return { ...updated, unread: this.unread.get(id) ?? 0 }
  }

  setAccountPermissions(id: string, permissions: Partial<AccountPermissions>): Account {
    const updated = this.accounts.updatePermissions(id, permissions)
    if (permissions.notifications === 'block') {
      this.notifications.dismissAllCallsForAccount(id)
    }
    this.onStateChanged()
    return { ...updated, unread: this.unread.get(id) ?? 0 }
  }

  updateAccountLabel(id: string, name: string): void {
    const view = this.views.get(id)
    if (view && !view.webContents.isDestroyed()) {
      void this.installNotificationSupport(id, name, view.webContents)
    }
  }

  reload(id: string): void {
    const tempView = this.tempViews.get(id)
    if (tempView && !tempView.webContents.isDestroyed()) {
      tempView.webContents.reload()
      this.updateNavigationState(id)
      return
    }
    const view = this.requireView(id)
    if (!view.webContents.isDestroyed()) {
      view.webContents.reload()
      this.updateNavigationState(id)
    }
  }

  getAccountNavigationState(id: string): AccountNavigationState | null {
    const tempView = this.tempViews.get(id)
    if (tempView && !tempView.webContents.isDestroyed()) {
      return this.updateNavigationState(id)
    }
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) {
      return this.navStates.get(id) ?? null
    }
    return this.updateNavigationState(id)
  }

  goBack(id: string): boolean {
    const tempView = this.tempViews.get(id)
    if (!tempView || tempView.webContents.isDestroyed()) return false
    const contents = tempView.webContents
    const canBack = contents.navigationHistory ? contents.navigationHistory.canGoBack() : contents.canGoBack()
    if (canBack) {
      if (contents.navigationHistory) {
        contents.navigationHistory.goBack()
      } else {
        contents.goBack()
      }
      this.updateNavigationState(id)
      return true
    }
    // No previous external page: close the temporary view and reveal the untouched original account view
    this.closeTemporaryView(id)
    return true
  }

  goForward(id: string): boolean {
    const tempView = this.tempViews.get(id)
    if (!tempView || tempView.webContents.isDestroyed()) return false
    const contents = tempView.webContents
    const canFwd = contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward()
    if (!canFwd) return false
    if (contents.navigationHistory) {
      contents.navigationHistory.goForward()
    } else {
      contents.goForward()
    }
    this.updateNavigationState(id)
    return true
  }

  stopLoading(id: string): boolean {
    const tempView = this.tempViews.get(id)
    const targetView = tempView && !tempView.webContents.isDestroyed() ? tempView : this.views.get(id)
    if (!targetView || targetView.webContents.isDestroyed()) return false
    targetView.webContents.stop()
    this.updateNavigationState(id)
    return true
  }

  copyAccountUrl(id: string): string | null {
    const tempView = this.tempViews.get(id)
    const targetView = tempView && !tempView.webContents.isDestroyed() ? tempView : this.views.get(id)
    const fallbackUrl = this.accounts.get(id)?.url ?? null
    const currentUrl =
      targetView && !targetView.webContents.isDestroyed() ? targetView.webContents.getURL() || fallbackUrl : fallbackUrl
    if (!currentUrl) return null
    clipboard.writeText(currentUrl)
    return currentUrl
  }

  closeTemporaryView(accountId: string): void {
    if (!this.tempViews.has(accountId)) return
    this.destroyTemporaryView(accountId)
    this.syncViewVisibility()
    this.updateNavigationState(accountId)
  }

  private openTemporaryExternalView(accountId: string, url: string): void {
    if (!isHttpsUrl(url)) return
    const account = this.accounts.get(accountId)
    if (!account) return

    const existingTemp = this.tempViews.get(accountId)
    if (existingTemp && !existingTemp.webContents.isDestroyed()) {
      this.syncViewVisibility()
      void existingTemp.webContents.loadURL(url)
      this.updateNavigationState(accountId)
      return
    }
    if (existingTemp) {
      this.destroyTemporaryView(accountId)
    }

    const partition = `persist:account-${account.id}`
    const existingSession = this.sessions.get(account.id)
    const accountSession = existingSession ?? session.fromPartition(partition)
    if (!existingSession) {
      accountSession.setUserAgent(CHROME_USER_AGENT)
      accountSession.setSpellCheckerEnabled(true)
      this.configureSession(account.id, accountSession)
      this.sessions.set(account.id, accountSession)
    }

    const tempView = new WebContentsView({
      webPreferences: {
        session: accountSession,
        preload: path.join(__dirname, '../preload/site.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true
      }
    })
    tempView.setBackgroundColor('#ffffff')
    tempView.setBounds(this.getTempBounds())
    tempView.setVisible(false)
    this.window.contentView.addChildView(tempView)
    this.tempViews.set(accountId, tempView)
    this.configureTempWebContents(accountId, tempView.webContents)
    this.syncViewVisibility()
    void tempView.webContents.loadURL(url)
    this.updateNavigationState(accountId)
  }

  private isExternalUrlForAccount(accountId: string, url: string): boolean {
    if (!isHttpsUrl(url)) return false
    const account = this.accounts.get(accountId)
    if (!account) return false
    if (isSameAppFamily(account.url, url)) return false
    if (isAuthFlowUrl(url)) return false
    return true
  }

  private updateNavigationState(accountId: string): AccountNavigationState | null {
    const tempView = this.tempViews.get(accountId)
    if (tempView && !tempView.webContents.isDestroyed()) {
      const contents = tempView.webContents
      const state: AccountNavigationState = {
        accountId,
        hasTemporaryView: true,
        url: contents.getURL() || '',
        // Always allow Back on temporary view: either navigates back in temp history or closes temp view to return to original view
        canGoBack: true,
        canGoForward: contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward(),
        isLoading: contents.isLoading()
      }
      this.navStates.set(accountId, state)
      if (!this.window.isDestroyed()) {
        this.window.webContents.send('hub:navigation-state', state)
      }
      return state
    }

    const view = this.views.get(accountId)
    if (!view || view.webContents.isDestroyed()) return null
    const contents = view.webContents
    const fallbackUrl = this.accounts.get(accountId)?.url ?? ''
    const state: AccountNavigationState = {
      accountId,
      hasTemporaryView: false,
      url: contents.getURL() || fallbackUrl,
      canGoBack: false,
      canGoForward: false,
      isLoading: contents.isLoading()
    }
    this.navStates.set(accountId, state)
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('hub:navigation-state', state)
    }
    return state
  }

  async clearCache(id: string): Promise<void> {
    const accountSession = this.sessions.get(id)
    if (!accountSession) throw new Error('Account session not found.')
    await accountSession.clearCache()
  }

  private getTempBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.bounds.x,
      y: NAV_BAR_HEIGHT,
      width: this.bounds.width,
      height: Math.max(0, this.bounds.height - NAV_BAR_HEIGHT)
    }
  }

  resize(x: number, y: number, width: number, height: number): void {
    this.bounds.x = Math.max(0, Math.round(x))
    this.bounds.y = Math.max(0, Math.round(y))
    this.bounds.width = Math.max(0, Math.round(width))
    this.bounds.height = Math.max(0, Math.round(height))
    for (const view of this.views.values()) view.setBounds(this.bounds)
    const tempBounds = this.getTempBounds()
    for (const tempView of this.tempViews.values()) tempView.setBounds(tempBounds)
  }

  resizeToContent(width: number, height: number): void {
    this.resize(SIDEBAR_WIDTH, 0, width - SIDEBAR_WIDTH, height)
  }

  private createView(account: Omit<Account, 'unread'>): void {
    const partition = `persist:account-${account.id}`
    const existingSession = this.sessions.get(account.id)
    const accountSession = existingSession ?? session.fromPartition(partition)
    accountSession.setUserAgent(CHROME_USER_AGENT)
    accountSession.setSpellCheckerEnabled(true)
    if (!existingSession) this.configureSession(account.id, accountSession)
    const isWhatsApp = account.appId === 'whatsapp' || account.url.includes('whatsapp.com')
    const view = new WebContentsView({
      webPreferences: {
        session: accountSession,
        preload: path.join(__dirname, '../preload/site.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: !isWhatsApp
      }
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds(this.bounds)
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    this.views.set(account.id, view)
    this.sessions.set(account.id, accountSession)
    this.unread.set(account.id, 0)
    this.configureWebContents(account.id, view.webContents)
    void view.webContents.loadURL(account.url)
  }

  private configureSession(accountId: string, accountSession: Session): void {
    const getPerms = (): AccountPermissions =>
      this.accounts.get(accountId)?.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS

    const notificationsEnabled = (): boolean => {
      const account = this.accounts.get(accountId)
      return Boolean(
        account &&
        !account.muted &&
        !this.accounts.preferences().doNotDisturb &&
        getPerms().notifications === 'allow'
      )
    }

    accountSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = details?.requestingUrl ?? webContents.getURL()
      if (
        !ALLOWED_PERMISSIONS.has(permission) ||
        !this.isAccountOrigin(accountId, origin)
      ) {
        callback(false)
        return
      }

      const perms = getPerms()

      if (permission === 'notifications') {
        callback(notificationsEnabled())
        return
      }

      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        callback(perms.clipboard === 'allow')
        return
      }

      if (permission === 'geolocation') {
        callback(perms.geolocation === 'allow')
        return
      }

      if (permission === 'media') {
        const requestedMedia: Array<'audio' | 'video'> =
          'mediaTypes' in details && details.mediaTypes ? details.mediaTypes : ['audio']
        if (requestedMedia.includes('video') && perms.camera !== 'allow') {
          callback(false)
          return
        }
        if (requestedMedia.includes('audio') && perms.microphone !== 'allow') {
          callback(false)
          return
        }

        if (process.platform === 'darwin') {
          const uniqueMedia = [...new Set(requestedMedia)]
          void Promise.all(
            uniqueMedia.map(async (mediaType) => {
              const device = mediaType === 'video' ? 'camera' : 'microphone'
              const status = systemPreferences.getMediaAccessStatus(device)
              if (status === 'granted') return true
              if (status !== 'not-determined') {
                console.warn(`${device} permission is ${status}; enable it in macOS Privacy & Security settings.`)
                return false
              }
              return systemPreferences.askForMediaAccess(device)
            })
          ).then((granted) => callback(granted.every(Boolean))).catch((error: unknown) => {
            console.error('Could not request macOS media permission:', error)
            callback(false)
          })
          return
        }

        callback(true)
        return
      }

      callback(true)
    })

    accountSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      if (
        !ALLOWED_PERMISSIONS.has(permission) ||
        !this.isAccountOrigin(accountId, requestingOrigin)
      ) {
        return false
      }

      const perms = getPerms()

      if (permission === 'notifications') {
        return notificationsEnabled()
      }

      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        return perms.clipboard === 'allow'
      }

      if (permission === 'geolocation') {
        return perms.geolocation === 'allow'
      }

      if (permission === 'media') {
        if (details.mediaType === 'video') {
          if (perms.camera !== 'allow') return false
        } else if (details.mediaType === 'audio') {
          if (perms.microphone !== 'allow') return false
        } else {
          if (perms.camera !== 'allow' && perms.microphone !== 'allow') return false
        }

        if (process.platform === 'darwin') {
          if (details.mediaType === 'unknown') {
            return (
              (perms.microphone !== 'allow' || systemPreferences.getMediaAccessStatus('microphone') === 'granted') &&
              (perms.camera !== 'allow' || systemPreferences.getMediaAccessStatus('camera') === 'granted') &&
              ((perms.microphone === 'allow' && systemPreferences.getMediaAccessStatus('microphone') === 'granted') ||
                (perms.camera === 'allow' && systemPreferences.getMediaAccessStatus('camera') === 'granted'))
            )
          }
          const device = details.mediaType === 'video' ? 'camera' : 'microphone'
          return systemPreferences.getMediaAccessStatus(device) === 'granted'
        }
        return true
      }

      return true
    })

    accountSession.setDisplayMediaRequestHandler((request, callback) => {
      void (async () => {
        try {
          if (!this.isAccountOrigin(accountId, request.securityOrigin ?? '')) {
            callback({})
            return
          }
          if (getPerms().screenShare !== 'allow') {
            callback({})
            return
          }
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            fetchWindowIcons: true
          })
          if (sources.length === 0) {
            callback({})
            return
          }
          const choice = await dialog.showMessageBox(this.window, {
            type: 'question',
            title: 'Share your screen',
            message: 'Choose a screen or window to share.',
            buttons: [...sources.map((source) => source.name), 'Cancel'],
            cancelId: sources.length,
            noLink: true
          })
          const source = sources[choice.response]
          if (!source) {
            callback({})
            return
          }
          callback({
            video: source,
            audio: request.audioRequested ? 'loopback' : undefined
          })
        } catch (error) {
          console.error('Could not prepare a screen-sharing source:', error)
          callback({})
        }
      })()
    })

    accountSession.on('will-download', (_event, item, webContents) => {
      if (getPerms().downloads !== 'allow') {
        item.cancel()
        return
      }
      this.handleDownload(accountId, item, webContents)
    })
  }

  private configureWebContents(accountId: string, contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const modifier = process.platform === 'darwin' ? input.meta : input.control
      if (!modifier) return
      if (/^[1-9]$/.test(input.key)) {
        const activeWorkspaceId = this.accounts.activeWorkspaceId()
        const accountsInWorkspace = this.accounts.list().filter((a) => a.workspaceId === activeWorkspaceId)
        const target = accountsInWorkspace[Number(input.key) - 1]
        if (target) {
          event.preventDefault()
          this.activate(target.id)
        }
      } else if (input.key.toLowerCase() === 'r') {
        event.preventDefault()
        this.reload(accountId)
      } else if (input.key.toLowerCase() === 'n') {
        event.preventDefault()
        this.onStateChanged()
        this.window.webContents.send('hub:add-account-shortcut')
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpsUrl(url)) {
        if (this.isExternalUrlForAccount(accountId, url)) {
          this.openTemporaryExternalView(accountId, url)
        } else {
          void contents.loadURL(url)
        }
      } else {
        try {
          const parsed = new URL(url)
          if (externalProtocols.has(parsed.protocol)) void shell.openExternal(url)
        } catch {
          // Invalid URLs are denied.
        }
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      let destination: URL
      try {
        destination = new URL(url)
      } catch {
        event.preventDefault()
        return
      }
      if (
        destination.protocol === 'https:' &&
        !destination.username &&
        !destination.password &&
        destination.hostname !== 'localhost' &&
        !destination.hostname.endsWith('.localhost')
      ) {
        if (this.isExternalUrlForAccount(accountId, url)) {
          event.preventDefault()
          this.openTemporaryExternalView(accountId, url)
        }
        return
      }
      event.preventDefault()
      if (externalProtocols.has(destination.protocol)) void shell.openExternal(url)
    })
    contents.on('will-redirect', (event, url) => {
      if (this.isExternalUrlForAccount(accountId, url)) {
        event.preventDefault()
        this.openTemporaryExternalView(accountId, url)
      }
    })
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      if (
        this.accounts.get(accountId)?.appId === 'whatsapp' &&
        /browser.{0,20}not supported|unsupported browser/i.test(title) &&
        !this.unsupported.has(accountId)
      ) {
        this.unsupported.add(accountId)
        const view = this.views.get(accountId)
        if (view) {
          const reloadUrl = JSON.stringify(this.accounts.get(accountId)?.url ?? DEFAULT_APP.url)
          const html = `<!doctype html><meta charset="utf-8"><title>Browser not supported</title><style>body{font:16px system-ui;background:#f7f9f8;color:#18231d;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:440px;text-align:center;padding:36px;border:1px solid #dfe7e1;border-radius:18px;background:white}button{border:0;border-radius:9px;background:#168c55;color:white;padding:11px 18px;font:inherit;cursor:pointer}</style><main class="card"><h2>Browser not supported</h2><p>This app could not use this browser session. Reload to try again.</p><button onclick="location.replace(${reloadUrl})">Reload</button></main>`
          void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        }
        return
      }
      this.unsupported.delete(accountId)
      const match = title.match(/^\((\d+)\)/)
      this.unread.set(accountId, match ? Number(match[1]) : 0)
      this.onStateChanged()
    })
    contents.on('dom-ready', () => {
      void this.installNotificationSupport(accountId, this.accounts.get(accountId)?.name ?? accountId, contents)
    })
    contents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate([
        ...(params.dictionarySuggestions ?? []).map((suggestion) => ({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion)
        })),
        ...(params.dictionarySuggestions?.length ? [{ type: 'separator' as const }] : []),
        { label: 'Copy', role: 'copy' as const, enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste' as const, enabled: params.editFlags.canPaste },
        ...(params.linkURL
          ? [{ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) }]
          : [])
      ])
      menu.popup({ window: this.window })
    })
    contents.on('render-process-gone', (_event, details) => {
      console.error(`Web view ${accountId} renderer exited: ${details.reason}`)
      this.notifications.dismissAllCallsForAccount(accountId)
      this.updateNavigationState(accountId)
    })
    const syncNav = () => {
      this.updateNavigationState(accountId)
    }
    contents.on('did-start-loading', syncNav)
    contents.on('did-stop-loading', syncNav)
    contents.on('did-navigate', syncNav)
    contents.on('did-navigate-in-page', syncNav)
    contents.on('did-fail-load', syncNav)
    contents.once('destroyed', () => {
      contents.removeListener('did-start-loading', syncNav)
      contents.removeListener('did-stop-loading', syncNav)
      contents.removeListener('did-navigate', syncNav)
      contents.removeListener('did-navigate-in-page', syncNav)
      contents.removeListener('did-fail-load', syncNav)
    })
  }

  private configureTempWebContents(accountId: string, contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const modifier = process.platform === 'darwin' ? input.meta : input.control
      if (!modifier) return
      if (input.key.toLowerCase() === 'r') {
        event.preventDefault()
        this.reload(accountId)
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpsUrl(url)) {
        void contents.loadURL(url)
      } else {
        try {
          const parsed = new URL(url)
          if (externalProtocols.has(parsed.protocol)) void shell.openExternal(url)
        } catch {
          // Invalid URLs are denied.
        }
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      let destination: URL
      try {
        destination = new URL(url)
      } catch {
        event.preventDefault()
        return
      }
      if (
        destination.protocol === 'https:' &&
        !destination.username &&
        !destination.password &&
        destination.hostname !== 'localhost' &&
        !destination.hostname.endsWith('.localhost')
      ) return
      event.preventDefault()
      if (externalProtocols.has(destination.protocol)) void shell.openExternal(url)
    })
    contents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate([
        ...(params.dictionarySuggestions ?? []).map((suggestion) => ({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion)
        })),
        ...(params.dictionarySuggestions?.length ? [{ type: 'separator' as const }] : []),
        { label: 'Copy', role: 'copy' as const, enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste' as const, enabled: params.editFlags.canPaste },
        ...(params.linkURL
          ? [{ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) }]
          : [])
      ])
      menu.popup({ window: this.window })
    })
    const syncNav = () => {
      this.updateNavigationState(accountId)
    }
    contents.on('did-start-loading', syncNav)
    contents.on('did-stop-loading', syncNav)
    contents.on('did-navigate', syncNav)
    contents.on('did-navigate-in-page', syncNav)
    contents.on('did-fail-load', syncNav)
    contents.once('destroyed', () => {
      contents.removeListener('did-start-loading', syncNav)
      contents.removeListener('did-stop-loading', syncNav)
      contents.removeListener('did-navigate', syncNav)
      contents.removeListener('did-navigate-in-page', syncNav)
      contents.removeListener('did-fail-load', syncNav)
    })
  }

  private async installNotificationSupport(
    accountId: string,
    accountName: string,
    contents: WebContents
  ): Promise<void> {
    if (contents.isDestroyed()) return
    const label = JSON.stringify(accountName)
    try {
      await contents.executeJavaScript(
        `(() => {
          window.__socialHubAccountName = ${label};
          const NativeNotification = window.Notification;
          if (!NativeNotification || NativeNotification.__hubWrapped) return;
          class HubNotification extends NativeNotification {
            constructor(title, options) {
              super(\`[\${window.__socialHubAccountName}] \${title}\`, options);
              try {
                window.socialHubNotification?.notify({
                  title: String(title || ''),
                  body: options && typeof options.body === 'string' ? options.body : '',
                  tag: options && typeof options.tag === 'string' ? options.tag : undefined,
                  icon: options && typeof options.icon === 'string' ? options.icon : undefined
                });
              } catch (e) {}
              this.addEventListener('click', () => window.socialHubNotification?.clicked());
            }
            static get permission() { return NativeNotification.permission; }
            static requestPermission() { return NativeNotification.requestPermission(); }
          }
          Object.defineProperty(HubNotification, '__hubWrapped', { value: true });
          Object.defineProperty(window, 'Notification', { configurable: true, value: HubNotification });
        })();`
      )
    } catch (error) {
      if (!contents.isDestroyed()) {
        console.error(`Could not enable labeled notifications for ${accountId}:`, error)
      }
    }
  }

  private handleDownload(accountId: string, item: DownloadItem, _contents: WebContents): void {
    const account = this.accounts.get(accountId)
    const filename = path.basename(item.getFilename())
    const destination = path.join(app.getPath('downloads'), filename)
    item.setSavePath(destination)
    const publish = (state: DownloadUpdate['state']) => {
      const update: DownloadUpdate = {
        accountId,
        filename,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
        path: state === 'completed' ? destination : undefined
      }
      this.onDownload(update)
      if (state === 'completed' || state === 'interrupted') {
        this.notifications.notifyDownload(update)
        if (account) {
          const workspace = this.accounts.getWorkspace(account.workspaceId)
          this.accounts.addNotification({
            workspaceId: account.workspaceId,
            workspaceName: workspace?.name ?? 'Workspace',
            accountId: account.id,
            accountName: account.name,
            accountAppId: account.appId,
            platformName: resolvePlatformName(account.appId, account.url),
            type: 'download',
            title: state === 'completed' ? 'Download complete' : 'Download failed',
            body: filename
          })
          this.onNotificationsChanged?.()
        }
      }
    }
    item.on('updated', () => {
      if (item.isPaused()) return
      this.onDownload({
        accountId,
        filename,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: 'progressing'
      })
    })
    item.once('done', (_event, state) => {
      if (state === 'completed') {
        publish('completed')
      } else {
        publish(state === 'cancelled' ? 'cancelled' : 'interrupted')
      }
    })
    if (!account) console.warn(`Download began for removed account ${accountId}`)
  }

  private requireView(id: string): WebContentsView {
    const view = this.views.get(id)
    if (!view) throw new Error('Account view not found.')
    return view
  }
}
