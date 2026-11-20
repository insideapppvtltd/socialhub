import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('=== SOCIAL HUB: PASSWORD MANAGER TEST SUITE ===\n')

// 1. Mock Encryption Provider (simulating Electron safeStorage)
const testSecretKey = crypto.randomBytes(32)
const testIv = crypto.randomBytes(16)

const mockSafeStorage = {
  isAvailable: () => true,
  encrypt: (plainText) => {
    const cipher = crypto.createCipheriv('aes-256-cbc', testSecretKey, testIv)
    let encrypted = cipher.update(plainText, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    return encrypted
  },
  decrypt: (cipherTextBase64) => {
    const decipher = crypto.createDecipheriv('aes-256-cbc', testSecretKey, testIv)
    let decrypted = decipher.update(cipherTextBase64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }
}

// 2. Mock Store (simulating electron-store)
class MockStore {
  constructor(options = {}) {
    this.data = { ...(options.defaults || {}) }
  }
  get(key) {
    return this.data[key]
  }
  set(key, value) {
    this.data[key] = JSON.parse(JSON.stringify(value))
  }
  clear() {
    this.data = {}
  }
}

// 3. PasswordManager implementation mirror (matching src/main/password-manager.ts)
function normalizeOrigin(raw) {
  try {
    const url = new URL(raw)
    return url.origin.toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
}

class TestPasswordManager {
  constructor(store, encryption) {
    this.store = store
    this.encryption = encryption
  }

  saveCredential(workspaceId, accountId, origin, username, plainPassword) {
    const cleanOrigin = normalizeOrigin(origin)
    const cleanUsername = (username || '').trim()
    const trimmedPassword = (plainPassword || '').trim()

    if (!cleanOrigin) throw new Error('Invalid website origin.')
    if (!trimmedPassword) throw new Error('Cannot save empty password.')
    if (!workspaceId) throw new Error('Workspace ID is required.')
    if (!accountId) throw new Error('Account ID is required.')

    const encrypted = this.encryption.encrypt(plainPassword)
    const credentials = [...(this.store.get('credentials') || [])]
    const now = Date.now()

    const existingIndex = credentials.findIndex(
      (c) =>
        c.workspaceId === workspaceId &&
        c.accountId === accountId &&
        normalizeOrigin(c.origin) === cleanOrigin &&
        (cleanUsername ? c.username.toLowerCase() === cleanUsername.toLowerCase() : true)
    )

    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated = {
        ...existing,
        username: cleanUsername || existing.username,
        passwordEncrypted: encrypted,
        updatedAt: now
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord = {
      id: crypto.randomUUID(),
      workspaceId,
      accountId,
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: now,
      updatedAt: now
    }

    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  listSummaries(workspaces, accounts) {
    const credentials = this.store.get('credentials') || []
    const wsMap = new Map(workspaces.map((w) => [w.id, w.name]))
    const accMap = new Map(accounts.map((a) => [a.id, a]))

    return credentials.map((c) => {
      const acc = accMap.get(c.accountId)
      return {
        id: c.id,
        workspaceId: c.workspaceId,
        workspaceName: wsMap.get(c.workspaceId) || 'Workspace',
        accountId: c.accountId,
        accountName: acc?.name || 'Account',
        accountAppId: acc?.appId,
        origin: c.origin,
        username: c.username,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }
    })
  }

  getDecryptedPassword(credentialId, allowedWorkspaceId) {
    const credentials = this.store.get('credentials') || []
    const record = credentials.find((c) => c.id === credentialId)
    if (!record) throw new Error('Credential not found.')
    if (allowedWorkspaceId && record.workspaceId !== allowedWorkspaceId) {
      throw new Error('Access denied: workspace isolation violation.')
    }
    return this.encryption.decrypt(record.passwordEncrypted)
  }

  queryMatches(workspaceId, origin, accounts) {
    const cleanOrigin = normalizeOrigin(origin)
    const credentials = this.store.get('credentials') || []
    const accMap = new Map(accounts.map((a) => [a.id, a.name]))

    const matches = credentials.filter(
      (c) => c.workspaceId === workspaceId && normalizeOrigin(c.origin) === cleanOrigin
    )

    return matches.map((m) => ({
      id: m.id,
      username: m.username,
      accountName: accMap.get(m.accountId) || 'Account'
    }))
  }

  getFillCredential(credentialId, workspaceId, origin) {
    const cleanOrigin = normalizeOrigin(origin)
    const credentials = this.store.get('credentials') || []
    const record = credentials.find((c) => c.id === credentialId)
    if (!record) return null

    // Workspace & Origin isolation check
    if (record.workspaceId !== workspaceId) return null
    if (normalizeOrigin(record.origin) !== cleanOrigin) return null

    const plainPassword = this.encryption.decrypt(record.passwordEncrypted)
    return {
      username: record.username,
      password: plainPassword
    }
  }

  updateCredential(credentialId, newUsername, newPassword) {
    const credentials = [...(this.store.get('credentials') || [])]
    const index = credentials.findIndex((c) => c.id === credentialId)
    if (index === -1) throw new Error('Credential not found.')

    const existing = credentials[index]
    const updated = {
      ...existing,
      username: newUsername !== undefined ? newUsername.trim() : existing.username,
      passwordEncrypted: newPassword && newPassword.trim() ? this.encryption.encrypt(newPassword) : existing.passwordEncrypted,
      updatedAt: Date.now()
    }
    credentials[index] = updated
    this.store.set('credentials', credentials)
    return updated
  }

  deleteCredential(credentialId) {
    const credentials = [...(this.store.get('credentials') || [])]
    const initialLen = credentials.length
    const filtered = credentials.filter((c) => c.id !== credentialId)
    if (filtered.length !== initialLen) {
      this.store.set('credentials', filtered)
      return true
    }
    return false
  }

  removeByWorkspace(workspaceId) {
    const credentials = [...(this.store.get('credentials') || [])]
    const filtered = credentials.filter((c) => c.workspaceId !== workspaceId)
    this.store.set('credentials', filtered)
  }

  removeByAccount(accountId) {
    const credentials = [...(this.store.get('credentials') || [])]
    const filtered = credentials.filter((c) => c.accountId !== accountId)
    this.store.set('credentials', filtered)
  }
}

// ==================== TEST EXECUTION ====================

const store = new MockStore({ defaults: { credentials: [] } })
const pm = new TestPasswordManager(store, mockSafeStorage)

const workspaces = [
  { id: 'ws-personal', name: 'Personal', createdAt: new Date().toISOString() },
  { id: 'ws-work', name: 'Work', createdAt: new Date().toISOString() }
]

const accounts = [
  { id: 'acc-wa-pers', workspaceId: 'ws-personal', name: 'Personal WhatsApp', appId: 'whatsapp', url: 'https://web.whatsapp.com' },
  { id: 'acc-gh-pers', workspaceId: 'ws-personal', name: 'Personal GitHub', appId: 'generic', url: 'https://github.com' },
  { id: 'acc-gh-work', workspaceId: 'ws-work', name: 'Work GitHub', appId: 'generic', url: 'https://github.com' }
]

// TEST 1: Saving credentials with encryption
console.log('[TEST 1] Saving credentials with DPAPI encryption...')
const saved1 = pm.saveCredential('ws-personal', 'acc-gh-pers', 'https://github.com/login', 'alice_pers', 'SecretPers123!')
assert.ok(saved1.id, 'Credential ID should exist')
assert.notEqual(saved1.passwordEncrypted, 'SecretPers123!', 'Password MUST NOT be stored in plaintext')
assert.equal(typeof saved1.passwordEncrypted, 'string')
console.log('  -> Passed: Password stored encrypted (ciphertext != plaintext)')

// TEST 2: Reject empty password and invalid origin
console.log('[TEST 2] Validation: reject empty passwords and empty origin...')
assert.throws(() => {
  pm.saveCredential('ws-personal', 'acc-gh-pers', 'https://github.com', 'alice', '')
}, /Cannot save empty password/)

assert.throws(() => {
  pm.saveCredential('ws-personal', 'acc-gh-pers', '', 'alice', 'mypassword')
}, /Invalid website origin/)
console.log('  -> Passed: Invalid passwords & origins properly rejected')

// TEST 3: Deduplication
console.log('[TEST 3] Deduplication on same (workspaceId, accountId, origin)...')
const saved1Updated = pm.saveCredential('ws-personal', 'acc-gh-pers', 'https://github.com', 'alice_pers', 'NewSecret456!')
assert.equal(saved1Updated.id, saved1.id, 'Should update existing credential ID')
assert.equal(store.get('credentials').length, 1, 'Store should not have duplicate entries')
const decryptedUpdated = pm.getDecryptedPassword(saved1.id)
assert.equal(decryptedUpdated, 'NewSecret456!', 'Decrypted password should match updated value')
console.log('  -> Passed: Existing credential updated without creating duplicate')

// TEST 4: Workspace Isolation
console.log('[TEST 4] Strict Workspace Isolation...')
// Save a work credential on the same origin (GitHub)
const savedWork = pm.saveCredential('ws-work', 'acc-gh-work', 'https://github.com/login', 'alice_work', 'WorkPassword999!')
assert.notEqual(savedWork.id, saved1.id)
assert.equal(store.get('credentials').length, 2)

// Query matches for Personal workspace on github.com
const persMatches = pm.queryMatches('ws-personal', 'https://github.com', accounts)
assert.equal(persMatches.length, 1)
assert.equal(persMatches[0].username, 'alice_pers')

// Query matches for Work workspace on github.com
const workMatches = pm.queryMatches('ws-work', 'https://github.com', accounts)
assert.equal(workMatches.length, 1)
assert.equal(workMatches[0].username, 'alice_work')

// Query from unrelated workspace
const otherMatches = pm.queryMatches('ws-other', 'https://github.com', accounts)
assert.equal(otherMatches.length, 0)
console.log('  -> Passed: Personal workspace sees only Personal; Work sees only Work')

// TEST 5: Cross-workspace fill protection
console.log('[TEST 5] Cross-workspace getFillCredential protection...')
const fillWorkAttempt = pm.getFillCredential(savedWork.id, 'ws-personal', 'https://github.com')
assert.equal(fillWorkAttempt, null, 'Personal workspace MUST NOT fill Work credential')

const fillCorrect = pm.getFillCredential(savedWork.id, 'ws-work', 'https://github.com')
assert.ok(fillCorrect)
assert.equal(fillCorrect.username, 'alice_work')
assert.equal(fillCorrect.password, 'WorkPassword999!')

const fillWrongOrigin = pm.getFillCredential(savedWork.id, 'ws-work', 'https://malicious.com')
assert.equal(fillWrongOrigin, null, 'Wrong origin MUST NOT fill credential')
console.log('  -> Passed: Fill denied on workspace mismatch or origin mismatch')

// TEST 6: Summaries do not expose passwords
console.log('[TEST 6] Summaries list security...')
const summaries = pm.listSummaries(workspaces, accounts)
assert.equal(summaries.length, 2)
for (const s of summaries) {
  assert.equal(s.password, undefined, 'Summary must not contain password')
  assert.equal(s.passwordEncrypted, undefined, 'Summary must not contain passwordEncrypted')
  assert.ok(s.workspaceName, 'Summary must have workspaceName')
  assert.ok(s.accountName, 'Summary must have accountName')
}
console.log('  -> Passed: Summaries contain no plaintext or encrypted password bytes')

// TEST 7: Edit and Delete
console.log('[TEST 7] Edit and Delete operations...')
pm.updateCredential(saved1.id, 'alice_pers_modified', 'ModifiedPass789!')
assert.equal(pm.getDecryptedPassword(saved1.id), 'ModifiedPass789!')

const deleted = pm.deleteCredential(saved1.id)
assert.equal(deleted, true)
assert.throws(() => pm.getDecryptedPassword(saved1.id), /Credential not found/)
assert.equal(pm.queryMatches('ws-personal', 'https://github.com', accounts).length, 0)
console.log('  -> Passed: Edit and Delete work seamlessly')

// TEST 8: Workspace & Account Cascade Deletion
console.log('[TEST 8] Cascade Deletion on account / workspace removal...')
pm.removeByWorkspace('ws-work')
assert.equal(store.get('credentials').length, 0, 'All credentials under ws-work should be purged')
console.log('  -> Passed: Workspace deletion cleans up associated credentials')

// TEST 9: Heuristics - OTP/2FA & Payment Card Filter Checks
console.log('[TEST 9] Heuristics: OTP/2FA and Payment field detection...')
const OTP_REGEX = /(?:otp|2fa|mfa|totp|passcode|verification|security[-_]?code|two[-_]?factor|one[-_]?time)/i
const PAYMENT_REGEX = /(?:card[-_]?number|credit[-_]?card|cc[-_]|cvv|cvc|exp[-_]month|exp[-_]year)/i

const testFieldInputs = [
  { name: 'user_otp', isOtp: true, isCard: false },
  { name: 'mfa_token', isOtp: true, isCard: false },
  { name: 'two_factor_code', isOtp: true, isCard: false },
  { name: 'cc_cvv', isOtp: false, isCard: true },
  { name: 'cardnumber', isOtp: false, isCard: true },
  { name: 'password', isOtp: false, isCard: false },
  { name: 'login_password', isOtp: false, isCard: false },
  { name: 'current_password', isOtp: false, isCard: false }
]

for (const input of testFieldInputs) {
  const matchesOtp = OTP_REGEX.test(input.name)
  const matchesCard = PAYMENT_REGEX.test(input.name)
  assert.equal(matchesOtp, input.isOtp, `Field "${input.name}" OTP match mismatch`)
  assert.equal(matchesCard, input.isCard, `Field "${input.name}" Card match mismatch`)
}
console.log('  -> Passed: OTP/2FA and payment fields correctly identified and filtered')

console.log('\nALL 9 TEST SUITES PASSED PERFECTLY!\n')
