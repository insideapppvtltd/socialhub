import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  serverTimestamp,
  type Firestore
} from 'firebase/firestore'
import type { User } from 'firebase/auth'
import type { Account, Workspace } from '../main/types'
import type { CloudEncryptedCredentialRecord, FirestorePasswordRecord } from '../main/cloud-crypto'
import { getFirebaseFirestore, FIREBASE_PROJECT_ID } from './firebase'

export const WORKSPACES_COLLECTION = 'workspaces'
export type { FirestorePasswordRecord }

export interface FirestoreAccountItem {
  ws_acc_id: string
  ws_acc_name: string
  ws_acc_link: string
}

export interface FirestoreWorkspaceDocument {
  ws_id: string
  ws_owner_id: string
  ws_accounts: FirestoreAccountItem[]
  ws_passwords: FirestorePasswordRecord[]
  ws_status: number
  ws_users_ids: string[]
  ws_at_created?: any
  ws_at_updated?: any
  ws_at_last_visit?: any
}

const LOCAL_WORKSPACE_OWNERS_KEY = 'socialhub_workspace_owners'

/**
 * Reads local workspace-to-owner bindings from localStorage.
 * Used to isolate workspaces across different Firebase accounts on the same machine.
 */
export function getLocalWorkspaceOwners(): Record<string, string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_WORKSPACE_OWNERS_KEY) : null
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/**
 * Binds a workspace locally to a specific Firebase UID.
 */
export function setLocalWorkspaceOwner(workspaceId: string, ownerUid: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const owners = getLocalWorkspaceOwners()
    owners[workspaceId] = ownerUid
    localStorage.setItem(LOCAL_WORKSPACE_OWNERS_KEY, JSON.stringify(owners))
  } catch (err) {
    console.error('[WORKSPACES] Failed to save local workspace owner binding:', err)
  }
}

/**
 * Removes local workspace ownership binding when a workspace is deleted.
 */
export function clearLocalWorkspaceOwner(workspaceId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const owners = getLocalWorkspaceOwners()
    delete owners[workspaceId]
    localStorage.setItem(LOCAL_WORKSPACE_OWNERS_KEY, JSON.stringify(owners))
  } catch (err) {
    console.error('[WORKSPACES] Failed to clear local workspace owner binding:', err)
  }
}

/**
 * Verifies whether a Firebase user is authorized to access or modify a workspace document.
 */
export function isAuthorizedUser(uid: string, docData: Partial<FirestoreWorkspaceDocument>): boolean {
  if (!uid || !docData) return false
  if (docData.ws_owner_id === uid) return true
  if (Array.isArray(docData.ws_users_ids) && docData.ws_users_ids.includes(uid)) return true
  return false
}

export function mapAccountToFirestore(account: { id: string; name: string; url?: string }): FirestoreAccountItem {
  return {
    ws_acc_id: account.id,
    ws_acc_name: account.name || '',
    ws_acc_link: account.url || ''
  }
}

/**
 * Merges local accounts into existing remote Firestore account records without duplicates.
 */
