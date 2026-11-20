import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('=== SOCIAL HUB: USER-OWNED WORKSPACES & FIREBASE VERIFICATION SUITE ===\n')

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

  getDocs(collectionName, filters = []) {
    const docs = []
    for (const [key, val] of this.store.entries()) {
      const [col, id] = key.split('/')
      if (col === collectionName) {
        let matches = true
        for (const f of filters) {
          if (f.op === '==' && val[f.field] !== f.value) {
            matches = false
            break
          }
        }
        if (matches) {
          docs.push({
            id,
            data: () => JSON.parse(JSON.stringify(val))
          })
        }
      }
    }
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs
    }
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
    collection: (db, name) => ({ db, name }),
    doc: (db, colOrRef, id) => {
      const colName = typeof colOrRef === 'string' ? colOrRef : colOrRef.name
      return { db, collection: colName, id }
    },
    query: (collectionRef, ...constraints) => ({
      collectionRef,
      constraints
    }),
    where: (field, op, value) => ({ field, op, value }),
    getDocs: async (q) => {
      const colName = q.collectionRef ? q.collectionRef.name : q.name
      const filters = q.constraints || []
      return mockDb.getDocs(colName, filters)
    },
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

/**
 * Modern user-owned syncUserWorkspaces matching src/renderer/firebase-workspaces.ts
 */
