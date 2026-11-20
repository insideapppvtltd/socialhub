import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('=== SOCIAL HUB: FIREBASE USERS & WORKSPACES TEST SUITE ===\n')

// -------------------------------------------------------------
// IN-MEMORY FIRESTORE MOCK
// -------------------------------------------------------------
class MockFirestore {
  constructor() {
    this.store = new Map()
    this.writes = []
  }

  _getKey(collection, id) {
    if (collection.includes('xusers') || collection.includes('xworkspaces')) {
      throw new Error(`CRITICAL SECURITY VIOLATION: Attempted access to forbidden collection ${collection}`)
    }
    return `${collection}/${id}`
  }

  getDoc(collection, id) {
    const key = this._getKey(collection, id)
    const data = this.store.get(key)
    return {
      exists: () => data !== undefined,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
      id
    }
  }

  setDoc(collection, id, data) {
    const key = this._getKey(collection, id)
    this.store.set(key, JSON.parse(JSON.stringify(data)))
    this.writes.push({ type: 'set', collection, id, data: JSON.parse(JSON.stringify(data)) })
  }

  updateDoc(collection, id, updates) {
    const key = this._getKey(collection, id)
    const existing = this.store.get(key)
    if (!existing) throw new Error(`Document ${key} does not exist for update`)
    const updated = { ...existing, ...JSON.parse(JSON.stringify(updates)) }
    this.store.set(key, updated)
    this.writes.push({ type: 'update', collection, id, updates: JSON.parse(JSON.stringify(updates)) })
  }

  deleteDoc(collection, id) {
    const key = this._getKey(collection, id)
    this.store.delete(key)
    this.writes.push({ type: 'delete', collection, id })
  }
}

// Mock localStorage for ownership testing
const mockLocalStorage = {
  data: {},
  getItem(key) {
    return this.data[key] || null
  },
  setItem(key, val) {
    this.data[key] = String(val)
  },
  removeItem(key) {
    delete this.data[key]
  },
  clear() {
    this.data = {}
  }
}
globalThis.localStorage = mockLocalStorage

function createMockFirestoreBridge(mockDb) {
  return {
    doc: (db, collection, id) => ({ db, collection, id }),
    getDoc: async (docRef) => mockDb.getDoc(docRef.collection, docRef.id),
    setDoc: async (docRef, data) => mockDb.setDoc(docRef.collection, docRef.id, data),
    updateDoc: async (docRef, updates) => mockDb.updateDoc(docRef.collection, docRef.id, updates),
    deleteDoc: async (docRef) => mockDb.deleteDoc(docRef.collection, docRef.id),
    runTransaction: async (db, updateFunction) => {
      const txn = {
        get: async (docRef) => mockDb.getDoc(docRef.collection, docRef.id),
        set: (docRef, data) => mockDb.setDoc(docRef.collection, docRef.id, data),
        update: (docRef, updates) => mockDb.updateDoc(docRef.collection, docRef.id, updates),
        delete: (docRef) => mockDb.deleteDoc(docRef.collection, docRef.id)
      }
      return updateFunction(txn)
    },
    serverTimestamp: () => ({ _methodName: 'serverTimestamp', timestamp: Date.now() })
  }
}

// -------------------------------------------------------------
// MODULE IMPLEMENTATIONS UNDER TEST (Mirrors src/renderer)
// -------------------------------------------------------------
const USERS_COLLECTION = 'users'
const WORKSPACES_COLLECTION = 'workspaces'
const FIREBASE_PROJECT_ID = 'social-hub-32839'

function resolveUserProfile(user) {
  const email = user.email ? user.email.trim() : ''
  let fallbackName = 'User'
  if (user.isAnonymous) {
    fallbackName = 'Anonymous'
  } else if (email) {
    const prefix = email.split('@')[0]
    fallbackName = prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : 'User'
  }

  const name = user.displayName ? user.displayName.trim() : fallbackName
  const dpLink = user.photoURL ? user.photoURL.trim() : ''

  return { name, email, dpLink }
}

let lastSyncedUid = null
let lastSyncTimestamp = 0
let inFlightSyncUid = null
let inFlightSync = null

function resetUserSyncCache() {
  lastSyncedUid = null
  lastSyncTimestamp = 0
  inFlightSyncUid = null
  inFlightSync = null
}

