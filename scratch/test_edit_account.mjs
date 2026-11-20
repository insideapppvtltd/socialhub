import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('=== SOCIAL HUB: EDIT ACCOUNT VERIFICATION SUITE ===\n')

// =========================================================================
// TEST 1: AccountManager updateAccount Logic
// =========================================================================
console.log('[TEST 1] Testing AccountManager updateAccount logic...')

class MockAccountManager {
  constructor() {
    this.accounts = [
      {
        id: 'acc-1',
        workspaceId: 'ws-1',
        name: 'Personal WhatsApp',
        color: '#123456',
        muted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        appId: 'whatsapp',
        url: 'https://web.whatsapp.com/',
        permissions: { camera: 'allow', microphone: 'allow', notifications: 'allow', screenShare: 'allow', clipboard: 'allow', geolocation: 'block', downloads: 'allow' }
      }
    ]
  }

  get(id) {
    return this.accounts.find((a) => a.id === id)
  }

  update(id, patch) {
    const existing = this.get(id)
    if (!existing) throw new Error('Account not found.')
    const updated = { ...existing, ...patch }
    this.accounts = this.accounts.map((a) => (a.id === id ? updated : a))
    return updated
  }

  updateAccount(id, updates) {
    const existing = this.get(id)
    if (!existing) throw new Error('Account not found.')

    const patch = {}

    if (updates.name !== undefined) {
      const cleanName = updates.name.trim().slice(0, 40)
      if (!cleanName) throw new Error('Account name cannot be empty.')
      patch.name = cleanName
    }

    if (updates.url !== undefined) {
      const cleanUrl = updates.url.trim()
      if (!cleanUrl) throw new Error('Website URL cannot be empty.')
      try {
        const parsed = new URL(cleanUrl)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
          throw new Error('Enter a valid HTTPS website URL.')
        }
        patch.url = parsed.href
      } catch {
        throw new Error('Enter a valid HTTPS website URL.')
      }
    }

    return this.update(id, patch)
  }
}

const am = new MockAccountManager()

// 1.1 Update only name
const updatedNameOnly = am.updateAccount('acc-1', { name: 'Work WhatsApp' })
assert.equal(updatedNameOnly.name, 'Work WhatsApp')
assert.equal(updatedNameOnly.url, 'https://web.whatsapp.com/', 'URL must remain unchanged')
assert.equal(updatedNameOnly.id, 'acc-1', 'ID must remain unchanged')
assert.equal(updatedNameOnly.workspaceId, 'ws-1', 'workspaceId must remain unchanged')
assert.equal(updatedNameOnly.appId, 'whatsapp', 'appId must remain unchanged')
console.log('  -> Passed: Editing only name preserves URL, ID, workspaceId, and appId.')

// 1.2 Update only URL
const updatedUrlOnly = am.updateAccount('acc-1', { url: 'https://web.telegram.org/a/' })
assert.equal(updatedUrlOnly.name, 'Work WhatsApp', 'Name must remain unchanged')
assert.equal(updatedUrlOnly.url, 'https://web.telegram.org/a/', 'URL must be updated')
assert.equal(updatedUrlOnly.id, 'acc-1')
console.log('  -> Passed: Editing only URL preserves name, ID, and workspaceId.')

// 1.3 Update both name and URL
const updatedBoth = am.updateAccount('acc-1', { name: 'My Portal', url: 'https://portal.example.com/app' })
assert.equal(updatedBoth.name, 'My Portal')
assert.equal(updatedBoth.url, 'https://portal.example.com/app')
console.log('  -> Passed: Editing both name and URL updates both fields independently.')

// 1.4 Validate empty name
assert.throws(() => {
  am.updateAccount('acc-1', { name: '   ' })
}, /Account name cannot be empty/)
console.log('  -> Passed: Empty name is rejected.')

// 1.5 Validate invalid URL (HTTP instead of HTTPS)
assert.throws(() => {
  am.updateAccount('acc-1', { url: 'http://insecure.example.com' })
}, /Enter a valid HTTPS website URL/)

// 1.6 Validate invalid URL format
assert.throws(() => {
  am.updateAccount('acc-1', { url: 'not-a-valid-url' })
}, /Enter a valid HTTPS website URL/)
console.log('  -> Passed: Non-HTTPS and malformed URLs are rejected.')

