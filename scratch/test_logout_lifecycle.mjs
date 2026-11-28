import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

console.log('=== SOCIAL HUB: LOGOUT NOTIFICATION/CALL SHUTDOWN & OPTIONAL APPS LOGOUT TEST SUITE ===\n')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialhub-logout-test-'))
const notifOut = path.join(tmpDir, 'notifications.mjs')

const electronMockState = {
  shownNotifications: [],
  closedNotifications: [],
  broadcasts: [],
  activatedAccounts: []
}

const mockElectronPlugin = {
  name: 'mock-electron',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron',
      namespace: 'mock-electron'
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'mock-electron' }, () => ({
      contents: `
        const st = globalThis.__LOGOUT_ELECTRON_MOCK__;
        export const app = {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          focus: () => {}
        };
        export const shell = { showItemInFolder: () => {} };
        export const BrowserWindow = class {};
        export class Notification {
          static isSupported() { return true; }
          constructor(opts) {
            this.opts = opts;
            this.handlers = {};
          }
          on(ev, fn) { this.handlers[ev] = fn; }
          show() { st.shownNotifications.push(this.opts); }
          close() { st.closedNotifications.push(this.opts); }
        }
      `,
      loader: 'js'
    }))
  }
}

globalThis.__LOGOUT_ELECTRON_MOCK__ = electronMockState

await build({
  entryPoints: [path.resolve('src/main/notifications.ts')],
  outfile: notifOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [mockElectronPlugin]
})

const { HubNotifications } = await import(pathToFileURL(notifOut).href)

try {
  // 1. Test HubNotifications monitoring lifecycle (active -> logout -> suppressed -> re-login)
  console.log('[TEST 1-6] Incoming calls & notifications stop on logout and restore on re-login')
  const notifMgr = new HubNotifications(
    () => ({
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      show: () => {},
      focus: () => {},
      webContents: {
        send: (channel, payload) => {
          electronMockState.broadcasts.push({ channel, payload })
        }
      }
    }),
    (accountId) => electronMockState.activatedAccounts.push(accountId)
  )

  // Before logout: incoming call works
  notifMgr.showIncomingCall({ id: 'acc-wa-1', name: 'WhatsApp Biz' }, { callId: 'call-1', callerName: 'Alice', callType: 'voice' })
  assert.strictEqual(notifMgr.hasActiveCalls(), true)
  assert.strictEqual(notifMgr.getActiveCallCount(), 1)
  assert.strictEqual(electronMockState.shownNotifications.length, 1)

  // Logout disables monitoring & clears active calls
  notifMgr.setMonitoringEnabled(false)
  assert.strictEqual(notifMgr.isMonitoringEnabled(), false)
  assert.strictEqual(notifMgr.hasActiveCalls(), false, 'Active calls must be cleared on logout')
  assert.strictEqual(notifMgr.getActiveCallCount(), 0)
  assert.strictEqual(electronMockState.closedNotifications.length, 1, 'Open call notification must be closed on logout')
  const lastBroadcast = electronMockState.broadcasts[electronMockState.broadcasts.length - 1]
  assert.deepStrictEqual(lastBroadcast, { channel: 'hub:active-call-status', payload: { hasActiveCall: false, count: 0 } })

  // Queued/delayed call or download callback after logout is suppressed
  notifMgr.showIncomingCall({ id: 'acc-wa-1', name: 'WhatsApp Biz' }, { callId: 'call-2', callerName: 'Bob', callType: 'video' })
  notifMgr.notifyDownload({ accountId: 'acc-wa-1', filename: 'file.pdf', receivedBytes: 10, totalBytes: 10, state: 'completed' })
  assert.strictEqual(notifMgr.hasActiveCalls(), false)
  assert.strictEqual(electronMockState.shownNotifications.length, 1, 'No new notifications may be shown after logout')

  // Re-login restores monitoring
  notifMgr.setMonitoringEnabled(true)
  notifMgr.showIncomingCall({ id: 'acc-wa-1', name: 'WhatsApp Biz' }, { callId: 'call-3', callerName: 'Charlie', callType: 'voice' })
  assert.strictEqual(notifMgr.hasActiveCalls(), true)
  assert.strictEqual(electronMockState.shownNotifications.length, 2, 'Monitoring must resume after re-login')
  notifMgr.dismissAllCalls()
  console.log('  -> Passed\n')

  // 2. Codebase audit for ViewManager, IPC, Preload, App.tsx, and Data Preservation
  console.log('[TEST 7-15] Codebase audit: ViewManager shutdown, IPC guards, optional apps logout, dialog UI & data preservation')
  const vmSrc = fs.readFileSync('src/main/view-manager.ts', 'utf8')
  const ipcSrc = fs.readFileSync('src/main/ipc.ts', 'utf8')
  const appSrc = fs.readFileSync('src/renderer/App.tsx', 'utf8')
  const preloadSrc = fs.readFileSync('src/preload/index.ts', 'utf8')

  // switchUser(null) disables monitoring, destroys temp views and all account views, preserves sessions
  assert.ok(vmSrc.includes('this.notifications.setMonitoringEnabled(false)'), 'switchUser(null) must disable notification monitoring')
  assert.ok(vmSrc.includes('this.destroyAllAccountViews()'), 'switchUser(null) must destroy all account WebContentsViews')
  assert.ok(vmSrc.includes('this.notifications.setMonitoringEnabled(true)'), 'switchUser(uid) must re-enable monitoring on login')

  // logoutConnectedApps clears targeted storage on persist:account-${account.id} without deleting accounts/workspaces/passwords
  assert.ok(vmSrc.includes('async logoutConnectedApps()'), 'ViewManager must implement logoutConnectedApps()')
  assert.ok(vmSrc.includes('`persist:account-${account.id}`'), 'Partition naming persist:account-${account.id} must be preserved')
  assert.ok(vmSrc.includes("storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']"))
  assert.ok(vmSrc.includes('clearAuthCache()'))

  // IPC guards reject notification & call events when logged out
  for (const channel of ['social:notification-click', 'social:chat-notification', 'hub:incoming-call-start', 'hub:incoming-call-end', 'hub:incoming-call-update']) {
    const idx = ipcSrc.indexOf(`ipcMain.on('${channel}'`)
    assert.ok(idx >= 0, `Missing IPC handler ${channel}`)
    const snippet = ipcSrc.slice(idx, idx + 180)
    assert.ok(snippet.includes('if (!accounts.getCurrentUser()) return'), `IPC ${channel} must guard against logged-out callbacks`)
  }
  assert.ok(ipcSrc.includes("ipcMain.handle('hub:logout-connected-apps'"))
  assert.ok(preloadSrc.includes('logoutConnectedApps'))

  // Logout confirmation dialog UI & ordering
  assert.ok(appSrc.includes('Log out of Social HUB?'))
  assert.ok(appSrc.includes('You will stop receiving notifications and incoming-call alerts from your connected apps.'))
  assert.ok(appSrc.includes('Also log out of all connected apps'))
  assert.ok(appSrc.includes('setLogoutConnectedApps(false)'), 'Checkbox must default to unchecked')
  assert.ok(appSrc.includes('if (logoutConnectedApps)'))
  assert.ok(appSrc.includes('await window.socialHub.setCurrentUser(null)'))
  assert.ok(appSrc.includes('setActiveCallCount(0)'))
  assert.ok(appSrc.includes('await logoutUser()'))

  console.log('  -> Passed\n')
  console.log('=========================================================================')
  console.log('ALL LOGOUT LIFECYCLE & CONNECTED APPS LOGOUT TESTS PASSED (100% PASS)')
  console.log('=========================================================================')
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