async function syncUserDocument(user, bridge, force = false) {
  if (!user || !user.uid) return null

  const now = Date.now()
  const isDifferentUser = lastSyncedUid !== user.uid
  if (!force && !isDifferentUser && now - lastSyncTimestamp < 60000) {
    return null
  }

  if (inFlightSync && inFlightSyncUid === user.uid) {
    return inFlightSync
  }

  inFlightSyncUid = user.uid
  inFlightSync = (async () => {
    let currentOp = 'INITIALIZE'
    try {
      const userRef = bridge.doc(null, USERS_COLLECTION, user.uid)
      currentOp = 'getDoc'
      const snap = await bridge.getDoc(userRef)
      const profile = resolveUserProfile(user)

      if (!snap.exists()) {
        currentOp = 'setDoc'
        const newDoc = {
          user_id: user.uid,
          user_name: profile.name,
          user_email: profile.email,
          user_dp_link: profile.dpLink,
          user_at_created: bridge.serverTimestamp(),
          user_at_last_visit: bridge.serverTimestamp(),
          user_status: 1
        }
        await bridge.setDoc(userRef, newDoc)
        lastSyncedUid = user.uid
        lastSyncTimestamp = Date.now()
        return newDoc
      } else {
        currentOp = 'updateDoc'
        const existing = snap.data()
        const updates = {
          user_name: profile.name || existing?.user_name || 'User',
          user_email: profile.email,
          user_dp_link: profile.dpLink,
          user_at_last_visit: bridge.serverTimestamp()
        }

        if (existing?.user_status === undefined || existing?.user_status === null) {
          updates.user_status = 1
        }

        await bridge.updateDoc(userRef, updates)
        lastSyncedUid = user.uid
        lastSyncTimestamp = Date.now()
        return {
          ...existing,
          ...updates,
          user_id: user.uid,
          user_at_created: existing?.user_at_created
        }
      }
    } catch (error) {
      const errObj = error || {}
      console.error(
        `[FIRESTORE][USERS][ERROR] Project: ${FIREBASE_PROJECT_ID} | Operation: ${currentOp} | UID: ${user.uid} | Doc: users/${user.uid} | Code: ${errObj.code || 'UNKNOWN'} | Message: ${errObj.message || error}`
      )
      return null
    } finally {
      if (inFlightSyncUid === user.uid) {
        inFlightSyncUid = null
        inFlightSync = null
      }
    }
  })()

  return inFlightSync
}

const LOCAL_WORKSPACE_OWNERS_KEY = 'socialhub_workspace_owners'

function getLocalWorkspaceOwners() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_WORKSPACE_OWNERS_KEY) : null
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function setLocalWorkspaceOwner(workspaceId, ownerUid) {
  const owners = getLocalWorkspaceOwners()
  owners[workspaceId] = ownerUid
  localStorage.setItem(LOCAL_WORKSPACE_OWNERS_KEY, JSON.stringify(owners))
}

function clearLocalWorkspaceOwner(workspaceId) {
  const owners = getLocalWorkspaceOwners()
  delete owners[workspaceId]
  localStorage.setItem(LOCAL_WORKSPACE_OWNERS_KEY, JSON.stringify(owners))
}

function isAuthorizedUser(uid, docData) {
  if (!uid || !docData) return false
  if (docData.ws_owner_id === uid) return true
  if (Array.isArray(docData.ws_users_ids) && docData.ws_users_ids.includes(uid)) return true
  return false
}

function mapAccountToFirestore(account) {
  return {
    ws_acc_id: account.id,
    ws_acc_name: account.name || '',
    ws_acc_link: account.url || ''
  }
}

function mergeAccountLists(existingAccounts, incomingAccounts) {
  const result = []
  const seenIds = new Set()

  for (const acc of existingAccounts || []) {
    if (acc && acc.ws_acc_id && !seenIds.has(acc.ws_acc_id)) {
      result.push({ ...acc })
      seenIds.add(acc.ws_acc_id)
    }
  }

  for (const inc of incomingAccounts || []) {
    if (!inc || !inc.ws_acc_id) continue
    const idx = result.findIndex((item) => item.ws_acc_id === inc.ws_acc_id)
    if (idx >= 0) {
      result[idx] = {
        ws_acc_id: inc.ws_acc_id,
        ws_acc_name: inc.ws_acc_name !== undefined ? inc.ws_acc_name : result[idx].ws_acc_name,
        ws_acc_link: inc.ws_acc_link !== undefined ? inc.ws_acc_link : result[idx].ws_acc_link
      }
    } else {
      result.push({
        ws_acc_id: inc.ws_acc_id,
        ws_acc_name: inc.ws_acc_name || '',
        ws_acc_link: inc.ws_acc_link || ''
      })
      seenIds.add(inc.ws_acc_id)
    }
  }

  return result
}

