import { app, BrowserWindow, Notification, shell } from 'electron'
import type { DownloadUpdate } from './types'

export class HubNotifications {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onActivateAccount: (accountId: string) => void
  ) {}

  notifyDownload(update: DownloadUpdate): void {
    const label = update.state === 'completed' ? 'Download complete' : 'Download failed'
    const notification = new Notification({
      title: label,
      body: update.state === 'completed' ? update.filename : `${update.filename} could not be downloaded.`,
      silent: false
    })
    notification.on('click', () => {
      if (update.path) shell.showItemInFolder(update.path)
      this.activate(update.accountId)
    })
    notification.show()
  }

  focusAccount(accountId: string): void {
    this.activate(accountId)
  }

  private activate(accountId: string): void {
    const window = this.getWindow()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    app.focus({ steal: true })
    this.onActivateAccount(accountId)
  }
}