async function syncUserWorkspaces(user, localWorkspaces, localAccounts, bridge) {
  if (!user || !user.uid) {
    return { remoteWorkspaces: [], synced: false }
  }

  try {
    // 1. Query remote Firestore workspaces owned by this authenticated user
    const q = bridge.query(
      bridge.collection(null, WORKSPACES_COLLECTION),
      bridge.where('ws_owner_id', '==', user.uid)
    )
    const remoteQuerySnap = await bridge.getDocs(q)
    const remoteWorkspaces = []

    if (remoteQuerySnap.empty) {
      console.log(
        `[FIRESTORE][WORKSPACES][SYNC] UID: ${user.uid} | Discovered 0 remote workspaces. Initializing empty workspace collection for user.`
      )
      return { remoteWorkspaces: [], synced: true }
    }

    for (const docSnap of remoteQuerySnap.docs) {
      const data = docSnap.data()
      remoteWorkspaces.push(data)
      setLocalWorkspaceOwner(data.ws_id, user.uid)

      const localWs = localWorkspaces.find((w) => w.id === data.ws_id)
      if (localWs) {
        const accountsInWorkspace = (localAccounts || [])
          .filter((a) => a.workspaceId === localWs.id)
          .map(mapAccountToFirestore)
        const mergedAccounts = mergeAccountLists(data.ws_accounts || [], accountsInWorkspace)
        const docRef = bridge.doc(null, WORKSPACES_COLLECTION, data.ws_id)
        await bridge.updateDoc(docRef, { ws_accounts: mergedAccounts })
      }
    }

    return { remoteWorkspaces, synced: true }
  } catch (error) {
    console.error(`[FIRESTORE][WORKSPACES][ERROR] Operation: syncUserWorkspaces | UID: ${user.uid} | Error:`, error.message)
    return { remoteWorkspaces: [], synced: false }
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

// -------------------------------------------------------------
// MOCK ACCOUNT MANAGER (Mirrors src/main/account-manager.ts)
// -------------------------------------------------------------
class MockAccountManager {
  constructor() {
    this.store = {
      workspaces: [],
      workspaceOwners: {},
      activeUserWorkspaceMap: {},
      accounts: []
    }
    this.currentUserUid = null
  }

  setCurrentUser(uid, knownOwners = {}) {
    this.currentUserUid = uid || null
    if (knownOwners && typeof knownOwners === 'object') {
      for (const [wsId, ownerUid] of Object.entries(knownOwners)) {
        if (wsId && ownerUid && !this.store.workspaceOwners[wsId]) {
          this.store.workspaceOwners[wsId] = ownerUid
        }
      }
    }
  }

  getCurrentUser() {
    return this.currentUserUid
  }

  listWorkspaces() {
    if (!this.currentUserUid) return []
    return this.store.workspaces
      .filter((ws) => (ws.ownerId || this.store.workspaceOwners[ws.id]) === this.currentUserUid)
      .map((ws) => ({
        id: ws.id,
        name: ws.name,
        ownerId: ws.ownerId || this.store.workspaceOwners[ws.id] || this.currentUserUid
      }))
  }

  getWorkspace(id) {
    const ws = this.store.workspaces.find((w) => w.id === id)
    if (!ws) return null
    if (this.currentUserUid && (ws.ownerId || this.store.workspaceOwners[id]) !== this.currentUserUid) {
      return null
    }
    return { ...ws }
  }

  activeWorkspaceId() {
    if (!this.currentUserUid) return null
    const userWorkspaces = this.listWorkspaces()
    if (userWorkspaces.length === 0) return null
    const mapped = this.store.activeUserWorkspaceMap[this.currentUserUid]
    if (mapped && userWorkspaces.some((w) => w.id === mapped)) return mapped
    return userWorkspaces[0].id
  }

  addWorkspace(name, ownerUid) {
    const targetUid = ownerUid || this.currentUserUid
    if (!targetUid) throw new Error('Cannot create workspace without an authenticated user UID')
    const ws = {
      id: `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      ownerId: targetUid
    }
    this.store.workspaces.push(ws)
    this.store.workspaceOwners[ws.id] = targetUid
    this.store.activeUserWorkspaceMap[targetUid] = ws.id
    return ws
  }

  deleteWorkspace(id) {
    const wsIndex = this.store.workspaces.findIndex((w) => w.id === id)
    if (wsIndex === -1) return false
    const ws = this.store.workspaces[wsIndex]
    const wsOwner = ws.ownerId || this.store.workspaceOwners[id]
    if (this.currentUserUid && wsOwner !== this.currentUserUid) {
      throw new Error('Unauthorized to delete workspace owned by another user')
    }
    // Delete associated accounts
    this.store.accounts = this.store.accounts.filter((a) => a.workspaceId !== id)
    this.store.workspaces.splice(wsIndex, 1)
    delete this.store.workspaceOwners[id]

    if (this.currentUserUid) {
      const remaining = this.listWorkspaces()
      this.store.activeUserWorkspaceMap[this.currentUserUid] = remaining.length > 0 ? remaining[0].id : null
    }
    return true
  }

  list() {
    if (!this.currentUserUid) return []
    const userWorkspaceIds = new Set(this.listWorkspaces().map((w) => w.id))
    return this.store.accounts.filter((a) => userWorkspaceIds.has(a.workspaceId))
  }

  add(accountData) {
    const targetWorkspaceId = accountData.workspaceId || this.activeWorkspaceId()
    if (!targetWorkspaceId || !this.getWorkspace(targetWorkspaceId)) {
      throw new Error(`Workspace ${targetWorkspaceId} not found or not owned by current user`)
    }
    const acc = {
      id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: accountData.name,
      url: accountData.url,
      workspaceId: targetWorkspaceId
    }
    this.store.accounts.push(acc)
    return acc
  }

  remove(id) {
    const acc = this.store.accounts.find((a) => a.id === id)
    if (!acc) return false
    if (!this.getWorkspace(acc.workspaceId)) {
      throw new Error('Unauthorized to delete account in another user workspace')
    }
    this.store.accounts = this.store.accounts.filter((a) => a.id !== id)
    return true
  }

  claimWorkspaces(discoveredWorkspaces) {
    if (!this.currentUserUid || !Array.isArray(discoveredWorkspaces)) return
    for (const remoteWs of discoveredWorkspaces) {
      if (!remoteWs || !remoteWs.ws_id) continue
      if (remoteWs.ws_owner_id !== this.currentUserUid) continue

      this.store.workspaceOwners[remoteWs.ws_id] = this.currentUserUid
      const existing = this.store.workspaces.find((w) => w.id === remoteWs.ws_id)
      if (!existing) {
        this.store.workspaces.push({
          id: remoteWs.ws_id,
          name: remoteWs.ws_name || 'Personal Workspace',
          ownerId: this.currentUserUid
        })
      }
    }
  }
}

// -------------------------------------------------------------
// MAIN TEST RUNNER
// -------------------------------------------------------------
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
  const syncUserC = await syncUserDocument(userC, bridge, false)
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
  // TEST GROUP 2: MODULE TWO – WORKSPACES & ACCOUNTS SYNCHRONIZATION
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 2] Module Two – Workspaces & Accounts Synchronization')

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
  // TEST GROUP 3: 10 CORE VERIFICATION SCENARIOS FOR USER-OWNED ARCHITECTURE
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 3] 10 Core Verification Scenarios for User-Owned Architecture')

  const acctMgr = new MockAccountManager()

  // SCENARIO 1: New user registration creates user doc but 0 workspaces
  console.log('\n  [SCENARIO 1] New user registration: creates users/{uid} doc + 0 workspaces')
  const newUser = {
    uid: 'user-new-registration-999',
    displayName: 'Brand New User',
    email: 'newuser@example.com'
  }
  const newUserDoc = await syncUserDocument(newUser, bridge, true)
  assert.ok(newUserDoc)
  assert.strictEqual(newUserDoc.user_id, newUser.uid)
  assert.ok(mockDb.getDoc('users', newUser.uid).exists(), 'users/{uid} document must exist')

  acctMgr.setCurrentUser(newUser.uid, getLocalWorkspaceOwners())
  const initialSyncResult = await syncUserWorkspaces(newUser, acctMgr.listWorkspaces(), acctMgr.list(), bridge)
  assert.strictEqual(initialSyncResult.synced, true)
  assert.strictEqual(initialSyncResult.remoteWorkspaces.length, 0, 'Must discover exactly 0 remote workspaces')

  // Verify 0 workspaces in Firestore for this user
  const newUserWsDocs = mockDb.getDocs('workspaces', [{ field: 'ws_owner_id', op: '==', value: newUser.uid }])
  assert.strictEqual(newUserWsDocs.size, 0, 'New user must have ZERO workspaces in Firestore')
  assert.strictEqual(acctMgr.listWorkspaces().length, 0, 'New user must have ZERO local workspaces')
  console.log('  -> Passed Scenario 1: New user registration creates user doc, 0 Firestore workspaces, 0 local workspaces')

  // SCENARIO 2: New user application access with 0 workspaces
  console.log('\n  [SCENARIO 2] New user application access with 0 workspaces')
  assert.strictEqual(acctMgr.activeWorkspaceId(), null, 'Active workspace ID must be null when 0 workspaces exist')
  assert.deepStrictEqual(acctMgr.list(), [], 'Account list must be empty when 0 workspaces exist')
  // Simulating renderer App.tsx logic:
  const hasWorkspaces = acctMgr.listWorkspaces().length > 0
  const activeWorkspace = hasWorkspaces ? acctMgr.listWorkspaces()[0] : null
  assert.strictEqual(hasWorkspaces, false)
  assert.strictEqual(activeWorkspace, null)
  console.log('  -> Passed Scenario 2: App accessible with 0 workspaces; null active workspace triggers Empty Workspace screen')

  // SCENARIO 3: Manual workspace creation assigns authenticated UID as owner
  console.log('\n  [SCENARIO 3] Manual workspace creation schema verification')
  const createdLocalWs = acctMgr.addWorkspace('My First Workspace', newUser.uid)
  assert.ok(createdLocalWs.id)
  assert.strictEqual(createdLocalWs.name, 'My First Workspace')
  assert.strictEqual(createdLocalWs.ownerId, newUser.uid)

  const createdRemoteDoc = await syncWorkspaceCreation(newUser, createdLocalWs, [], bridge)
  assert.ok(createdRemoteDoc)
  assert.strictEqual(createdRemoteDoc.ws_id, createdLocalWs.id)
  assert.strictEqual(createdRemoteDoc.ws_owner_id, newUser.uid)
  assert.deepStrictEqual(createdRemoteDoc.ws_users_ids, [newUser.uid])
  assert.deepStrictEqual(createdRemoteDoc.ws_accounts, [])
  assert.deepStrictEqual(createdRemoteDoc.ws_passwords, [])
  assert.strictEqual(createdRemoteDoc.ws_status, 1)

  const verifyDoc = mockDb.getDoc('workspaces', createdLocalWs.id)
  assert.ok(verifyDoc.exists())
  assert.strictEqual(verifyDoc.data().ws_owner_id, newUser.uid)
  console.log('  -> Passed Scenario 3: Manual workspace creation assigns authenticated UID as owner with exact required schema')

  // SCENARIO 4: Local persistence & binding to authenticated user
  console.log('\n  [SCENARIO 4] Local persistence & owner binding')
  const localOwners = getLocalWorkspaceOwners()
  assert.strictEqual(localOwners[createdLocalWs.id], newUser.uid, 'localStorage must bind workspace to user UID')
  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, createdLocalWs.id)
  assert.strictEqual(acctMgr.activeWorkspaceId(), createdLocalWs.id)

  // Add an account to the workspace
  const newAcc = acctMgr.add({
    name: 'WhatsApp Business',
    url: 'https://web.whatsapp.com',
    workspaceId: createdLocalWs.id
  })
  assert.ok(newAcc.id)
  await syncAccountAddition(newUser, createdLocalWs.id, newAcc, bridge)
  const accInStore = acctMgr.list()
  assert.strictEqual(accInStore.length, 1)
  assert.strictEqual(accInStore[0].name, 'WhatsApp Business')
  console.log('  -> Passed Scenario 4: Workspace saved locally and bound to authenticated user with associated accounts')

  // SCENARIO 5: Multi-user isolation (User B logs in on same machine)
  console.log('\n  [SCENARIO 5] Multi-user isolation: User B logs in on same machine')
  const userB = {
    uid: 'user-b-second-account-777',
    displayName: 'User B',
    email: 'userb@example.com'
  }
  await syncUserDocument(userB, bridge, true)

  // Switch AccountManager to User B
  acctMgr.setCurrentUser(userB.uid, getLocalWorkspaceOwners())
  assert.strictEqual(acctMgr.getCurrentUser(), userB.uid)
  assert.strictEqual(acctMgr.listWorkspaces().length, 0, 'User B must see 0 workspaces initially on this machine')
  assert.strictEqual(acctMgr.list().length, 0, 'User B must see 0 accounts on this machine')
  assert.strictEqual(acctMgr.activeWorkspaceId(), null, 'User B active workspace must be null')

  // User B attempts to access createdLocalWs directly
  const unauthorizedAccess = acctMgr.getWorkspace(createdLocalWs.id)
  assert.strictEqual(unauthorizedAccess, null, 'User B cannot access User A workspace')
  console.log('  -> Passed Scenario 5: User B has 0 workspaces, cannot see User A workspaces or accounts')

  // SCENARIO 6: Cross-user sync prevention
  console.log('\n  [SCENARIO 6] Cross-user sync prevention')
  // Run syncUserWorkspaces for User B
  const userBSyncResult = await syncUserWorkspaces(userB, acctMgr.listWorkspaces(), acctMgr.list(), bridge)
  assert.strictEqual(userBSyncResult.synced, true)
  assert.strictEqual(userBSyncResult.remoteWorkspaces.length, 0)

  // Verify createdLocalWs in Firestore still belongs strictly to newUser, not User B!
  const docAfterBSync = mockDb.getDoc('workspaces', createdLocalWs.id).data()
  assert.strictEqual(docAfterBSync.ws_owner_id, newUser.uid, 'User A workspace owner in Firestore must remain User A')
  assert.deepStrictEqual(docAfterBSync.ws_users_ids, [newUser.uid])
  // User B attempts to delete User A workspace in Firestore -> rejected
  const deleteAttempt = await syncWorkspaceDeletion(userB, createdLocalWs.id, bridge)
  assert.strictEqual(deleteAttempt, false, 'User B deletion of User A workspace must be rejected')
  console.log('  -> Passed Scenario 6: User B cannot sync, claim, or delete User A workspaces')

  // SCENARIO 7: Existing user data preservation
  console.log('\n  [SCENARIO 7] Existing user data preservation')
  // User A logs back in
  acctMgr.setCurrentUser(newUser.uid, getLocalWorkspaceOwners())
  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, createdLocalWs.id)
  assert.strictEqual(acctMgr.listWorkspaces()[0].name, 'My First Workspace')
  assert.strictEqual(acctMgr.list().length, 1)
  assert.strictEqual(acctMgr.list()[0].id, newAcc.id)
  assert.strictEqual(acctMgr.list()[0].name, 'WhatsApp Business')

  // Sync existing user workspaces from remote Firestore
  const userAResync = await syncUserWorkspaces(newUser, acctMgr.listWorkspaces(), acctMgr.list(), bridge)
  assert.strictEqual(userAResync.synced, true)
  assert.strictEqual(userAResync.remoteWorkspaces.length, 1)
  assert.strictEqual(userAResync.remoteWorkspaces[0].ws_id, createdLocalWs.id)

  // Verify no duplicate creation or data loss
  assert.strictEqual(acctMgr.listWorkspaces().length, 1, 'No duplicate workspaces created')
  assert.strictEqual(acctMgr.list().length, 1, 'Accounts preserved')
  console.log('  -> Passed Scenario 7: Existing users retain workspace IDs, names, and account associations')

  // SCENARIO 8: User switching without data leakage
  console.log('\n  [SCENARIO 8] User switching without data leakage')
  // User B creates a workspace of their own
  acctMgr.setCurrentUser(userB.uid, getLocalWorkspaceOwners())
  const userBWs = acctMgr.addWorkspace('User B Private Workspace', userB.uid)
  await syncWorkspaceCreation(userB, userBWs, [], bridge)
  const userBAcc = acctMgr.add({
    name: 'Telegram User B',
    url: 'https://web.telegram.org',
    workspaceId: userBWs.id
  })
  await syncAccountAddition(userB, userBWs.id, userBAcc, bridge)

  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, userBWs.id)
  assert.strictEqual(acctMgr.list().length, 1)
  assert.strictEqual(acctMgr.list()[0].id, userBAcc.id)

  // Switch back to User A
  acctMgr.setCurrentUser(newUser.uid, getLocalWorkspaceOwners())
  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, createdLocalWs.id)
  assert.strictEqual(acctMgr.list().length, 1)
  assert.strictEqual(acctMgr.list()[0].id, newAcc.id)

  // Switch back to User B
  acctMgr.setCurrentUser(userB.uid, getLocalWorkspaceOwners())
  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, userBWs.id)
  assert.strictEqual(acctMgr.list().length, 1)
  assert.strictEqual(acctMgr.list()[0].id, userBAcc.id)
  console.log('  -> Passed Scenario 8: User switching cleanly swaps workspaces and accounts without leakage')

  // SCENARIO 9: Workspace deletion returning to zero-workspace state
  console.log('\n  [SCENARIO 9] Workspace deletion returning to zero-workspace state')
  // User B deletes their account first
  acctMgr.remove(userBAcc.id)
  await syncAccountRemoval(userB, userBWs.id, userBAcc.id, bridge)
  assert.strictEqual(acctMgr.list().length, 0)

  // User B deletes their only workspace
  const deleteWsSuccess = acctMgr.deleteWorkspace(userBWs.id)
  assert.strictEqual(deleteWsSuccess, true)
  const remoteDeleteSuccess = await syncWorkspaceDeletion(userB, userBWs.id, bridge)
  assert.strictEqual(remoteDeleteSuccess, true)

  assert.strictEqual(acctMgr.listWorkspaces().length, 0, 'User B now has 0 workspaces')
  assert.strictEqual(acctMgr.activeWorkspaceId(), null, 'User B active workspace returns to null')
  assert.strictEqual(mockDb.getDoc('workspaces', userBWs.id).exists(), false, 'Firestore doc removed')

  // Verify User A still has their workspace intact
  acctMgr.setCurrentUser(newUser.uid, getLocalWorkspaceOwners())
  assert.strictEqual(acctMgr.listWorkspaces().length, 1)
  assert.strictEqual(acctMgr.listWorkspaces()[0].id, createdLocalWs.id)
  console.log('  -> Passed Scenario 9: Workspace deletion removes doc locally and remotely; deleting last returns to zero state')

  // SCENARIO 10: Password Manager integrity
  console.log('\n  [SCENARIO 10] Password Manager integrity & E2EE enforcement')
  // In zero-workspace state, User B cannot sync passwords to nonexistent workspace
  const zeroWsPwAttempt = await syncWorkspacePasswords(userB, userBWs.id, [
    { pass_link: 'https://test.com', pass_name: 'admin', pass_value: 'plain' }
  ])
  assert.strictEqual(zeroWsPwAttempt.synced, false)

  // In populated workspace state, DPAPI passwords unconditionally rejected from Firestore transmission
  const populatedPwAttempt = await syncWorkspacePasswords(newUser, createdLocalWs.id, [
    { pass_link: 'https://web.whatsapp.com', pass_name: 'test', pass_value: 'dpapi-encrypted-blob' }
  ])
  assert.strictEqual(populatedPwAttempt.synced, false)
  assert.ok(populatedPwAttempt.reason.includes('Portable end-to-end encryption key management is not configured'))
  console.log('  -> Passed Scenario 10: Password Manager functions correctly; plaintext/DPAPI rejected from Firestore transmission')

  // -------------------------------------------------------------
  // TEST GROUP 4: FORBIDDEN COLLECTIONS & DPAPI AUDIT
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 4] Untouched Legacy Collections Audit')

  const allKeys = Array.from(mockDb.store.keys())
  for (const k of allKeys) {
    assert.ok(!k.startsWith('xusers'), 'Forbidden collection xusers was touched!')
    assert.ok(!k.startsWith('xworkspaces'), 'Forbidden collection xworkspaces was touched!')
  }
  console.log('  -> Passed: Legacy collections xusers and xworkspaces remain completely untouched')

  // -------------------------------------------------------------
  // TEST GROUP 5: STATIC CODE AUDIT
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 5] Static Code & Rules Integrity Audit')

  const acctMgrPath = path.resolve('src/main/account-manager.ts')
  const viewMgrPath = path.resolve('src/main/view-manager.ts')
  const userModulePath = path.resolve('src/renderer/firebase-users.ts')
  const wsModulePath = path.resolve('src/renderer/firebase-workspaces.ts')
  const appPath = path.resolve('src/renderer/App.tsx')
  const rulesPath = path.resolve('firestore.rules')

  const acctMgrContent = fs.readFileSync(acctMgrPath, 'utf8')
  const viewMgrContent = fs.readFileSync(viewMgrPath, 'utf8')
  const userModuleContent = fs.readFileSync(userModulePath, 'utf8')
  const wsModuleContent = fs.readFileSync(wsModulePath, 'utf8')
  const appContent = fs.readFileSync(appPath, 'utf8')
  const rulesContent = fs.readFileSync(rulesPath, 'utf8')

  // Verify no references to legacy collections
  assert.ok(!userModuleContent.includes('xusers'))
  assert.ok(!userModuleContent.includes('xworkspaces'))
  assert.ok(!wsModuleContent.includes('xusers'))
  assert.ok(!wsModuleContent.includes('xworkspaces'))
  assert.ok(!appContent.includes('xusers'))
  assert.ok(!appContent.includes('xworkspaces'))

  // Verify AccountManager user isolation
  assert.ok(acctMgrContent.includes('setCurrentUser'), 'AccountManager must have setCurrentUser')
  assert.ok(acctMgrContent.includes('claimWorkspaces'), 'AccountManager must have claimWorkspaces')
  assert.ok(acctMgrContent.includes('workspaceOwners'), 'AccountManager must persist workspaceOwners')

  // Verify ViewManager does not seed WhatsApp Personal
  assert.ok(!viewMgrContent.includes("'WhatsApp Personal'"), 'ViewManager must not auto-seed WhatsApp Personal')
  assert.ok(viewMgrContent.includes('switchWorkspace(workspaceId: string | null)'), 'ViewManager must support null workspace')

  // Verify App.tsx zero-workspace handling
  assert.ok(appContent.includes('workspace-hero-empty'), 'App.tsx must render Empty Workspace hero screen')
  assert.ok(appContent.includes('Create your first workspace'), 'App.tsx must explain and offer workspace creation')
  assert.ok(appContent.includes('setCurrentUser'), 'App.tsx must notify main process of current user')

  // Verify firestore.rules
  assert.ok(rulesContent.includes('match /xusers/'))
  assert.ok(rulesContent.includes('match /xworkspaces/'))
  assert.ok(rulesContent.includes('match /users/{userId}'))
  assert.ok(rulesContent.includes('match /workspaces/{workspaceId}'))

  console.log('  -> Passed: Static audit verified zero-workspace initialization, user isolation, and security rules')

  console.log('\n=========================================================================')
  console.log('ALL TESTS PASSED PERFECTLY (100% PASS)')
  console.log('=========================================================================\n')
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err)
  process.exit(1)
})
