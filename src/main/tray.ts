import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import path from 'node:path'
import type { AccountManager } from './account-manager'
import type { ViewManager } from './view-manager'

export class HubTray {
  private tray: Tray | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly accounts: AccountManager,
    private readonly views: ViewManager,
    private readonly onStateChanged: () => void
  ) {}

  create(): void {
    const icon = this.badgeImage(0)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Social Hub')
    this.tray.on('click', () => this.showWindow())
    this.refresh()
  }

  refresh(): void {
    if (!this.tray) return
    const total = this.views.listAccounts().reduce((sum, account) => sum + account.unread, 0)
    this.tray.setTitle(process.platform === 'darwin' && total ? String(total) : '')
    this.tray.setToolTip(total ? `Social Hub · ${total} unread` : 'Social Hub')
    const icon = this.badgeImage(total)
    this.tray.setImage(icon)
    if (process.platform === 'win32') {
      this.window.setOverlayIcon(total ? icon : null, total ? `${total} unread messages` : '')
    } else if (process.platform === 'darwin') {
      app.dock?.setBadge(total ? String(total) : '')
    }
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Social Hub', click: () => this.showWindow() },
        {
          label: 'Do Not Disturb',
          type: 'checkbox',
          checked: this.accounts.preferences().doNotDisturb,
          click: (item) => {
            const preferences = this.accounts.updatePreferences({ doNotDisturb: item.checked })
            this.onStateChanged()
            void preferences
          }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }

  showWindow(): void {
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private badgeImage(total: number): Electron.NativeImage {
    if (total === 0) {
      const pathToIcon = path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        'resources',
        'tray.png'
      )
      return nativeImage.createFromPath(pathToIcon)
    }
    const label = total > 99 ? '99+' : String(total)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="3" y="3" width="58" height="58" rx="17" fill="#1ba263"/><path d="M32 12a19 19 0 0 0-16.4 28.7L12 53l12.5-3.2A19.2 19.2 0 1 0 32 12zm0 32.8c-2.8 0-5.6-.8-8-2.2l-.6-.4-6.4 1.7 1.8-6.2-.4-.6a15.4 15.4 0 1 1 13.6 7.7z" fill="#fff"/><circle cx="51" cy="13" r="13" fill="#d94c4c"/><text x="51" y="17" text-anchor="middle" font-family="Arial,sans-serif" font-size="${label.length > 2 ? 8 : 10}" font-weight="700" fill="#fff">${label}</text></svg>`
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  }
}
