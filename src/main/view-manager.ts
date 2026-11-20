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
import { SIDEBAR_WIDTH } from '../shared/layout'
import { APP_CATALOG, resolvePlatformName } from '../shared/apps'
import type { Account, AccountPermissions, DownloadUpdate } from './types'
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

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>()
  private readonly sessions = new Map<string, Session>()
  private activeId: string | null = null
  private sidebarOverlayActive = false
  private readonly unread = new Map<string, number>()
  private readonly unsupported = new Set<string>()
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
    let accounts = this.accounts.list()
    if (accounts.length === 0) {
      const defaultWorkspaceId = this.accounts.activeWorkspaceId()
      this.accounts.add('WhatsApp Personal', DEFAULT_APP.id, DEFAULT_APP.url, defaultWorkspaceId)
      accounts = this.accounts.list()
    }
    for (const account of accounts) this.createView(account)
    const activeWorkspaceId = this.accounts.activeWorkspaceId()
    const workspaceAccounts = accounts.filter((a) => a.workspaceId === activeWorkspaceId)
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
    return [...this.views].find(([, view]) => view.webContents === contents)?.[0]
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

  activate(id: string): void {
    if (!this.views.has(id)) throw new Error('Account view not found.')
    const account = this.accounts.get(id)
    if (account?.workspaceId && this.accounts.getWorkspace(account.workspaceId)) {
      if (this.accounts.activeWorkspaceId() !== account.workspaceId) {
        this.accounts.setActiveWorkspace(account.workspaceId)
      }
    }
    this.sidebarOverlayActive = false
    for (const [accountId, view] of this.views) {
      view.setVisible(accountId === id)
    }
    this.activeId = id
    this.accounts.setActive(id)
    this.onStateChanged()
  }

  switchWorkspace(workspaceId: string): void {
    this.accounts.setActiveWorkspace(workspaceId)
    const workspaceAccounts = this.accounts.list().filter((a) => a.workspaceId === workspaceId)
    const currentActiveId = this.accounts.activeId()
    const targetId = workspaceAccounts.some((a) => a.id === currentActiveId)
      ? currentActiveId
      : workspaceAccounts[0]?.id ?? null

    if (targetId) {
      this.activate(targetId)
    } else {
      for (const view of this.views.values()) {
        view.setVisible(false)
      }
      this.activeId = null
      this.accounts.setActive('')
      this.onStateChanged()
    }
  }

  setSidebarOverlayActive(active: boolean): void {
    if (this.sidebarOverlayActive === active) return
    this.sidebarOverlayActive = active
    if (this.activeId) this.views.get(this.activeId)?.setVisible(!active)
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
    this.notifications.dismissAllCallsForAccount(id)
    this.accounts.remove(id)
    const nextId = this.accounts.activeId()
    this.activeId = null
    if (nextId) {
      this.activate(nextId)
    } else {
      for (const v of this.views.values()) v.setVisible(false)
      this.onStateChanged()
    }
  }

  rename(id: string, name: string): Account {
    const account = { ...this.accounts.rename(id, name), unread: this.unread.get(id) ?? 0 }
    this.updateAccountLabel(id, account.name)
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
    const view = this.requireView(id)
    view.webContents.reload()
  }

  async clearCache(id: string): Promise<void> {
    const accountSession = this.sessions.get(id)
    if (!accountSession) throw new Error('Account session not found.')
    await accountSession.clearCache()
  }

  resize(x: number, y: number, width: number, height: number): void {
    this.bounds.x = Math.max(0, Math.round(x))
    this.bounds.y = Math.max(0, Math.round(y))
    this.bounds.width = Math.max(0, Math.round(width))
    this.bounds.height = Math.max(0, Math.round(height))
    for (const view of this.views.values()) view.setBounds(this.bounds)
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
