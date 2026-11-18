import { app, BrowserWindow, Notification, shell } from 'electron'
import path from 'node:path'
import type { DownloadUpdate, IncomingCallEvent } from './types'

interface ActiveCall {
  callId: string
  notification: Notification
  timeoutId: ReturnType<typeof setTimeout>
}

export class HubNotifications {
  private readonly activeCalls = new Map<string, ActiveCall>()

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onActivateAccount: (accountId: string) => void
  ) {}

  showIncomingCall(account: { id: string; name: string }, call: IncomingCallEvent): void {
    const existing = this.activeCalls.get(account.id)
    if (existing) {
      if (existing.callId === call.callId) {
        console.log(`[CALL][NOTIF] Duplicate notification suppressed for account ${account.id} (callId: ${call.callId})`)
        return
      }
      console.log(`[CALL][NOTIF] Replacing previous call notification for account ${account.id}`)
      this.dismissIncomingCall(account.id)
    }

    if (!Notification.isSupported()) {
      console.warn('[CALL][NOTIF] Electron Notification.isSupported() returned false!')
      return
    }

    const callTypeLabel = call.callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call'
    const title = `${account.name} – ${callTypeLabel}`
    const validCaller = call.callerName && !/wordmark/i.test(call.callerName) ? call.callerName.trim() : undefined
    const body = validCaller ? `${validCaller} is calling...` : 'Incoming call...'
    const iconPath = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.png')

    const notification = new Notification({
      title,
      body,
      icon: iconPath,
      silent: true
    })

    const timeoutId = setTimeout(() => {
      console.log(`[CALL][TIMEOUT] Fallback timeout fired for account ${account.id} (callId: ${call.callId})`)
      this.dismissIncomingCall(account.id, call.callId)
    }, 45000)
    if (timeoutId && typeof timeoutId.unref === 'function') {
      timeoutId.unref()
    }

    notification.on('show', () => {
      console.log(`[CALL][SHOW] Native notification successfully shown for account ${account.id} (callId: ${call.callId})`)
    })

    notification.on('failed', (_event, error) => {
      console.error(`[CALL][FAILED] Native notification failed to show for account ${account.id} (callId: ${call.callId}):`, error)
    })

    notification.on('click', () => {
      console.log(`[CALL][CLICK] Native notification clicked for account ${account.id} (callId: ${call.callId})`)
      this.activate(account.id)
      this.dismissIncomingCall(account.id, call.callId)
    })

    notification.on('close', () => {
      console.log(`[CALL][CLOSE] Native notification closed for account ${account.id} (callId: ${call.callId})`)
      const current = this.activeCalls.get(account.id)
      if (current && current.callId === call.callId) {
        clearTimeout(current.timeoutId)
        this.activeCalls.delete(account.id)
      }
    })

    this.activeCalls.set(account.id, {
      callId: call.callId,
      notification,
      timeoutId
    })

    console.log(`[CALL][CREATE] Showing native notification for account ${account.id} (callId: ${call.callId})`)
    notification.show()
  }

  dismissIncomingCall(accountId: string, callId?: string): void {
    const current = this.activeCalls.get(accountId)
    if (!current) return
    if (callId && current.callId !== callId) return

    clearTimeout(current.timeoutId)
    try {
      current.notification.close()
    } catch {
      // In case notification was already closed
    }
    this.activeCalls.delete(accountId)
  }

  dismissAllCallsForAccount(accountId: string): void {
    this.dismissIncomingCall(accountId)
  }

  dismissAllCalls(): void {
    for (const accountId of [...this.activeCalls.keys()]) {
      this.dismissIncomingCall(accountId)
    }
  }

  getActiveCall(accountId: string): { callId: string } | undefined {
    const current = this.activeCalls.get(accountId)
    return current ? { callId: current.callId } : undefined
  }

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
