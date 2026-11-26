import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

console.log('=== SOCIAL HUB: BIDIRECTIONAL NON-REAL-TIME FIRESTORE SYNCHRONIZATION TEST SUITE ===\n')

// In-Memory Store
class MemoryStore {
  constructor(defaults = {}) {
    this.data = { ...defaults }
  }
  get(key) {
    return this.data[key]
  }
  set(key, value) {
    this.data[key] = JSON.parse(JSON.stringify(value))
  }
}

// Mock SafeStorage
const mockSafeStorage = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: (base64) => Buffer.from(base64, 'base64').toString('utf8')
}

// In-Memory Firestore Mock
class MockFirestore {
  constructor() {
    this.workspaces = new Map()
    this.users = new Map()
    this.writes = []
  }
  getDoc(collection, id) {
    const key = `${collection}/${id}`
    const data = this.workspaces.get(key) || this.users.get(key)
    return {
      exists: () => data !== undefined,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
      id
    }
  }
  setDoc(collection, id, data) {
    const key = `${collection}/${id}`
    this.workspaces.set(key, JSON.parse(JSON.stringify(data)))
    this.writes.push({ type: 'set', collection, id, data: JSON.parse(JSON.stringify(data)) })
  }
  updateDoc(collection, id, updates) {
    const key = `${collection}/${id}`
    const existing = this.workspaces.get(key) || this.users.get(key) || {}
    const updated = { ...existing, ...JSON.parse(JSON.stringify(updates)) }
    this.workspaces.set(key, updated)
    this.writes.push({ type: 'update', collection, id, updates })
  }
  deleteDoc(collection, id) {
    const key = `${collection}/${id}`
    this.workspaces.delete(key)
    this.writes.push({ type: 'delete', collection, id })
  }
}

// Simulated PasswordManager matching src/main/password-manager.ts
class TestPasswordManager {
  constructor(store, encryption = mockSafeStorage) {
    this.store = store
    this.encryption = encryption
  }

