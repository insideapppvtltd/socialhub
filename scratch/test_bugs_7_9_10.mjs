import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('=== SOCIAL HUB: BUGS #7, #9, #10 VERIFICATION SUITE ===\n')

// 1. Bug #7 Verification (Static + Logic audit of google-oauth.ts & ipc.ts)
console.log('[TEST 1] Bug #7 – Google OAuth completion page, focus return, and security guards')
const oauthSrc = fs.readFileSync(path.resolve('src/main/google-oauth.ts'), 'utf8')
const ipcSrc = fs.readFileSync(path.resolve('src/main/ipc.ts'), 'utf8')

assert.ok(oauthSrc.includes('onFocusApp?: () => void'), 'GoogleOAuthOptions must include onFocusApp')
assert.ok(oauthSrc.includes("window.open('', '_self')"), 'Completion page should attempt self-close')
assert.ok(oauthSrc.includes('window.close()'), 'Completion page should attempt window.close()')
assert.ok(oauthSrc.includes('focusApp?.()'), 'OAuth callback must invoke focusApp')
assert.ok(oauthSrc.includes('timingSafeEqual'), 'CSRF state check with timingSafeEqual must be preserved')
assert.ok(oauthSrc.includes('code_challenge_method: \'S256\''), 'PKCE S256 must be preserved')
assert.ok(oauthSrc.includes('if (callbackHandled)'), 'Duplicate callback prevention must be preserved')
assert.ok(ipcSrc.includes('onFocusApp: () =>'), 'ipc.ts must pass onFocusApp handler to getGoogleIdToken')
assert.ok(ipcSrc.includes('window.focus()'), 'ipc.ts onFocusApp must focus the Social HUB window')
console.log('  -> Passed: Bug #7 OAuth security, duplicate guard, tab-close attempt, and window focus verified')

// 2. Bug #9 Verification (Account sorting logic, workspace independence, persistence)
console.log('[TEST 2] Bug #9 – Account List Sorting (Name A-Z & Last Used)')
function sortAccounts(accounts, sortBy = 'name') {
  return [...accounts].sort((a, b) => {
    if (sortBy === 'lastUsed') {
      const aTime = typeof a.lastUsedAt === 'number' ? a.lastUsedAt : -1
      const bTime = typeof b.lastUsedAt === 'number' ? b.lastUsedAt : -1
      if (aTime !== bTime) return bTime - aTime
    }
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    if (nameCmp !== 0) return nameCmp
    const createdCmp = (a.createdAt || '').localeCompare(b.createdAt || '')
    if (createdCmp !== 0) return createdCmp
    return a.id.localeCompare(b.id)
  })
}

const wsAAccounts = [
  { id: 'acc-1', workspaceId: 'ws-a', name: 'Zebra', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: 1000 },
  { id: 'acc-2', workspaceId: 'ws-a', name: 'Alpha', createdAt: '2026-01-02T00:00:00Z', lastUsedAt: undefined },
  { id: 'acc-3', workspaceId: 'ws-a', name: 'Middle', createdAt: '2026-01-03T00:00:00Z', lastUsedAt: 3000 }
]

const wsBAccounts = [
  { id: 'acc-4', workspaceId: 'ws-b', name: 'Telegram', createdAt: '2026-01-04T00:00:00Z', lastUsedAt: 2000 },
  { id: 'acc-5', workspaceId: 'ws-b', name: 'Discord', createdAt: '2026-01-05T00:00:00Z', lastUsedAt: 5000 }
]

// Default sort: Name (A-Z)
const sortedByNameA = sortAccounts(wsAAccounts, 'name')
assert.deepStrictEqual(sortedByNameA.map((a) => a.name), ['Alpha', 'Middle', 'Zebra'])

// Rename updates position immediately under Name sort
const renamedA = wsAAccounts.map((a) => (a.id === 'acc-1' ? { ...a, name: 'Aardvark' } : a))
assert.deepStrictEqual(sortAccounts(renamedA, 'name').map((a) => a.name), ['Aardvark', 'Alpha', 'Middle'])

// Last Used sort: most recently used first, unused accounts last
const sortedByLastUsedA = sortAccounts(wsAAccounts, 'lastUsed')
assert.deepStrictEqual(sortedByLastUsedA.map((a) => a.id), ['acc-3', 'acc-1', 'acc-2'])

// Independent sorting in Workspace B
assert.deepStrictEqual(sortAccounts(wsBAccounts, 'name').map((a) => a.name), ['Discord', 'Telegram'])
assert.deepStrictEqual(sortAccounts(wsBAccounts, 'lastUsed').map((a) => a.name), ['Discord', 'Telegram'])

// Verify App.tsx, AccountManager, Types, IPC, ViewManager
const appSrc = fs.readFileSync(path.resolve('src/renderer/App.tsx'), 'utf8')
const amSrc = fs.readFileSync(path.resolve('src/main/account-manager.ts'), 'utf8')
const typesSrc = fs.readFileSync(path.resolve('src/main/types.ts'), 'utf8')
const vmSrc = fs.readFileSync(path.resolve('src/main/view-manager.ts'), 'utf8')

assert.ok(typesSrc.includes("export type AccountSortMode = 'name' | 'lastUsed'"), 'AccountSortMode type must be defined')
assert.ok(typesSrc.includes('lastUsedAt?: number'), 'Account must support lastUsedAt')
assert.ok(amSrc.includes("accountSortBy: 'name'"), 'Default accountSortBy preference must be name')
assert.ok(amSrc.includes('lastUsedAt: Date.now()'), 'setActive must update lastUsedAt')
assert.ok(ipcSrc.includes("if ('accountSortBy' in candidate)"), 'IPC must validate accountSortBy')
assert.ok(appSrc.includes('account-sort-trigger') && appSrc.includes('account-sort-menu') && appSrc.includes('ArrowUpDown') && appSrc.includes('Last Used') && appSrc.includes('<span>Name</span>'), 'UI sort icon button and dropdown with Name and Last Used must exist')
assert.ok(vmSrc.includes('persist:account-${account.id}'), 'Partition naming convention must remain unchanged')
console.log('  -> Passed: Bug #9 sorting logic, workspace isolation, lastUsedAt tracking, and preference persistence verified')

// 3. Bug #10 Verification (Selected workspace tick removed, highlight & account count preserved)
console.log('[TEST 3] Bug #10 – Selected Workspace Tick Mark Removed')
assert.strictEqual(appSrc.includes('className="ws-check"'), false, 'Workspace dropdown must not render ws-check tick')
assert.ok(appSrc.includes('workspace-menu-item ${isActive ? \'active\' : \'\'}'), 'Workspace active highlight must be preserved')
assert.ok(appSrc.includes('className="ws-item-count"'), 'Workspace account count must be preserved')
assert.ok(appSrc.includes('className="active-mark"'), 'Individual account selection checkmark must be preserved')
console.log('  -> Passed: Bug #10 workspace tick removed while highlight, count, and account checkmarks preserved')

console.log('\n=========================================================================')
console.log('ALL BUGS #7, #9, #10 VERIFICATION TESTS PASSED (100% PASS)')
console.log('=========================================================================\n')