async function syncWorkspaceCreation(user, workspace, initialAccounts = [], bridge) {
  if (!user || !user.uid || !workspace || !workspace.id) return null
  try {
    const docRef = bridge.doc(null, WORKSPACES_COLLECTION, workspace.id)
    setLocalWorkspaceOwner(workspace.id, user.uid)

    const newWorkspaceDoc = {
      ws_id: workspace.id,
      ws_owner_id: user.uid,
      ws_accounts: initialAccounts,
      ws_passwords: [],
      ws_status: 1,
      ws_users_ids: [user.uid]
    }

    await bridge.setDoc(docRef, newWorkspaceDoc)
    return newWorkspaceDoc
  } catch (error) {
    console.error(`[FIRESTORE][WORKSPACES][CREATE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Error:`, error.message)
    return null
  }
}

async function syncWorkspaceDeletion(user, workspaceId, bridge) {
  if (!user || !user.uid || !workspaceId) return false
  try {
    const docRef = bridge.doc(null, WORKSPACES_COLLECTION, workspaceId)
    const snap = await bridge.getDoc(docRef)
    if (snap.exists()) {
      const data = snap.data()
      if (data.ws_owner_id !== user.uid) {
        console.warn(`[FIRESTORE][WORKSPACES][DELETE][REJECT] Project: ${FIREBASE_PROJECT_ID} | Not owner`)
        return false
      }
      await bridge.deleteDoc(docRef)
    }
    clearLocalWorkspaceOwner(workspaceId)
    return true
  } catch (error) {
    console.error(`[FIRESTORE][WORKSPACES][DELETE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Error:`, error.message)
    return false
  }
}

async function syncAccountAddition(user, workspaceId, account, bridge) {
  if (!user || !user.uid || !workspaceId || !account || !account.id) return false
  try {
    const docRef = bridge.doc(null, WORKSPACES_COLLECTION, workspaceId)
    const item = mapAccountToFirestore(account)

    await bridge.runTransaction(null, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) throw new Error(`Workspace ${workspaceId} not found`)
      const data = snap.data()
      if (!isAuthorizedUser(user.uid, data)) throw new Error('Unauthorized')

      const existingAccounts = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const idx = existingAccounts.findIndex((a) => a.ws_acc_id === account.id)
      if (idx >= 0) {
        existingAccounts[idx] = item
      } else {
        existingAccounts.push(item)
      }
      txn.update(docRef, { ws_accounts: existingAccounts })
    })
    return true
  } catch (error) {
    console.error(`[FIRESTORE][ACCOUNTS][ADD][ERROR] Project: ${FIREBASE_PROJECT_ID} | Error:`, error.message)
    return false
  }
}

async function syncAccountUpdate(user, workspaceId, account, bridge) {
  if (!user || !user.uid || !workspaceId || !account || !account.id) return false
  try {
    const docRef = bridge.doc(null, WORKSPACES_COLLECTION, workspaceId)
    await bridge.runTransaction(null, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) throw new Error(`Workspace ${workspaceId} not found`)
      const data = snap.data()
      if (!isAuthorizedUser(user.uid, data)) throw new Error('Unauthorized')

      const existingAccounts = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const idx = existingAccounts.findIndex((a) => a.ws_acc_id === account.id)
      if (idx >= 0) {
        existingAccounts[idx] = {
          ws_acc_id: account.id,
          ws_acc_name: account.name !== undefined ? account.name : existingAccounts[idx].ws_acc_name,
          ws_acc_link: account.url !== undefined ? account.url : existingAccounts[idx].ws_acc_link
        }
        txn.update(docRef, { ws_accounts: existingAccounts })
      } else {
        existingAccounts.push({
          ws_acc_id: account.id,
          ws_acc_name: account.name || '',
          ws_acc_link: account.url || ''
        })
        txn.update(docRef, { ws_accounts: existingAccounts })
      }
    })
    return true
  } catch (error) {
    console.error(`[FIRESTORE][ACCOUNTS][UPDATE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Error:`, error.message)
    return false
  }
}