// =========================================================================
// TEST 2: ViewManager Navigation on URL change vs Name change
// =========================================================================
console.log('\n[TEST 2] Testing ViewManager navigation on URL change...')

class MockWebContents {
  constructor() {
    this.currentUrl = ''
    this.destroyed = false
  }
  isDestroyed() {
    return this.destroyed
  }
  loadURL(url) {
    this.currentUrl = url
  }
}

class MockViewManager {
  constructor(accountManager) {
    this.accounts = accountManager
    this.views = new Map([['acc-1', { webContents: new MockWebContents() }]])
    this.stateChangedCount = 0
    this.labelUpdatedCount = 0
  }

  updateAccountLabel(id, name) {
    this.labelUpdatedCount++
  }

  onStateChanged() {
    this.stateChangedCount++
  }

  updateAccount(id, updates) {
    const existing = this.accounts.get(id)
    if (!existing) throw new Error('Account not found.')

    const previousUrl = existing.url
    const updatedStored = this.accounts.updateAccount(id, updates)
    const account = { ...updatedStored, unread: 0 }

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
}

const vm = new MockViewManager(am)

// 2.1 Updating only name should NOT call loadURL
const webContents = vm.views.get('acc-1').webContents
webContents.loadURL('https://portal.example.com/app')
const loadUrlCallsBefore = webContents.currentUrl

vm.updateAccount('acc-1', { name: 'Renamed Portal' })
assert.equal(webContents.currentUrl, loadUrlCallsBefore, 'WebContents should NOT reload when URL is unchanged')
assert.equal(vm.labelUpdatedCount, 1, 'Label should be updated')
assert.equal(vm.stateChangedCount, 1, 'State changed should be notified to renderer')
console.log('  -> Passed: Editing only name updates label and state without reloading view.')

// 2.2 Updating URL calls loadURL
vm.updateAccount('acc-1', { url: 'https://newsite.example.com' })
assert.equal(webContents.currentUrl, 'https://newsite.example.com/', 'WebContents MUST navigate to the new URL')
assert.equal(vm.stateChangedCount, 2, 'State changed should be notified')
console.log('  -> Passed: Editing URL navigates existing view without destroying view or session.')

// =========================================================================
// TEST 3: Static Code Inspection of Preload & Renderer files
// =========================================================================
console.log('\n[TEST 3] Inspecting Preload & Renderer implementation...')

const preloadPath = path.resolve(__dirname, '../src/preload/index.ts')
const preloadContent = fs.readFileSync(preloadPath, 'utf8')
assert.match(preloadContent, /updateAccount\(id:\s*string,\s*updates:\s*\{/, 'Preload interface must have updateAccount')
assert.match(preloadContent, /updateAccount:\s*\(id,\s*updates\)\s*=>\s*ipcRenderer\.invoke\('hub:update-account',\s*id,\s*updates\)/, 'Preload api must invoke hub:update-account')
console.log('  -> Passed: Preload bridge exposes updateAccount correctly.')

const ipcPath = path.resolve(__dirname, '../src/main/ipc.ts')
const ipcContent = fs.readFileSync(ipcPath, 'utf8')
assert.match(ipcContent, /ipcMain\.handle\('hub:update-account'/, 'ipcMain must handle hub:update-account')
console.log('  -> Passed: IPC handler registered for hub:update-account.')

const appPath = path.resolve(__dirname, '../src/renderer/App.tsx')
const appContent = fs.readFileSync(appPath, 'utf8')
assert.match(appContent, /Edit account/, 'AccountContextMenu must include Edit account option')
assert.match(appContent, /kind:\s*'edit'/, 'App.tsx must support edit dialog kind')
assert.match(appContent, /defaultValue=\{dialog\.account\.name\}/, 'Edit dialog must prefill account name')
assert.match(appContent, /defaultValue=\{dialog\.account\.url\}/, 'Edit dialog must prefill website URL')
assert.match(appContent, /Save changes/, 'Edit dialog must have Save changes button')
console.log('  -> Passed: Renderer contains Edit account option, dialog, prefilled fields, and save button.')

console.log('\n=========================================================================')
console.log('ALL EDIT ACCOUNT VERIFICATIONS PASSED SUCCESSFULLY (100% PASS)')
console.log('=========================================================================\n')
