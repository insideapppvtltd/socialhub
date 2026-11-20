import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  type Firestore
} from 'firebase/firestore'
import type { User } from 'firebase/auth'
import type { Account, Workspace } from '../main/types'
import { getFirebaseFirestore, FIREBASE_PROJECT_ID } from './firebase'

export const WORKSPACES_COLLECTION = 'workspaces'

export interface FirestoreAccountItem {
  ws_acc_id: string
  ws_acc_name: string
  ws_acc_link: string
}

export interface FirestorePasswordItem {
  pass_link: string
  pass_name: string
  pass_value: string
}

export interface FirestoreWorkspaceDocument {
  ws_id: string
  ws_owner_id: string
  ws_accounts: FirestoreAccountItem[]
  ws_passwords: FirestorePasswordItem[]
  ws_status: number
  ws_users_ids: string[]
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
      ws_users_ids: [user.uid]
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

      txn.update(docRef, { ws_accounts: existingAccounts })
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
      txn.update(docRef, { ws_accounts: filtered })
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
 * Establishes safe local ownership binding so multi-user accounts on a single machine
 * do not overwrite or claim each other's workspaces.
 */
export async function syncUserWorkspaces(
  user: User | null,
  localWorkspaces: Workspace[],
  localAccounts: Account[],
  firestoreInstance?: Firestore
): Promise<void> {
  if (!user || !user.uid || !Array.isArray(localWorkspaces)) {
    return
  }

  const db = firestoreInstance || getFirebaseFirestore()
  console.log(
    `[FIRESTORE][WORKSPACES][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncUserWorkspaces | UID: ${user.uid} | Total Workspaces: ${localWorkspaces.length}`
  )

  for (const ws of localWorkspaces) {
    let currentOp = 'INITIALIZE'
    try {
      const db = firestoreInstance || getFirebaseFirestore()
      const docRef = doc(db, WORKSPACES_COLLECTION, ws.id)
      currentOp = 'READ'
      console.log(
        `[FIRESTORE][WORKSPACES][READ][START] Project: ${FIREBASE_PROJECT_ID} | Operation: getDoc | Doc: workspaces/${ws.id} | UID: ${user.uid}`
      )
      const snap = await getDoc(docRef)
      console.log(
        `[FIRESTORE][WORKSPACES][READ][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${ws.id} | Exists: ${snap.exists()}`
      )

      const accountsInWorkspace = (localAccounts || [])
        .filter((a) => a.workspaceId === ws.id)
        .map(mapAccountToFirestore)

      if (snap.exists()) {
        const data = snap.data() as FirestoreWorkspaceDocument
        if (!isAuthorizedUser(user.uid, data)) {
          console.warn(
            `[FIRESTORE][WORKSPACES][SKIP] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Doc: workspaces/${ws.id} | Reason: Owned by remote UID ${data.ws_owner_id}`
          )
          continue
        }

        // Establish local binding to the existing remote owner
        setLocalWorkspaceOwner(ws.id, data.ws_owner_id)

        // Merge accounts safely without duplicating or overwriting unrelated fields
        const mergedAccounts = mergeAccountLists(data.ws_accounts || [], accountsInWorkspace)
        currentOp = 'WRITE_UPDATE'
        console.log(
          `[FIRESTORE][WORKSPACES][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: updateDoc | Doc: workspaces/${ws.id} | Accounts: ${mergedAccounts.length}`
        )
        await updateDoc(docRef, {
          ws_accounts: mergedAccounts
        })
        console.log(
          `[FIRESTORE][WORKSPACES][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: update | Doc: workspaces/${ws.id}`
        )
      } else {
        // Document does not exist in Firestore.
        // Bind local ownership and create initial document in Firestore
        currentOp = 'WRITE_CREATE'
        console.log(
          `[FIRESTORE][WORKSPACES][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: setDoc | Doc: workspaces/${ws.id} | Owner: ${user.uid} | Accounts: ${accountsInWorkspace.length}`
        )
        setLocalWorkspaceOwner(ws.id, user.uid)

        const initialDoc: FirestoreWorkspaceDocument = {
          ws_id: ws.id,
          ws_owner_id: user.uid,
          ws_accounts: accountsInWorkspace,
          ws_passwords: [],
          ws_status: 1,
          ws_users_ids: [user.uid]
        }

        await setDoc(docRef, initialDoc)
        console.log(
          `[FIRESTORE][WORKSPACES][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: create | Doc: workspaces/${ws.id}`
        )
      }
    } catch (error) {
      const errObj = error as { code?: string; message?: string }
      const errCode = errObj?.code || 'UNKNOWN_ERROR'
      const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : 'N/A'
      console.error(
        `[FIRESTORE][WORKSPACES][ERROR] Stage: ${currentOp} | Project: ${FIREBASE_PROJECT_ID} | Doc: workspaces/${ws.id} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg} | NavigatorOnline: ${isOnline}`
      )
    }
  }
}

export interface PasswordSyncProvider {
  isPortableEncryptionConfigured(): boolean
  encryptForSync(plainText: string): Promise<string>
  decryptFromSync(cipherText: string): Promise<string>
}

/**
 * Interface for synchronizing passwords to Firestore.
 * Strictly verifies zero-knowledge encryption before permitting transmission.
 * Electron safeStorage (Windows DPAPI) and plaintext passwords are unconditionally rejected.
 */
export async function syncWorkspacePasswords(
  user: User | null,
  workspaceId: string,
  passwords: FirestorePasswordItem[],
  provider?: PasswordSyncProvider,
  firestoreInstance?: Firestore
): Promise<{ synced: boolean; reason: string }> {
  if (!user || !user.uid) {
    return { synced: false, reason: 'Authentication required' }
  }

  if (!provider || !provider.isPortableEncryptionConfigured()) {
    return {
      synced: false,
      reason:
        'Portable end-to-end encryption key management is not configured. Plaintext and machine-bound DPAPI passwords cannot be synchronized.'
    }
  }

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      return { synced: false, reason: 'Workspace document not found' }
    }
    const data = snap.data() as FirestoreWorkspaceDocument
    if (!isAuthorizedUser(user.uid, data)) {
      return { synced: false, reason: 'Unauthorized' }
    }

    await updateDoc(docRef, { ws_passwords: passwords })
    return { synced: true, reason: 'Passwords synchronized successfully' }
  } catch (error) {
    return { synced: false, reason: error instanceof Error ? error.message : 'Sync failed' }
  }
}