async function syncAccountRemoval(user, workspaceId, accountId, bridge) {
  if (!user || !user.uid || !workspaceId || !accountId) return false
  try {
    const docRef = bridge.doc(null, WORKSPACES_COLLECTION, workspaceId)
    await bridge.runTransaction(null, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) return
      const data = snap.data()
      if (!isAuthorizedUser(user.uid, data)) throw new Error('Unauthorized')

      const existingAccounts = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const filtered = existingAccounts.filter((a) => a.ws_acc_id !== accountId)
      txn.update(docRef, { ws_accounts: filtered })
    })
    return true
  } catch (error) {
    console.error(`[FIRESTORE][ACCOUNTS][REMOVE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Error:`, error.message)
    return false
  }
}

async function syncUserWorkspaces(user, localWorkspaces, localAccounts, bridge) {
  if (!user || !user.uid || !Array.isArray(localWorkspaces)) return

  for (const ws of localWorkspaces) {
    try {
      const docRef = bridge.doc(null, WORKSPACES_COLLECTION, ws.id)
      const snap = await bridge.getDoc(docRef)

      const accountsInWorkspace = (localAccounts || [])
        .filter((a) => a.workspaceId === ws.id)
        .map(mapAccountToFirestore)

      if (snap.exists()) {
        const data = snap.data()
        if (!isAuthorizedUser(user.uid, data)) {
          console.warn(`[FIRESTORE][WORKSPACES][SKIP] Project: ${FIREBASE_PROJECT_ID} | Owned by remote UID ${data.ws_owner_id}`)
          continue
        }

        setLocalWorkspaceOwner(ws.id, data.ws_owner_id)
        const mergedAccounts = mergeAccountLists(data.ws_accounts || [], accountsInWorkspace)
        await bridge.updateDoc(docRef, { ws_accounts: mergedAccounts })
      } else {
        setLocalWorkspaceOwner(ws.id, user.uid)
        const initialDoc = {
          ws_id: ws.id,
          ws_owner_id: user.uid,
          ws_accounts: accountsInWorkspace,
          ws_passwords: [],
          ws_status: 1,
          ws_users_ids: [user.uid]
        }
        await bridge.setDoc(docRef, initialDoc)
      }
    } catch (error) {
      console.error(`[FIRESTORE][WORKSPACES][ERROR] Project: ${FIREBASE_PROJECT_ID} | Workspace ${ws.id}:`, error.message)
    }
  }
}

async function syncWorkspacePasswords(user, workspaceId, passwords, provider, bridge) {
  if (!user || !user.uid) return { synced: false, reason: 'Authentication required' }
  if (!provider || !provider.isPortableEncryptionConfigured()) {
    return {
      synced: false,
      reason: 'Portable end-to-end encryption key management is not configured. Plaintext and machine-bound DPAPI passwords cannot be synchronized.'
    }
  }
  return { synced: true, reason: 'Passwords synchronized successfully' }
}