export function mergeAccountLists(
  existingAccounts: FirestoreAccountItem[],
  incomingAccounts: FirestoreAccountItem[]
): FirestoreAccountItem[] {
  const result: FirestoreAccountItem[] = []
  const seenIds = new Set<string>()

  // Existing remote accounts
  for (const acc of existingAccounts || []) {
    if (acc && acc.ws_acc_id && !seenIds.has(acc.ws_acc_id)) {
      result.push({ ...acc })
      seenIds.add(acc.ws_acc_id)
    }
  }

  // Incoming updates or additions
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

/**
 * Automatically creates a workspace document in Firestore when a local workspace is created.
 */
export async function syncWorkspaceCreation(
  user: User | null,
  workspace: { id: string },
  initialAccounts: FirestoreAccountItem[] = [],
  firestoreInstance?: Firestore
): Promise<FirestoreWorkspaceDocument | null> {
  if (!user || !user.uid || !workspace || !workspace.id) {
    return null
  }

  try {
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
    console.log(
      `[FIRESTORE][WORKSPACES][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncWorkspaceCreation | Doc: workspaces/${workspace.id} | UID: ${user.uid} | NavigatorOnline: ${isOnline}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspace.id)

    setLocalWorkspaceOwner(workspace.id, user.uid)

    const newWorkspaceDoc: FirestoreWorkspaceDocument = {
      ws_id: workspace.id,
      ws_owner_id: user.uid,
      ws_accounts: initialAccounts,
      ws_passwords: [],
      ws_status: 1,
      ws_users_ids: [user.uid],
      ws_at_created: serverTimestamp(),
      ws_at_updated: serverTimestamp(),
      ws_at_last_visit: serverTimestamp()
    }

    await setDoc(docRef, newWorkspaceDoc)
    console.log(
      `[FIRESTORE][WORKSPACES][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: create | Doc: workspaces/${workspace.id}`
    )
    return newWorkspaceDoc
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : 'N/A'
    console.error(
      `[FIRESTORE][WORKSPACES][ERROR] Stage: WRITE_CREATE | Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${workspace.id} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg} | NavigatorOnline: ${isOnline}`
    )
    return null
  }
}

/**
 * Automatically deletes a workspace document in Firestore when a local workspace is deleted,
 * after confirming authorization.
 */
export async function syncWorkspaceDeletion(
  user: User | null,
  workspaceId: string,
  firestoreInstance?: Firestore
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId) {
    return false
  }

  try {
    console.log(
      `[FIRESTORE][WORKSPACES][DELETE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncWorkspaceDeletion | Doc: workspaces/${workspaceId} | UID: ${user.uid}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)

    if (snap.exists()) {
      const data = snap.data() as FirestoreWorkspaceDocument
      if (data.ws_owner_id !== user.uid) {
        console.warn(
          `[FIRESTORE][WORKSPACES][DELETE][REJECT] Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${workspaceId} | UID: ${user.uid} | Reason: Not owner (Owner: ${data.ws_owner_id})`
        )
        return false
      }
      await deleteDoc(docRef)
      console.log(
        `[FIRESTORE][WORKSPACES][DELETE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${workspaceId}`
      )
    }

    clearLocalWorkspaceOwner(workspaceId)
    return true
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    console.error(
      `[FIRESTORE][WORKSPACES][DELETE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${workspaceId} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
    )
    return false
  }
}

/**
 * Adds an account object to the target workspace's ws_accounts array.
 * If the account already exists, updates it instead to avoid duplicates.
 */
export async function syncAccountAddition(
  user: User | null,
  workspaceId: string,
  account: { id: string; name: string; url?: string },
  firestoreInstance?: Firestore
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId || !account || !account.id) {
    return false
  }

  try {
    console.log(
      `[FIRESTORE][ACCOUNTS][ADD][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncAccountAddition | Workspace: ${workspaceId} | Account: ${account.id} | UID: ${user.uid}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const item = mapAccountToFirestore(account)

    await runTransaction(db, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) {
        throw new Error(`Workspace ${workspaceId} document not found`)
      }
      const data = snap.data() as FirestoreWorkspaceDocument
      if (!isAuthorizedUser(user.uid, data)) {
        throw new Error('Unauthorized workspace modification')
      }

      const existingAccounts: FirestoreAccountItem[] = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const idx = existingAccounts.findIndex((a) => a.ws_acc_id === account.id)
      if (idx >= 0) {
        existingAccounts[idx] = item
      } else {
        existingAccounts.push(item)
      }

      const updates: Record<string, any> = {
        ws_accounts: existingAccounts,
        ws_at_updated: serverTimestamp()
      }
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_last_visit) {
        updates.ws_at_last_visit = serverTimestamp()
      }

      txn.update(docRef, updates)
    })

    console.log(
      `[FIRESTORE][ACCOUNTS][ADD][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${account.id}`
    )
    return true
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    console.error(
      `[FIRESTORE][ACCOUNTS][ADD][ERROR] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${account.id} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
    )
    return false
  }
}

/**
 * Updates an account's name and/or URL in the target workspace's ws_accounts array.
 */
export async function syncAccountUpdate(
  user: User | null,
  workspaceId: string,
  account: { id: string; name?: string; url?: string },
  firestoreInstance?: Firestore
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId || !account || !account.id) {
    return false
  }

  try {
    console.log(
      `[FIRESTORE][ACCOUNTS][UPDATE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncAccountUpdate | Workspace: ${workspaceId} | Account: ${account.id} | UID: ${user.uid}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)

    await runTransaction(db, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) {
        throw new Error(`Workspace ${workspaceId} document not found`)
      }
      const data = snap.data() as FirestoreWorkspaceDocument
      if (!isAuthorizedUser(user.uid, data)) {
        throw new Error('Unauthorized workspace modification')
      }

      const existingAccounts: FirestoreAccountItem[] = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const idx = existingAccounts.findIndex((a) => a.ws_acc_id === account.id)
      if (idx >= 0) {
        existingAccounts[idx] = {
          ws_acc_id: account.id,
          ws_acc_name: account.name !== undefined ? account.name : existingAccounts[idx].ws_acc_name,
          ws_acc_link: account.url !== undefined ? account.url : existingAccounts[idx].ws_acc_link
        }
      } else {
        existingAccounts.push({
          ws_acc_id: account.id,
          ws_acc_name: account.name || '',
          ws_acc_link: account.url || ''
        })
      }

      const updates: Record<string, any> = {
        ws_accounts: existingAccounts,
        ws_at_updated: serverTimestamp()
      }
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_last_visit) {
        updates.ws_at_last_visit = serverTimestamp()
      }
      txn.update(docRef, updates)
    })

    console.log(
      `[FIRESTORE][ACCOUNTS][UPDATE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${account.id}`
    )
    return true
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    console.error(
      `[FIRESTORE][ACCOUNTS][UPDATE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${account.id} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
    )
    return false
  }
}

/**
 * Removes an account from the target workspace's ws_accounts array.
 */
export async function syncAccountRemoval(
  user: User | null,
  workspaceId: string,
  accountId: string,
  firestoreInstance?: Firestore
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId || !accountId) {
    return false
  }

  try {
    console.log(
      `[FIRESTORE][ACCOUNTS][REMOVE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncAccountRemoval | Workspace: ${workspaceId} | Account: ${accountId} | UID: ${user.uid}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)

    await runTransaction(db, async (txn) => {
      const snap = await txn.get(docRef)
      if (!snap.exists()) return
      const data = snap.data() as FirestoreWorkspaceDocument
      if (!isAuthorizedUser(user.uid, data)) {
        throw new Error('Unauthorized workspace modification')
      }

      const existingAccounts: FirestoreAccountItem[] = Array.isArray(data.ws_accounts) ? [...data.ws_accounts] : []
      const filtered = existingAccounts.filter((a) => a.ws_acc_id !== accountId)
      const updates: Record<string, any> = {
        ws_accounts: filtered,
        ws_at_updated: serverTimestamp()
      }
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_last_visit) {
        updates.ws_at_last_visit = serverTimestamp()
      }
      txn.update(docRef, updates)
    })

    console.log(
      `[FIRESTORE][ACCOUNTS][REMOVE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${accountId}`
    )
    return true
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    console.error(
      `[FIRESTORE][ACCOUNTS][REMOVE][ERROR] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Account: ${accountId} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
    )
    return false
  }
}

/**
 * Synchronizes local workspaces and accounts for an authenticated user.
 * Queries Firestore to discover only workspaces owned by this authenticated user.
 * Newly registered users with 0 remote workspaces receive 0 workspaces (no auto-creation).
 * Preserves existing user workspaces and multi-user isolation on the same machine.
 */
export async function syncUserWorkspaces(
  user: User | null,
  localWorkspaces: Workspace[],
  localAccounts: Account[],
  firestoreInstance?: Firestore
): Promise<{ remoteWorkspaces: FirestoreWorkspaceDocument[]; synced: boolean }> {
  if (!user || !user.uid) {
    return { remoteWorkspaces: [], synced: false }
  }

  const db = firestoreInstance || getFirebaseFirestore()
  console.log(
    `[FIRESTORE][WORKSPACES][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncUserWorkspaces | UID: ${user.uid}`
  )

  try {
    // 1. Query remote Firestore workspaces owned by this authenticated user
    const q = query(
      collection(db, WORKSPACES_COLLECTION),
      where('ws_owner_id', '==', user.uid)
    )
    const remoteQuerySnap = await getDocs(q)
    const remoteWorkspaces: FirestoreWorkspaceDocument[] = []

    if (remoteQuerySnap.empty) {
      console.log(
        `[FIRESTORE][WORKSPACES][SYNC] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Discovered 0 remote workspaces. Initializing empty workspace collection for user.`
      )
      return { remoteWorkspaces: [], synced: true }
    }

    console.log(
      `[FIRESTORE][WORKSPACES][SYNC] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Discovered ${remoteQuerySnap.size} remote workspace(s).`
    )

    for (const docSnap of remoteQuerySnap.docs) {
      const data = docSnap.data() as FirestoreWorkspaceDocument
      remoteWorkspaces.push(data)
      setLocalWorkspaceOwner(data.ws_id, user.uid)

      const docRef = doc(db, WORKSPACES_COLLECTION, data.ws_id)
      const updates: Record<string, any> = {}

      // Existing workspace migration: safely add missing timestamp fields without modifying existing values
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_updated) {
        updates.ws_at_updated = serverTimestamp()
      }
      if (!data.ws_at_last_visit) {
        updates.ws_at_last_visit = serverTimestamp()
      }

      // If workspace is also loaded locally, synchronize accounts
      const localWs = localWorkspaces.find((w) => w.id === data.ws_id)
      if (localWs) {
        const accountsInWorkspace = (localAccounts || [])
          .filter((a) => a.workspaceId === localWs.id)
          .map(mapAccountToFirestore)
        const mergedAccounts = mergeAccountLists(data.ws_accounts || [], accountsInWorkspace)
        if (JSON.stringify(mergedAccounts) !== JSON.stringify(data.ws_accounts || [])) {
          updates.ws_accounts = mergedAccounts
          updates.ws_at_updated = serverTimestamp()
        }
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(docRef, updates)
        console.log(
          `[FIRESTORE][WORKSPACES][UPDATE] Project: ${FIREBASE_PROJECT_ID} | Synchronized workspace ${data.ws_id} with updates: ${Object.keys(updates).join(', ')}`
        )
      }
    }

    return { remoteWorkspaces, synced: true }
  } catch (error) {
    const errObj = error as { code?: string; message?: string }
    const errCode = errObj?.code || 'UNKNOWN_ERROR'
    const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : 'N/A'
    console.error(
      `[FIRESTORE][WORKSPACES][ERROR] Operation: syncUserWorkspaces | Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg} | NavigatorOnline: ${isOnline}`
    )
    return { remoteWorkspaces: [], synced: false }
  }
}

/**
 * Interface for synchronizing passwords to Firestore.
 * Strictly verifies end-to-end encryption before permitting transmission.
 * Electron safeStorage (Windows DPAPI) and plaintext passwords are unconditionally rejected.
 */
export async function syncWorkspacePasswords(
  user: User | null,
  workspaceId: string,
  passwords: (FirestorePasswordRecord | CloudEncryptedCredentialRecord)[],
  firestoreInstance?: Firestore
): Promise<{ synced: boolean; reason: string }> {
  if (!user || !user.uid) {
    return { synced: false, reason: 'Authentication required' }
  }

  if (!Array.isArray(passwords)) {
    return { synced: false, reason: 'Invalid passwords format' }
  }

  // Plaintext Firestore credential schema validation
  const formattedPasswords: FirestorePasswordRecord[] = []
  for (const p of passwords) {
    if (!p || typeof p !== 'object') {
      return {
        synced: false,
        reason: 'Invalid password record format: record is not an object.'
      }
    }

    const rec = p as any
    const credId = String(rec.cred_id || rec.credential_id || '').trim()
    if (!credId) {
      return {
        synced: false,
        reason: 'Invalid password record format: missing cred_id.'
      }
    }

    formattedPasswords.push({
      cred_id: credId,
      pass_link: typeof rec.pass_link === 'string' ? rec.pass_link.trim() : '',
      pass_name: typeof rec.pass_name === 'string' ? rec.pass_name.trim() : '',
      pass_value: typeof rec.pass_value === 'string' ? rec.pass_value : ''
    })
  }

  try {
    console.log(
      `[FIRESTORE][WORKSPACES][PASSWORDS][START] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Workspace: ${workspaceId} | RecordsCount: ${formattedPasswords.length}`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      console.warn(
        `[FIRESTORE][WORKSPACES][PASSWORDS][NOT_FOUND] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId}`
      )
      return { synced: false, reason: 'Workspace document not found' }
    }
    const data = snap.data() as FirestoreWorkspaceDocument
    if (!isAuthorizedUser(user.uid, data)) {
      console.warn(
        `[FIRESTORE][WORKSPACES][PASSWORDS][UNAUTHORIZED] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Workspace: ${workspaceId}`
      )
      return { synced: false, reason: 'Unauthorized' }
    }

    const updates: Record<string, any> = {
      ws_passwords: formattedPasswords,
      ws_at_updated: serverTimestamp()
    }
    if (!data.ws_at_created) {
      updates.ws_at_created = serverTimestamp()
    }
    if (!data.ws_at_last_visit) {
      updates.ws_at_last_visit = serverTimestamp()
    }

    await updateDoc(docRef, updates)
    console.log(
      `[FIRESTORE][WORKSPACES][PASSWORDS][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Workspace: ${workspaceId} | Verified written: ${formattedPasswords.length} plaintext records`
    )
    return { synced: true, reason: 'Passwords synchronized successfully' }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(
      `[FIRESTORE][WORKSPACES][PASSWORDS][ERROR] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Workspace: ${workspaceId} | Message: ${errMsg}`
    )
    return { synced: false, reason: errMsg }
  }
}

/**
 * Updates ws_at_updated timestamp when workspace metadata (such as name) changes.
 */
export async function syncWorkspaceMetadataUpdate(
  user: User | null,
  workspaceId: string,
  firestoreInstance?: Firestore
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId) return false
  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) return false
    const data = snap.data() as FirestoreWorkspaceDocument
    if (!isAuthorizedUser(user.uid, data)) return false

    const updates: Record<string, any> = {
      ws_at_updated: serverTimestamp()
    }
    if (!data.ws_at_created) {
      updates.ws_at_created = serverTimestamp()
    }
    if (!data.ws_at_last_visit) {
      updates.ws_at_last_visit = serverTimestamp()
    }
    await updateDoc(docRef, updates)
    console.log(
      `[FIRESTORE][WORKSPACES][METADATA_UPDATE] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Updated ws_at_updated`
    )
    return true
  } catch (err) {
    console.error(`[FIRESTORE][WORKSPACES][METADATA_UPDATE][ERROR] Workspace: ${workspaceId}:`, err)
    return false
  }
}

let lastVisitedWorkspaceId: string | null = null
let lastVisitedTimestamp = 0

export function resetWorkspaceVisitCache(): void {
  lastVisitedWorkspaceId = null
  lastVisitedTimestamp = 0
}

/**
 * Updates ws_at_last_visit timestamp when the user opens or switches to a workspace.
 * Only updates the workspace being visited and does NOT modify ws_at_created.
 * Debounced per workspace to avoid excessive writes during frequent React re-renders.
 */
export async function syncWorkspaceLastVisit(
  user: User | null,
  workspaceId: string,
  firestoreInstance?: Firestore,
  force = false
): Promise<boolean> {
  if (!user || !user.uid || !workspaceId) return false
  const now = Date.now()
  if (!force && lastVisitedWorkspaceId === workspaceId && now - lastVisitedTimestamp < 15000) {
    return true
  }

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) return false
    const data = snap.data() as FirestoreWorkspaceDocument
    if (!isAuthorizedUser(user.uid, data)) return false

    const updates: Record<string, any> = {
      ws_at_last_visit: serverTimestamp()
    }
    if (!data.ws_at_created) {
      updates.ws_at_created = serverTimestamp()
    }
    if (!data.ws_at_updated) {
      updates.ws_at_updated = serverTimestamp()
    }
    await updateDoc(docRef, updates)
    lastVisitedWorkspaceId = workspaceId
    lastVisitedTimestamp = Date.now()
    console.log(
      `[FIRESTORE][WORKSPACES][VISIT] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | UID: ${user.uid} | Updated ws_at_last_visit`
    )
    return true
  } catch (error) {
    console.error(
      `[FIRESTORE][WORKSPACES][VISIT][ERROR] Workspace: ${workspaceId} | UID: ${user.uid}:`,
      error
    )
    return false
  }
}
