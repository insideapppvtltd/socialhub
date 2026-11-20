import { app, BrowserWindow, Notification, shell } from 'electron'
import path from 'node:path'
import type { DownloadUpdate, IncomingCallEvent } from './types'

interface ActiveCall {
  callId: string
  notification?: Notification
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

    const timeoutId = setTimeout(() => {
      console.log(`[CALL][TIMEOUT] Fallback timeout fired for account ${account.id} (callId: ${call.callId})`)
      this.dismissIncomingCall(account.id, call.callId)
    }, 45000)
    if (timeoutId && typeof timeoutId.unref === 'function') {
      timeoutId.unref()
    }

    let notification: Notification | undefined

    if (Notification.isSupported()) {
      const callTypeLabel = call.callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call'
      const title = `${account.name} – ${callTypeLabel}`
      const rawCaller = call.callerName ? call.callerName.trim() : ''
      const isGeneric =
        !rawCaller ||
        /wordmark/i.test(rawCaller) ||
        /\b(voice and video|video and voice|calling is now available|is now available|end-to-end encrypted|whatsapp web|incoming call|incoming voice|incoming video|voice call|video call)\b/i.test(
          rawCaller
        )
      const validCaller = isGeneric ? undefined : rawCaller
      const body = validCaller ? `${validCaller} is calling...` : 'Incoming call...'
      const iconPath = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.png')

      notification = new Notification({
        title,
        body,
        icon: iconPath,
        silent: true
      })

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
          this.broadcastActiveCalls()
        }
      })

      console.log(`[CALL][CREATE] Showing native notification for account ${account.id} (callId: ${call.callId})`)
      notification.show()
    } else {
      console.warn('[CALL][NOTIF] Electron Notification.isSupported() returned false!')
    }

    this.activeCalls.set(account.id, {
      callId: call.callId,
      notification,
      timeoutId
    })
    this.broadcastActiveCalls()
  }

  dismissIncomingCall(accountId: string, callId?: string): void {
    const current = this.activeCalls.get(accountId)
    if (!current) return
    if (callId && current.callId !== callId) return

    clearTimeout(current.timeoutId)
    if (current.notification) {
      try {
        current.notification.close()
      } catch {
        // In case notification was already closed
      }
    }
    this.activeCalls.delete(accountId)
    this.broadcastActiveCalls()
  }

  dismissAllCallsForAccount(accountId: string): void {
    this.dismissIncomingCall(accountId)
  }

  dismissAllCalls(): void {
    for (const accountId of [...this.activeCalls.keys()]) {
      this.dismissIncomingCall(accountId)
    }
  }

  hasActiveCalls(): boolean {
    return this.activeCalls.size > 0
  }

  getActiveCallCount(): number {
    return this.activeCalls.size
  }

  broadcastActiveCalls(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send('hub:active-call-status', {
        hasActiveCall: this.activeCalls.size > 0,
        count: this.activeCalls.size
      })
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