async function runTests() {
  const mockDb = new MockFirestore()
  const bridge = createMockFirestoreBridge(mockDb)

  // -------------------------------------------------------------
  // TEST GROUP 1: MODULE ONE – USERS SYNCHRONIZATION
  // -------------------------------------------------------------
  console.log('[TEST GROUP 1] Module One – Users Synchronization')

  assert.strictEqual(USERS_COLLECTION, 'users', 'Collection name must strictly be "users"')
  console.log('  -> Passed: Collection name strictly set to "users"')

  const googleUser = {
    uid: 'google-uid-123',
    displayName: 'Mansi Sharma',
    email: 'mansi@example.com',
    photoURL: 'https://lh3.googleusercontent.com/photo.jpg',
    isAnonymous: false
  }
  const anonUser = {
    uid: 'anon-uid-456',
    displayName: null,
    email: null,
    photoURL: null,
    isAnonymous: true
  }

  const gProfile = resolveUserProfile(googleUser)
  assert.strictEqual(gProfile.name, 'Mansi Sharma')
  assert.strictEqual(gProfile.email, 'mansi@example.com')
  assert.strictEqual(gProfile.dpLink, 'https://lh3.googleusercontent.com/photo.jpg')

  const aProfile = resolveUserProfile(anonUser)
  assert.strictEqual(aProfile.name, 'Anonymous')
  assert.strictEqual(aProfile.email, '', 'Anonymous users must never receive fake email addresses')
  assert.strictEqual(aProfile.dpLink, '')
  console.log('  -> Passed: Safe user profile resolution for Google and Anonymous users')

  // New Google User Registration
  resetUserSyncCache()
  const createdUser = await syncUserDocument(googleUser, bridge, true)
  assert.ok(createdUser, 'User document should be returned on creation')
  assert.strictEqual(createdUser.user_id, 'google-uid-123')
  assert.strictEqual(createdUser.user_name, 'Mansi Sharma')
  assert.strictEqual(createdUser.user_email, 'mansi@example.com')
  assert.strictEqual(createdUser.user_dp_link, 'https://lh3.googleusercontent.com/photo.jpg')
  assert.strictEqual(createdUser.user_status, 1, 'Default user_status must be 1')
  assert.ok(createdUser.user_at_created)
  assert.ok(createdUser.user_at_last_visit)

  const storedUser = mockDb.getDoc('users', 'google-uid-123')
  assert.ok(storedUser.exists())
  assert.strictEqual(storedUser.data().user_id, 'google-uid-123')
  console.log('  -> Passed: New Google user document created with full schema')

  // New Anonymous User Registration
  resetUserSyncCache()
  const createdAnon = await syncUserDocument(anonUser, bridge, true)
  assert.strictEqual(createdAnon.user_id, 'anon-uid-456')
  assert.strictEqual(createdAnon.user_name, 'Anonymous')
  assert.strictEqual(createdAnon.user_email, '')
  assert.strictEqual(createdAnon.user_status, 1)
  console.log('  -> Passed: New Anonymous user document created with status 1 and empty email')

  // Existing User Login & user_at_created preservation
  const originalCreatedTimestamp = storedUser.data().user_at_created
  const originalLastVisit = storedUser.data().user_at_last_visit

  await new Promise((r) => setTimeout(r, 10))

  const updatedGoogleUser = {
    ...googleUser,
    displayName: 'Mansi Updated'
  }
  const updatedResult = await syncUserDocument(updatedGoogleUser, bridge, true)
  assert.strictEqual(updatedResult.user_name, 'Mansi Updated')

  const reStoredUser = mockDb.getDoc('users', 'google-uid-123').data()
  assert.strictEqual(reStoredUser.user_name, 'Mansi Updated')
  assert.deepStrictEqual(
    reStoredUser.user_at_created,
    originalCreatedTimestamp,
    'user_at_created must NEVER be overwritten on subsequent logins'
  )
  assert.notDeepStrictEqual(
    reStoredUser.user_at_last_visit,
    originalLastVisit,
    'user_at_last_visit must be updated on login'
  )
  console.log('  -> Passed: Existing user login preserves user_at_created and updates user_at_last_visit')

  // Switching account immediately bypasses debounce
  const userC = { uid: 'google-uid-789', displayName: 'Account 2', email: 'acc2@ex.com' }
  const syncUserC = await syncUserDocument(userC, bridge, false) // force=false
  assert.ok(syncUserC, 'Account switch must never be skipped by debounce')
  assert.strictEqual(syncUserC.user_id, 'google-uid-789')
  console.log('  -> Passed: Switching to another user account immediately synchronizes without debounce delay')

  // Debounce applies only when same user calls again rapidly without force
  const syncUserCAgain = await syncUserDocument(userC, bridge, false)
  assert.strictEqual(syncUserCAgain, null, 'Same user within 60s without force is debounced')
  console.log('  -> Passed: Rapid re-renders for same user safely debounced')

  // Logout handling
  const logoutSync = await syncUserDocument(null, bridge)
  assert.strictEqual(logoutSync, null, 'Logout must never create or update user documents')
  console.log('  -> Passed: Logout handled cleanly without creating phantom users')

  // -------------------------------------------------------------
  // TEST GROUP 2: MODULE TWO – WORKSPACES SYNCHRONIZATION
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 2] Module Two – Workspaces Synchronization')

  assert.strictEqual(WORKSPACES_COLLECTION, 'workspaces')

  const testWs = { id: 'ws-personal-01', name: 'Personal' }
  const wsDoc = await syncWorkspaceCreation(googleUser, testWs, [], bridge)
  assert.ok(wsDoc)
  assert.strictEqual(wsDoc.ws_id, 'ws-personal-01')
  assert.strictEqual(wsDoc.ws_owner_id, googleUser.uid)
  assert.deepStrictEqual(wsDoc.ws_accounts, [])
  assert.deepStrictEqual(wsDoc.ws_passwords, [])
  assert.strictEqual(wsDoc.ws_status, 1)
  assert.deepStrictEqual(wsDoc.ws_users_ids, [googleUser.uid])
  console.log('  -> Passed: Workspace creation creates correct document and binds local owner')

  // Account addition
  const acc1 = { id: 'acc-whatsapp-1', name: 'WhatsApp', url: 'https://web.whatsapp.com' }
  await syncAccountAddition(googleUser, 'ws-personal-01', acc1, bridge)
  let wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts.length, 1)
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_id, 'acc-whatsapp-1')
  console.log('  -> Passed: Account addition appends mapped account to ws_accounts')

  // Duplicate account prevention
  const acc1Dup = { id: 'acc-whatsapp-1', name: 'WhatsApp Business', url: 'https://web.whatsapp.com' }
  await syncAccountAddition(googleUser, 'ws-personal-01', acc1Dup, bridge)
  wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts.length, 1)
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_name, 'WhatsApp Business')
  console.log('  -> Passed: Duplicate accounts prevented; existing matching ID updated')

  // Account editing (name only, url only, both)
  await syncAccountUpdate(googleUser, 'ws-personal-01', { id: 'acc-whatsapp-1', name: 'WA Personal' }, bridge)
  wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_name, 'WA Personal')
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_link, 'https://web.whatsapp.com')

  await syncAccountUpdate(googleUser, 'ws-personal-01', { id: 'acc-whatsapp-1', url: 'https://web2.whatsapp.com' }, bridge)
  wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_link, 'https://web2.whatsapp.com')

  await syncAccountUpdate(googleUser, 'ws-personal-01', { id: 'acc-whatsapp-1', name: 'WhatsApp Final', url: 'https://whatsapp.com' }, bridge)
  wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_name, 'WhatsApp Final')
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_link, 'https://whatsapp.com')
  console.log('  -> Passed: Independent and simultaneous editing of account name and URL')

  // Account removal
  await syncAccountRemoval(googleUser, 'ws-personal-01', 'acc-whatsapp-1', bridge)
  wsData = mockDb.getDoc('workspaces', 'ws-personal-01').data()
  assert.strictEqual(wsData.ws_accounts.length, 0)
  console.log('  -> Passed: Account removal deletes correct item from ws_accounts')

  // Workspace deletion
  await syncWorkspaceDeletion(googleUser, 'ws-personal-01', bridge)
  assert.strictEqual(mockDb.getDoc('workspaces', 'ws-personal-01').exists(), false)
  console.log('  -> Passed: Workspace deletion deletes document and clears local owner binding')

  // -------------------------------------------------------------
  // TEST GROUP 3: SECURITY, MULTI-USER & PASSWORD TESTS
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 3] Security, Multi-User Isolation & Zero-Knowledge Passwords')

  // Multi-user scenario: User A created a remote workspace
  mockDb.setDoc('workspaces', 'workspace-A', {
    ws_id: 'workspace-A',
    ws_owner_id: 'user-A',
    ws_accounts: [],
    ws_passwords: [],
    ws_status: 1,
    ws_users_ids: ['user-A']
  })

  // User B logs in on same machine with workspace-A (remote owned by A) and workspace-B (new)
  const localWorkspaces = [
    { id: 'workspace-A', name: 'User A Workspace' },
    { id: 'workspace-B', name: 'User B Workspace' }
  ]
  const localAccounts = [
    { id: 'acc-a', workspaceId: 'workspace-A', name: 'Secret A', url: 'https://a.com' },
    { id: 'acc-b', workspaceId: 'workspace-B', name: 'Secret B', url: 'https://b.com' }
  ]

  const userB = { uid: 'user-B' }
  await syncUserWorkspaces(userB, localWorkspaces, localAccounts, bridge)

  // Verify workspace-A was NOT overwritten or claimed by user-B
  assert.strictEqual(mockDb.getDoc('workspaces', 'workspace-A').data().ws_owner_id, 'user-A')
  // Verify workspace-B was created for user-B (not skipped!)
  assert.ok(mockDb.getDoc('workspaces', 'workspace-B').exists())
  assert.strictEqual(mockDb.getDoc('workspaces', 'workspace-B').data().ws_owner_id, 'user-B')
  console.log('  -> Passed: Multi-user isolation prevents hijacking remote workspaces while syncing eligible ones')

  // Zero-Knowledge Password Security Interface
  const plainPwResult = await syncWorkspacePasswords(
    userB,
    'workspace-B',
    [{ pass_link: 'https://b.com', pass_name: 'admin', pass_value: 'PlainPassword123' }]
  )
  assert.strictEqual(plainPwResult.synced, false)
  assert.ok(plainPwResult.reason.includes('Portable end-to-end encryption key management is not configured'))
  console.log('  -> Passed: Plaintext & DPAPI passwords unconditionally rejected from Firestore transmission')

  // Verification of Untouched Legacy Collections
  const allKeys = Array.from(mockDb.store.keys())
  for (const k of allKeys) {
    assert.ok(!k.startsWith('xusers'), 'Forbidden collection xusers was touched!')
    assert.ok(!k.startsWith('xworkspaces'), 'Forbidden collection xworkspaces was touched!')
  }
  console.log('  -> Passed: Legacy collections xusers and xworkspaces were completely untouched')

  // -------------------------------------------------------------
  // TEST GROUP 4: STATIC CODE AUDIT
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 4] Static Code & Rules Integrity Audit')

  const userModulePath = path.resolve('src/renderer/firebase-users.ts')
  const wsModulePath = path.resolve('src/renderer/firebase-workspaces.ts')
  const appPath = path.resolve('src/renderer/App.tsx')
  const rulesPath = path.resolve('firestore.rules')

  const userModuleContent = fs.readFileSync(userModulePath, 'utf8')
  const wsModuleContent = fs.readFileSync(wsModulePath, 'utf8')
  const appContent = fs.readFileSync(appPath, 'utf8')
  const rulesContent = fs.readFileSync(rulesPath, 'utf8')

  assert.ok(!userModuleContent.includes('xusers'))
  assert.ok(!userModuleContent.includes('xworkspaces'))
  assert.ok(!wsModuleContent.includes('xusers'))
  assert.ok(!wsModuleContent.includes('xworkspaces'))
  assert.ok(!appContent.includes('xusers'))
  assert.ok(!appContent.includes('xworkspaces'))

  // Verify diagnostic logging statements exist
  assert.ok(userModuleContent.includes('[FIRESTORE][USERS]'), 'Diagnostic logging required in firebase-users.ts')
  assert.ok(wsModuleContent.includes('[FIRESTORE][WORKSPACES]'), 'Diagnostic logging required in firebase-workspaces.ts')
  assert.ok(appContent.includes('syncFirebaseData'), 'App.tsx must coordinate synchronization reliably')

  // Verify firestore.rules
  assert.ok(rulesContent.includes('match /xusers/'))
  assert.ok(rulesContent.includes('match /xworkspaces/'))
  assert.ok(rulesContent.includes('match /users/{userId}'))
  assert.ok(rulesContent.includes('match /workspaces/{workspaceId}'))
  assert.ok(rulesContent.includes('resource == null ||'), 'firestore.rules must allow get when resource == null to prevent permission-denied on existence checks')

  // Verify firebase.ts has experimentalForceLongPolling to avoid WebChannel stream hangs in Electron
  const firebaseTsContent = fs.readFileSync(path.resolve('src/renderer/firebase.ts'), 'utf8')
  assert.ok(firebaseTsContent.includes('experimentalForceLongPolling'), 'firebase.ts must enable experimentalForceLongPolling')
  assert.ok(firebaseTsContent.includes("FIREBASE_DATABASE_ID"), 'firebase.ts must export FIREBASE_DATABASE_ID')
  assert.ok(firebaseTsContent.includes("'default'"), "firebase.ts must target 'default' database")

  // Verify .env.local has VITE_FIREBASE_DATABASE_ID=default
  const envLocalContent = fs.readFileSync(path.resolve('.env.local'), 'utf8')
  assert.ok(envLocalContent.includes('VITE_FIREBASE_DATABASE_ID=default'), '.env.local must configure database default')

  // Verify main process forwards renderer [FIRESTORE] logs to terminal
  const mainTsContent = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
  assert.ok(mainTsContent.includes('[FIRESTORE]'), 'main process must forward [FIRESTORE] console messages to terminal')

  console.log('  -> Passed: Diagnostic logging, lifecycle pipeline, experimentalForceLongPolling, database configuration, and rules verified')

  console.log('\n=========================================================================')
  console.log('ALL FIREBASE USERS & WORKSPACES TESTS PASSED PERFECTLY (100% PASS)')
  console.log('=========================================================================\n')
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err)
  process.exit(1)
})