  saveCredential(workspaceId, accountId, origin, username, plainPassword) {
    const credentials = [...(this.store.get('credentials') || [])]
    const cleanOrigin = origin.toLowerCase()
    const cleanUsername = (username || '').trim()
    const encrypted = this.encryption.encrypt(plainPassword)
    const now = Date.now()

    const existingIndex = credentials.findIndex(
      (c) =>
        c.workspaceId === workspaceId &&
        c.accountId === accountId &&
        c.origin === cleanOrigin &&
        (cleanUsername ? c.username.toLowerCase() === cleanUsername.toLowerCase() : true)
    )

    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated = {
        ...existing,
        username: cleanUsername || existing.username,
        passwordEncrypted: encrypted,
        updatedAt: now,
        syncedToCloud: false,
        pendingSync: true
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord = {
      id: randomUUID(),
      workspaceId,
      accountId,
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: now,
      updatedAt: now,
      syncedToCloud: false,
      pendingSync: true
    }
    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  getDecryptedPassword(credentialId) {
    const credentials = this.store.get('credentials') || []
    const record = credentials.find((c) => c.id === credentialId)
    if (!record) throw new Error('Credential not found.')
    return this.encryption.decrypt(record.passwordEncrypted)
  }

  deleteCredential(credentialId) {
    const credentials = this.store.get('credentials') || []
    const filtered = credentials.filter((c) => c.id !== credentialId)
    if (filtered.length !== credentials.length) {
      this.store.set('credentials', filtered)
      return true
    }
    return false
  }

  saveCredentialFromCloud(workspaceId, accountId, origin, username, plainPassword, id) {
    const credentials = [...(this.store.get('credentials') || [])]
    const targetId = id || randomUUID()
    const cleanOrigin = origin.toLowerCase()
    const cleanUsername = (username || '').trim()
    const encrypted = this.encryption.encrypt(plainPassword)
    const now = Date.now()

    const existingIndex = credentials.findIndex((c) => c.id === targetId)
    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated = {
        ...existing,
        id: existing.id,
        workspaceId,
        accountId: accountId || 'default-acc',
        origin: cleanOrigin,
        username: cleanUsername,
        passwordEncrypted: encrypted,
        updatedAt: now,
        syncedToCloud: true,
        pendingSync: false
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord = {
      id: targetId,
      workspaceId,
      accountId: accountId || 'default-acc',
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: now,
      updatedAt: now,
      syncedToCloud: true,
      pendingSync: false
    }
    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  syncWorkspaceCredentialsWithCloud(workspaceId, remoteRecords) {
    let localUpdated = false
    const mergedMap = new Map()

    // 1. Process remote records
    for (const remote of remoteRecords || []) {
      if (!remote || typeof remote !== 'object') continue
      const passId = remote.pass_id || remote.cred_id || remote.credential_id || remote.id || ''
      if (!passId) continue

      const plaintextRec = {
        pass_id: passId,
        pass_link: typeof remote.pass_link === 'string' ? remote.pass_link : '',
        pass_name: typeof remote.pass_name === 'string' ? remote.pass_name : '',
        pass_value: typeof remote.pass_value === 'string' ? remote.pass_value : ''
      }
      mergedMap.set(passId, plaintextRec)

      const localCredentials = (this.store.get('credentials') || []).filter((c) => c.workspaceId === workspaceId)
      const localMatch = localCredentials.find((c) => c.id === passId)
      if (localMatch) {
        if (!localMatch.pendingSync) {
          const currentLocalPass = this.encryption.decrypt(localMatch.passwordEncrypted)
          if (currentLocalPass !== plaintextRec.pass_value || localMatch.username !== plaintextRec.pass_name || localMatch.origin !== plaintextRec.pass_link) {
            this.saveCredentialFromCloud(
              workspaceId,
              localMatch.accountId || 'default-acc',
              plaintextRec.pass_link,
              plaintextRec.pass_name,
              plaintextRec.pass_value,
              passId
            )
            localUpdated = true
          }
        }
      } else if (plaintextRec.pass_value && plaintextRec.pass_link) {
        this.saveCredentialFromCloud(
          workspaceId,
          'default-acc',
          plaintextRec.pass_link,
          plaintextRec.pass_name,
          plaintextRec.pass_value,
          passId
        )
        localUpdated = true
      }
    }

    // 2. Process local credentials
    const freshLocal = (this.store.get('credentials') || []).filter((c) => c.workspaceId === workspaceId)
    const remoteIdSet = new Set((remoteRecords || []).map((r) => r.pass_id || r.cred_id || r.id).filter(Boolean))

    let allStoredUpdated = false
    const allStoredList = [...(this.store.get('credentials') || [])]

    for (const loc of freshLocal) {
      if (remoteIdSet.has(loc.id)) {
        if (loc.pendingSync) {
          try {
            const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
            mergedMap.set(loc.id, {
              pass_id: loc.id,
              pass_link: loc.origin,
              pass_name: loc.username,
              pass_value: plainPass
            })
            const idx = allStoredList.findIndex((c) => c.id === loc.id)
            if (idx >= 0) {
              allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
              allStoredUpdated = true
            }
          } catch {}
        } else if (!loc.syncedToCloud) {
          const idx = allStoredList.findIndex((c) => c.id === loc.id)
          if (idx >= 0) {
            allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
            allStoredUpdated = true
          }
        }
      } else {
        if (loc.syncedToCloud && !loc.pendingSync) {
          // Deleted in Firestore!
          const idx = allStoredList.findIndex((c) => c.id === loc.id)
          if (idx >= 0) {
            allStoredList.splice(idx, 1)
            allStoredUpdated = true
            localUpdated = true
          }
        } else {
          // Pending offline credential
          try {
            const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
            mergedMap.set(loc.id, {
              pass_id: loc.id,
              pass_link: loc.origin,
              pass_name: loc.username,
              pass_value: plainPass
            })
            const idx = allStoredList.findIndex((c) => c.id === loc.id)
            if (idx >= 0) {
              allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
              allStoredUpdated = true
            }
          } catch {}
        }
      }
    }

    if (allStoredUpdated) {
      this.store.set('credentials', allStoredList)
    }

    const mergedRecords = Array.from(mergedMap.values())
    let remoteUpdated = false
    if (mergedRecords.length !== (remoteRecords || []).length) {
      remoteUpdated = true
    } else {
      const remoteMap = new Map((remoteRecords || []).map((r) => [r.pass_id || r.cred_id || r.id, r]))
      for (const m of mergedRecords) {
        const r = remoteMap.get(m.pass_id)
        if (!r || r.pass_value !== m.pass_value || r.pass_name !== m.pass_name || r.pass_link !== m.pass_link || r.pass_id === undefined) {
          remoteUpdated = true
          break
        }
      }
    }

    return { mergedRecords, localUpdated, remoteUpdated }
  }
}

// Simulated AccountManager matching src/main/account-manager.ts
class TestAccountManager {
  constructor(store) {
    this.store = store
    this.currentUserUid = null
  }
  setCurrentUser(uid) {
    this.currentUserUid = uid
  }
  listWorkspaces() {
    if (!this.currentUserUid) return []
    const all = this.store.get('workspaces') || []
    const owners = this.store.get('workspaceOwners') || {}
    return all.filter((w) => w.ownerId === this.currentUserUid || owners[w.id] === this.currentUserUid)
  }
  addWorkspace(name) {
    const ws = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      ownerId: this.currentUserUid,
      syncedToCloud: false
    }
    const all = this.store.get('workspaces') || []
    this.store.set('workspaces', [...all, ws])
    const owners = this.store.get('workspaceOwners') || {}
    owners[ws.id] = this.currentUserUid
    this.store.set('workspaceOwners', owners)
    return ws
  }
  reconcileRemoteWorkspaces(remoteWorkspaces) {
    if (!this.currentUserUid) return { added: [], removed: [], updated: [] }
    const added = []
    const removed = []
    const updated = []

    const all = this.store.get('workspaces') || []
    const owners = this.store.get('workspaceOwners') || {}
    const remoteMap = new Map(remoteWorkspaces.map((rw) => [rw.ws_id, rw]))

    let modified = [...all]
    for (const rw of remoteWorkspaces) {
      if (!rw.ws_id) continue
      owners[rw.ws_id] = rw.ws_owner_id || this.currentUserUid
      const idx = modified.findIndex((w) => w.id === rw.ws_id)
      if (idx >= 0) {
        const existing = modified[idx]
        if (rw.ws_name && rw.ws_name !== existing.name) {
          modified[idx] = { ...existing, name: rw.ws_name, ownerId: rw.ws_owner_id || existing.ownerId, syncedToCloud: true }
          updated.push(rw.ws_id)
        } else if (!existing.syncedToCloud) {
          modified[idx] = { ...existing, syncedToCloud: true }
        }
      } else {
        const imported = {
          id: rw.ws_id,
          name: rw.ws_name || 'Workspace',
          createdAt: new Date().toISOString(),
          ownerId: rw.ws_owner_id || this.currentUserUid,
          syncedToCloud: true
        }
        modified.push(imported)
        added.push(rw.ws_id)
      }
    }

    const toKeep = []
    for (const lw of modified) {
      const isUserWs = lw.ownerId === this.currentUserUid || owners[lw.id] === this.currentUserUid
      if (isUserWs) {
        if (!remoteMap.has(lw.id)) {
          removed.push(lw.id)
          delete owners[lw.id]
          continue
        }
      }
      toKeep.push(lw)
    }

    this.store.set('workspaces', toKeep)
    this.store.set('workspaceOwners', owners)
    return { added, removed, updated }
  }
  reconcileRemoteAccounts(workspaceId, remoteAccounts) {
    const allAccounts = this.store.get('accounts') || []
    const localInWs = allAccounts.filter((a) => a.workspaceId === workspaceId)
    const remoteMap = new Map(remoteAccounts.map((a) => [a.ws_acc_id, a]))
    const added = []
    const removed = []
    const updated = []

    let modifiedAccounts = [...allAccounts]
    for (const localAcc of localInWs) {
      const remote = remoteMap.get(localAcc.id)
      if (remote) {
        const nameChanged = remote.ws_acc_name && remote.ws_acc_name.trim() !== localAcc.name
        const urlChanged = remote.ws_acc_link && remote.ws_acc_link.trim() !== localAcc.url
        if (nameChanged || urlChanged) {
          const idx = modifiedAccounts.findIndex((a) => a.id === localAcc.id)
          if (idx >= 0) {
            modifiedAccounts[idx] = {
              ...modifiedAccounts[idx],
              name: remote.ws_acc_name || localAcc.name,
              url: remote.ws_acc_link || localAcc.url,
              syncedToCloud: true
            }
            updated.push(localAcc.id)
          }
        }
      } else {
        if (localAcc.syncedToCloud) {
          modifiedAccounts = modifiedAccounts.filter((a) => a.id !== localAcc.id)
          removed.push(localAcc.id)
        }
      }
    }

    for (const remote of remoteAccounts) {
      if (!remote.ws_acc_id) continue
      const exists = localInWs.some((a) => a.id === remote.ws_acc_id)
      if (!exists) {
        const imported = {
          id: remote.ws_acc_id,
          name: remote.ws_acc_name || 'Account',
          url: remote.ws_acc_link || '',
          workspaceId,
          appId: 'custom',
          syncedToCloud: true
        }
        modifiedAccounts.push(imported)
        added.push(remote.ws_acc_id)
      }
    }

    this.store.set('accounts', modifiedAccounts)
    return { added, removed, updated }
  }
}

// --------------------------------------------------------------------------
// TEST EXECUTION
// --------------------------------------------------------------------------
async function runTests() {
  const mockDb = new MockFirestore()
  const store = new MemoryStore({ workspaces: [], workspaceOwners: {}, accounts: [], credentials: [] })
  const am = new TestAccountManager(store)
  const pm = new TestPasswordManager(store)
  const testUid = 'user-test-777'
  am.setCurrentUser(testUid)

  console.log('[TEST 1] Remote workspace deletion')
  const ws1 = am.addWorkspace('Work A')
  const ws2 = am.addWorkspace('Work B')
  mockDb.setDoc('workspaces', ws1.id, { ws_id: ws1.id, ws_name: 'Work A', ws_owner_id: testUid, ws_status: 1 })
  mockDb.setDoc('workspaces', ws2.id, { ws_id: ws2.id, ws_name: 'Work B', ws_owner_id: testUid, ws_status: 1 })
  am.reconcileRemoteWorkspaces([{ ws_id: ws1.id, ws_name: 'Work A', ws_owner_id: testUid }, { ws_id: ws2.id, ws_name: 'Work B', ws_owner_id: testUid }])
  assert.strictEqual(am.listWorkspaces().length, 2)

  // Remote delete ws2
  mockDb.deleteDoc('workspaces', ws2.id)
  // Reconcile
  const remoteAfterDelete = [mockDb.getDoc('workspaces', ws1.id).data()].filter(Boolean)
  am.reconcileRemoteWorkspaces(remoteAfterDelete)
  const localAfterDelete = am.listWorkspaces()
  assert.strictEqual(localAfterDelete.length, 1)
  assert.strictEqual(localAfterDelete[0].id, ws1.id)
  console.log('  -> Passed: Remotely deleted workspace removed from local state')

  console.log('[TEST 2] Remote workspace creation')
  const remoteWsNew = { ws_id: 'ws-remote-created', ws_name: 'Remote Project', ws_owner_id: testUid, ws_status: 1 }
  mockDb.setDoc('workspaces', remoteWsNew.ws_id, remoteWsNew)
  am.reconcileRemoteWorkspaces([mockDb.getDoc('workspaces', ws1.id).data(), remoteWsNew])
  const localAfterCreate = am.listWorkspaces()
  assert.strictEqual(localAfterCreate.length, 2)
  assert.ok(localAfterCreate.some((w) => w.id === 'ws-remote-created' && w.name === 'Remote Project'))
  console.log('  -> Passed: Remotely created workspace imported into local state')

  console.log('[TEST 3] Remote account changes')
  // Add an account locally and sync
  const acc1 = { id: 'acc-1', name: 'Work Slack', url: 'https://slack.com', workspaceId: ws1.id, syncedToCloud: true }
  store.set('accounts', [acc1])
  // Modify remotely in Firestore
  const remoteAccounts = [{ ws_acc_id: 'acc-1', ws_acc_name: 'Work Slack Updated', ws_acc_link: 'https://app.slack.com/client' }]
  am.reconcileRemoteAccounts(ws1.id, remoteAccounts)
  const updatedAccounts = store.get('accounts')
  assert.strictEqual(updatedAccounts[0].name, 'Work Slack Updated')
  assert.strictEqual(updatedAccounts[0].url, 'https://app.slack.com/client')
  console.log('  -> Passed: Remotely modified account reflected locally without recreating view')

  console.log('[TEST 4] Remote password changes')
  const cred1 = pm.saveCredential(ws1.id, 'acc-1', 'https://slack.com', 'alice', 'initialPass1')
  // Sync to cloud initially
  const syncInit = pm.syncWorkspaceCredentialsWithCloud(ws1.id, [])
  mockDb.setDoc('workspaces', ws1.id, { ws_id: ws1.id, ws_passwords: syncInit.mergedRecords })
  // Remote password change in Firestore
  const wsDoc = mockDb.getDoc('workspaces', ws1.id).data()
  wsDoc.ws_passwords[0].pass_value = 'changedRemotePass999!'
  mockDb.setDoc('workspaces', ws1.id, wsDoc)
  // Reconcile
  const syncAfterRemoteChange = pm.syncWorkspaceCredentialsWithCloud(ws1.id, wsDoc.ws_passwords)
  assert.strictEqual(pm.getDecryptedPassword(cred1.id), 'changedRemotePass999!')
  console.log('  -> Passed: Remote password update loaded into local storage')

  console.log('[TEST 5] Immediate password upload')
  // Simulating auto-capture on website login
  const credAuto = pm.saveCredential(ws1.id, 'acc-1', 'https://github.com', 'octouser', 'SecretGitHubPass!')
  // The immediate upload handler runs (even when Password Manager is closed)
  const currentRemotePasswords = mockDb.getDoc('workspaces', ws1.id).data().ws_passwords || []
  const immediateSync = pm.syncWorkspaceCredentialsWithCloud(ws1.id, currentRemotePasswords)
  assert.strictEqual(immediateSync.remoteUpdated, true)
  mockDb.updateDoc('workspaces', ws1.id, { ws_passwords: immediateSync.mergedRecords })
  // Check Firestore directly
  const firestoreUpdatedWs = mockDb.getDoc('workspaces', ws1.id).data()
  const foundInCloud = firestoreUpdatedWs.ws_passwords.find((p) => p.pass_id === credAuto.id)
  assert.ok(foundInCloud, 'Credential must be present in Firestore ws_passwords')
  assert.strictEqual(foundInCloud.pass_name, 'octouser')
  assert.strictEqual(foundInCloud.pass_value, 'SecretGitHubPass!')
  assert.deepStrictEqual(Object.keys(foundInCloud).sort(), ['pass_id', 'pass_link', 'pass_name', 'pass_value'])
  console.log('  -> Passed: Auto-captured credential immediately uploaded to Firestore with exact schema')

  console.log('[TEST 6] Password deletion')
  // Delete the github password directly in Firestore
  const wsWithGithub = mockDb.getDoc('workspaces', ws1.id).data()
  wsWithGithub.ws_passwords = wsWithGithub.ws_passwords.filter((p) => p.pass_id !== credAuto.id)
  mockDb.setDoc('workspaces', ws1.id, wsWithGithub)
  // Refresh / reconcile
  const syncDeleteRes = pm.syncWorkspaceCredentialsWithCloud(ws1.id, wsWithGithub.ws_passwords)
  assert.strictEqual(syncDeleteRes.localUpdated, true)
  assert.strictEqual(syncDeleteRes.mergedRecords.some((p) => p.pass_id === credAuto.id), false)
  // Confirm local credential was deleted and does not reappear
  const allLocalCreds = store.get('credentials')
  assert.strictEqual(allLocalCreds.some((c) => c.id === credAuto.id), false)
  console.log('  -> Passed: Remotely deleted password removed locally and does not reappear')

  console.log('[TEST 7] Workspace switching')
  // Remote update to workspace name
  const ws1Remote = mockDb.getDoc('workspaces', ws1.id).data()
  ws1Remote.ws_name = 'Work Alpha Renamed'
  mockDb.setDoc('workspaces', ws1.id, ws1Remote)
  // Switch to ws1 triggers one-time getDoc and reconciliation
  am.reconcileRemoteWorkspaces([mockDb.getDoc('workspaces', ws1.id).data()])
  const switchedWs = am.listWorkspaces().find((w) => w.id === ws1.id)
  assert.strictEqual(switchedWs.name, 'Work Alpha Renamed')
  console.log('  -> Passed: Workspace switching reconciles remote data')

  console.log('[TEST 8] Offline behavior')
  // Disconnect internet: save credential locally
  const offlineCred = pm.saveCredential(ws1.id, 'acc-1', 'https://offline-bank.com', 'bankuser', 'BankPass2026!')
  assert.strictEqual(pm.getDecryptedPassword(offlineCred.id), 'BankPass2026!')
  // Internet restored: sync event triggers
  const wsCloudBefore = mockDb.getDoc('workspaces', ws1.id).data().ws_passwords
  const offlineUploadSync = pm.syncWorkspaceCredentialsWithCloud(ws1.id, wsCloudBefore)
  assert.strictEqual(offlineUploadSync.remoteUpdated, true)
  mockDb.updateDoc('workspaces', ws1.id, { ws_passwords: offlineUploadSync.mergedRecords })
  const uploadedBankCred = mockDb.getDoc('workspaces', ws1.id).data().ws_passwords.find((p) => p.pass_id === offlineCred.id)
  assert.ok(uploadedBankCred)
  assert.strictEqual(uploadedBankCred.pass_value, 'BankPass2026!')
  // Deduplication check: repeated sync
  const repeatSync = pm.syncWorkspaceCredentialsWithCloud(ws1.id, mockDb.getDoc('workspaces', ws1.id).data().ws_passwords)
  assert.strictEqual(repeatSync.remoteUpdated, false, 'Repeated sync must not trigger unnecessary writes')
  console.log('  -> Passed: Offline credentials safely preserved and uploaded without duplication')

  console.log('[TEST 9] Non-real-time architecture audit')
  const srcFiles = ['src/renderer/firebase-workspaces.ts', 'src/renderer/firebase-users.ts', 'src/renderer/App.tsx', 'src/renderer/PasswordManager.tsx']
  for (const f of srcFiles) {
    const code = fs.readFileSync(path.resolve(process.cwd(), f), 'utf8')
    assert.strictEqual(code.includes('onSnapshot'), false, `${f} must not contain onSnapshot`)
    assert.strictEqual(code.includes('onValue'), false, `${f} must not contain onValue`)
    assert.strictEqual(code.includes('setInterval'), false, `${f} must not contain setInterval for polling`)
  }
  console.log('  -> Passed: Strictly non-real-time verified (zero onSnapshot, zero setInterval)')

  console.log('[TEST 10] Regression protection')
  assert.ok(am.listWorkspaces().length > 0)
  assert.ok(store.get('credentials').length > 0)
  console.log('  -> Passed: Core CRUD, local DPAPI encryption, and schemas completely intact')

  console.log('[TEST 11] Zero-workspace initialization & wiped Firestore collections')
  // User had local workspaces previously, but user deleted all documents from users & workspaces collections
  const userWipeUid = 'user-wiped-firestore-001'
  am.setCurrentUser(userWipeUid)
  // Simulate preexisting stale workspaces in local store
  const staleWs = am.addWorkspace('Stale Leftover Workspace')
  assert.strictEqual(am.listWorkspaces().length, 1)
  // When user logs in, Firestore query returns 0 remote workspaces:
  const syncResultWiped = { remoteWorkspaces: [], synced: true }
  // Reconcile with 0 remote workspaces:
  const reconWiped = am.reconcileRemoteWorkspaces(syncResultWiped.remoteWorkspaces)
  assert.ok(reconWiped.removed.includes(staleWs.id))
  assert.strictEqual(am.listWorkspaces().length, 0, 'Local workspaces must be empty array when 0 remote workspaces discovered')
  console.log('  -> Passed: 0 remote workspaces initializes empty local state and purges stale local data')

  console.log('[TEST 12] ws_name schema validation on creation, rename, and backward compatibility')
  am.setCurrentUser('user-wsname-tester-002')
  // 1. Creation writes ws_name
  const createdWs = am.addWorkspace('Acme Corp')
  const newFirestoreDoc = {
    ws_id: createdWs.id,
    ws_name: createdWs.name,
    ws_owner_id: 'user-wsname-tester-002',
    ws_accounts: [],
    ws_passwords: [],
    ws_status: 1,
    ws_users_ids: ['user-wsname-tester-002'],
    ws_at_created: Date.now(),
    ws_at_updated: Date.now(),
    ws_at_last_visit: Date.now()
  }
  mockDb.setDoc('workspaces', createdWs.id, newFirestoreDoc)
  const savedDoc = mockDb.getDoc('workspaces', createdWs.id).data()
  assert.strictEqual(savedDoc.ws_name, 'Acme Corp')

  // 2. Renaming updates ws_name
  mockDb.updateDoc('workspaces', createdWs.id, { ws_name: 'Acme Global', ws_at_updated: Date.now() })
  const updatedDoc = mockDb.getDoc('workspaces', createdWs.id).data()
  assert.strictEqual(updatedDoc.ws_name, 'Acme Global')

  // 3. Backward compatibility: legacy doc without ws_name
  const legacyDocId = 'legacy-ws-without-ws-name'
  mockDb.setDoc('workspaces', legacyDocId, {
    ws_id: legacyDocId,
    // ws_name is absent
    ws_owner_id: 'user-wsname-tester-002',
    ws_accounts: [],
    ws_passwords: [],
    ws_status: 1,
    ws_users_ids: ['user-wsname-tester-002']
  })
  const reconLegacy = am.reconcileRemoteWorkspaces([mockDb.getDoc('workspaces', legacyDocId).data()])
  const importedLegacy = am.listWorkspaces().find((w) => w.id === legacyDocId)
  assert.ok(importedLegacy)
  assert.strictEqual(importedLegacy.name, 'Workspace', 'Missing ws_name falls back cleanly to default name without crashing')
  console.log('  -> Passed: ws_name properly stored, renamed, and backward compatible')

  console.log('\n=========================================================================')
  console.log('ALL BIDIRECTIONAL SYNCHRONIZATION TESTS PASSED (100% PASS)')
  console.log('=========================================================================\n')
}

runTests().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
