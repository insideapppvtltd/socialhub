import {
  app,
  BrowserWindow,
  shell
} from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AccountManager } from './account-manager'
import { registerIpc } from './ipc'
import { HubNotifications } from './notifications'
import { HubTray } from './tray'
import type { DownloadUpdate, HubState } from './types'
import { ViewManager } from './view-manager'

const updaterModule = createRequire(import.meta.url)('electron-updater') as typeof import('electron-updater')
const { autoUpdater } = updaterModule

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let window: BrowserWindow | null = null
  let accountManager: AccountManager
  let viewManager: ViewManager | null = null
  let notifications: HubNotifications
  let tray: HubTray
  let quitting = false
  let rendererUrl: string | undefined

  app.on('second-instance', () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  const makeState = (): HubState => ({
    workspaces: accountManager.listWorkspaces(),
    activeWorkspaceId: accountManager.activeWorkspaceId(),
    accounts: viewManager?.listAccounts() ?? [],
    activeAccountId: viewManager?.activeAccountId() ?? null,
    preferences: accountManager.preferences(),
    globalDefaultPermissions: accountManager.getGlobalDefaultPermissions()
  })

  const publishState = (): void => {
    if (window && !window.isDestroyed()) window.webContents.send('hub:state', makeState())
    tray?.refresh()
  }

  const publishDownload = (update: DownloadUpdate): void => {
    if (window && !window.isDestroyed()) window.webContents.send('hub:download', update)
  }

  function createWindow(): BrowserWindow {
    const saved = accountManager.bounds()
    const created = new BrowserWindow({
      ...saved,
      minWidth: 780,
      minHeight: 540,
      show: false,
      title: 'Social Hub',
      icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    created.webContents.on('will-navigate', (event, url) => {
      if (rendererUrl && url.startsWith(rendererUrl)) return
      event.preventDefault()
      void shell.openExternal(url)
    })
    created.on('resize', saveBounds)
    created.on('resize', () => {
      const [width, height] = created.getContentSize()
      viewManager?.resizeToContent(width, height)
    })
    created.on('move', saveBounds)
    created.on('close', (event) => {
      if (!quitting) {
        event.preventDefault()
        if (accountManager.preferences().minimizeToTray) created.hide()
        else app.quit()
      }
    })
    created.on('closed', () => {
      if (window === created) window = null
    })
    created.on('ready-to-show', () => created.show())
    if (process.env.ELECTRON_RENDERER_URL) {
      rendererUrl = process.env.ELECTRON_RENDERER_URL
    } else {
      const page = path.join(__dirname, '../renderer/index.html')
      rendererUrl = pathToFileURL(page).toString()
    }
    return created
  }

  function loadRenderer(target: BrowserWindow): void {
    if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void target.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  function saveBounds(): void {
    if (!window || window.isMinimized() || window.isMaximized()) return
    accountManager.saveBounds(window.getBounds())
  }

  app.whenReady().then(async () => {
    accountManager = new AccountManager()
    if (accountManager.preferences().launchAtStartup) {
      app.setLoginItemSettings({ openAtLogin: true })
    }
    window = createWindow()
    notifications = new HubNotifications(
      () => window,
      (accountId) => {
        if (viewManager?.listAccounts().some((account) => account.id === accountId)) {
          viewManager?.activate(accountId)
        }
      }
    )
    const mainWindow = window
    viewManager = new ViewManager(mainWindow, accountManager, notifications, publishState, publishDownload)
    await viewManager.initialize()
    const [contentWidth, contentHeight] = mainWindow.getContentSize()
    viewManager.resizeToContent(contentWidth, contentHeight)
    tray = new HubTray(mainWindow, accountManager, viewManager, publishState)
    tray.create()
    registerIpc(
      mainWindow,
      accountManager,
      viewManager,
      notifications,
      makeState,
      (preferences) => {
        app.setLoginItemSettings({ openAtLogin: preferences.launchAtStartup })
        publishState()
      },
      rendererUrl,
      process.env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? ''
    )
    publishState()
    loadRenderer(mainWindow)
    if (app.isPackaged) {
      autoUpdater.on('error', (error) => console.error('Auto-update error:', error))
      void autoUpdater.checkForUpdatesAndNotify()
    }
    app.on('activate', () => {
      if (window) {
        window.show()
        window.focus()
      } else {
        window = createWindow()
      }
    })
    app.on('before-quit', () => {
      quitting = true
      tray?.destroy()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !accountManager?.preferences().minimizeToTray) app.quit()
  })
}
