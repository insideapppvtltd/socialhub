import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  arrayUnion,
  arrayRemove,
  runTransaction,
  serverTimestamp,
  type Firestore
} from 'firebase/firestore'
import type { User } from 'firebase/auth'
import type { Account, Workspace } from '../main/types'
import type { CloudEncryptedCredentialRecord, FirestorePasswordRecord } from '../main/cloud-crypto'
import { getFirebaseFirestore, FIREBASE_PROJECT_ID } from './firebase'
import { USERS_COLLECTION, USER_DIRECTORY_COLLECTION, type FirestoreUserDocument, type FirestoreUserDirectoryDocument } from './firebase-users'

export const WORKSPACES_COLLECTION = 'workspaces'
export type { FirestorePasswordRecord }

export interface FirestoreAppItem {
  ws_app_id: string
  ws_app_name: string
  ws_app_link: string
}

export interface FirestoreWorkspaceDocument {
  ws_id: string
  ws_name?: string
  ws_owner_id: string
  ws_apps: FirestoreAppItem[]
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
 * Synchronizes local workspace owner bindings with authorized remote workspace IDs.
 * Cleans up any stale local workspace bindings for the user that no longer exist remotely.
 */
export function syncLocalWorkspaceOwnersWithRemote(validRemoteWorkspaceIds: string[], userUid: string): void {
  try {
    if (typeof localStorage === 'undefined' || !userUid) return
    const owners = getLocalWorkspaceOwners()
    const validSet = new Set(validRemoteWorkspaceIds)
    let changed = false
    for (const [wsId, ownerUid] of Object.entries(owners)) {
      if (ownerUid === userUid && !validSet.has(wsId)) {
        delete owners[wsId]
        changed = true
      }
    }
    if (changed) {
      localStorage.setItem(LOCAL_WORKSPACE_OWNERS_KEY, JSON.stringify(owners))
    }
  } catch (err) {
    console.error('[WORKSPACES] Failed to sync local workspace owner bindings:', err)
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

export function mapAccountToFirestore(account: { id: string; name: string; url?: string }): FirestoreAppItem {
  return {
    ws_app_id: account.id,
    ws_app_name: account.name || '',
    ws_app_link: account.url || ''
  }
}

/**
 * Merges local apps into existing remote Firestore app records without duplicates.
 */
export function mergeAccountLists(
  existingApps: FirestoreAppItem[],
  incomingApps: FirestoreAppItem[]
): FirestoreAppItem[] {
  const result: FirestoreAppItem[] = []
  const seenIds = new Set<string>()

  // Existing remote apps
  for (const app of existingApps || []) {
    if (app && app.ws_app_id && !seenIds.has(app.ws_app_id)) {
      result.push({ ...app })
      seenIds.add(app.ws_app_id)
    }
  }

  // Incoming updates or additions
  for (const inc of incomingApps || []) {
    if (!inc || !inc.ws_app_id) continue
    const idx = result.findIndex((item) => item.ws_app_id === inc.ws_app_id)
    if (idx >= 0) {
      result[idx] = {
        ws_app_id: inc.ws_app_id,
        ws_app_name: inc.ws_app_name !== undefined ? inc.ws_app_name : result[idx].ws_app_name,
        ws_app_link: inc.ws_app_link !== undefined ? inc.ws_app_link : result[idx].ws_app_link
      }
    } else {
      result.push({
        ws_app_id: inc.ws_app_id,
        ws_app_name: inc.ws_app_name || '',
        ws_app_link: inc.ws_app_link || ''
      })
      seenIds.add(inc.ws_app_id)
    }
  }

  return result
}

/**
 * Automatically creates a workspace document in Firestore when a local workspace is created.
 */
export async function syncWorkspaceCreation(
  user: User | null,
  workspace: { id: string; name?: string },
  initialApps: FirestoreAppItem[] = [],
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

    const cleanName = (workspace.name || 'Workspace').trim().slice(0, 40)
    const newWorkspaceDoc: FirestoreWorkspaceDocument = {
      ws_id: workspace.id,
      ws_name: cleanName,
      ws_owner_id: user.uid,
      ws_apps: initialApps,
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

      const existingApps: FirestoreAppItem[] = Array.isArray(data.ws_apps) ? [...data.ws_apps] : []
      const idx = existingApps.findIndex((a) => a.ws_app_id === account.id)
      if (idx >= 0) {
        existingApps[idx] = item
      } else {
        existingApps.push(item)
      }

      const updates: Record<string, any> = {
        ws_apps: existingApps,
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

      const existingApps: FirestoreAppItem[] = Array.isArray(data.ws_apps) ? [...data.ws_apps] : []
      const idx = existingApps.findIndex((a) => a.ws_app_id === account.id)
      if (idx >= 0) {
        existingApps[idx] = {
          ws_app_id: account.id,
          ws_app_name: account.name !== undefined ? account.name : existingApps[idx].ws_app_name,
          ws_app_link: account.url !== undefined ? account.url : existingApps[idx].ws_app_link
        }
      } else {
        existingApps.push({
          ws_app_id: account.id,
          ws_app_name: account.name || '',
          ws_app_link: account.url || ''
        })
      }

      const updates: Record<string, any> = {
        ws_apps: existingApps,
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

      const existingApps: FirestoreAppItem[] = Array.isArray(data.ws_apps) ? [...data.ws_apps] : []
      const filtered = existingApps.filter((a) => a.ws_app_id !== accountId)
      const updates: Record<string, any> = {
        ws_apps: filtered,
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
): Promise<{
  remoteWorkspaces: FirestoreWorkspaceDocument[]
  synced: boolean
  memberQueryFailed?: boolean
  memberQueryError?: { code: string; message: string }
}> {
  if (!user || !user.uid) {
    return { remoteWorkspaces: [], synced: false }
  }

  const db = firestoreInstance || getFirebaseFirestore()
  console.log(
    `[FIRESTORE][WORKSPACES][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncUserWorkspaces | UID: ${user.uid}`
  )

  try {
    // 1. Query remote Firestore workspaces owned by this user or where user is a collaborator
    const qOwner = query(
      collection(db, WORKSPACES_COLLECTION),
      where('ws_owner_id', '==', user.uid)
    )
    const qMember = query(
      collection(db, WORKSPACES_COLLECTION),
      where('ws_users_ids', 'array-contains', user.uid)
    )
    let memberQueryError: { code: string; message: string } | null = null
    const [snapOwner, snapMember] = await Promise.all([
      getDocs(qOwner),
      getDocs(qMember).catch((memberErr) => {
        const errCode = (memberErr as { code?: string })?.code || 'UNKNOWN_ERROR'
        const errMsg = memberErr instanceof Error ? memberErr.message : String(memberErr)
        memberQueryError = { code: errCode, message: errMsg }
        console.error(
          `[FIRESTORE][WORKSPACES][QUERY_MEMBER][ERROR] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
        )
        return null
      })
    ])

    const docMap = new Map<string, any>()
    for (const docSnap of snapOwner.docs) {
      docMap.set(docSnap.id, docSnap)
    }
    if (snapMember) {
      for (const docSnap of snapMember.docs) {
        if (!docMap.has(docSnap.id)) {
          docMap.set(docSnap.id, docSnap)
        }
      }
    }
    const allDocs = Array.from(docMap.values())
    const remoteWorkspaces: FirestoreWorkspaceDocument[] = []
    const sharedCountLabel = snapMember ? String(snapMember.docs.length) : 'FAILED'

    if (allDocs.length === 0) {
      console.log(
        `[FIRESTORE][WORKSPACES][SYNC] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Owned: 0 | Shared: ${sharedCountLabel} | Discovered 0 remote workspaces. Initializing empty workspace collection for user.`
      )
      return memberQueryError
        ? { remoteWorkspaces: [], synced: true, memberQueryFailed: true, memberQueryError }
        : { remoteWorkspaces: [], synced: true }
    }

    console.log(
      `[FIRESTORE][WORKSPACES][SYNC] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Owned: ${snapOwner.docs.length} | Shared: ${sharedCountLabel} | Discovered ${allDocs.length} remote workspace(s).`
    )

    for (const docSnap of allDocs) {
      const rawData = docSnap.data() as Record<string, any>
      const hasLegacyAccounts = Object.prototype.hasOwnProperty.call(rawData, 'ws_accounts')
      const existingWsApps: FirestoreAppItem[] = Array.isArray(rawData.ws_apps) ? rawData.ws_apps : []

      const data: FirestoreWorkspaceDocument = {
        ...(rawData as FirestoreWorkspaceDocument),
        ws_id: rawData.ws_id || docSnap.id,
        ws_apps: existingWsApps
      }
      // If legacy-only document has ws_accounts and no ws_apps yet, derive ws_apps in memory before owner cleanup
      if (!Array.isArray(rawData.ws_apps) && Array.isArray(rawData.ws_accounts)) {
        const migrated: FirestoreAppItem[] = []
        const seen = new Set<string>()
        for (const item of rawData.ws_accounts) {
          const id = (item?.ws_app_id || item?.ws_acc_id || '').trim()
          if (!id || seen.has(id)) continue
          seen.add(id)
          migrated.push({
            ws_app_id: id,
            ws_app_name: String(item?.ws_app_name ?? item?.ws_acc_name ?? ''),
            ws_app_link: String(item?.ws_app_link ?? item?.ws_acc_link ?? '')
          })
        }
        data.ws_apps = migrated
      }

      remoteWorkspaces.push(data)
      setLocalWorkspaceOwner(data.ws_id, data.ws_owner_id || user.uid)

      if (data.ws_owner_id !== user.uid) {
        continue
      }

      const docRef = doc(db, WORKSPACES_COLLECTION, data.ws_id)
      const updates: Record<string, any> = {}

      // One-time idempotent cleanup of legacy ws_accounts field on owner workspace documents
      if (hasLegacyAccounts) {
        if (!Array.isArray(rawData.ws_apps)) {
          updates.ws_apps = data.ws_apps
        }
        updates.ws_accounts = deleteField()
      }

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

      // If existing remote workspace document lacks ws_name, populate it from local name if available
      const localWs = localWorkspaces.find((w) => w.id === data.ws_id)
      if (!data.ws_name && localWs?.name) {
        const cleanLocalName = localWs.name.trim().slice(0, 40)
        if (cleanLocalName) {
          updates.ws_name = cleanLocalName
          data.ws_name = cleanLocalName
        }
      }

      if (localWs) {
        // Only upload local apps that are NOT yet synced to cloud (pending offline apps)
        const pendingLocalAccounts = (localAccounts || [])
          .filter((a) => a.workspaceId === localWs.id && !(a as any).syncedToCloud)
          .map(mapAccountToFirestore)
        if (pendingLocalAccounts.length > 0) {
          const mergedApps = mergeAccountLists(data.ws_apps || [], pendingLocalAccounts)
          if (JSON.stringify(mergedApps) !== JSON.stringify(data.ws_apps || [])) {
            updates.ws_apps = mergedApps
            data.ws_apps = mergedApps
            updates.ws_at_updated = serverTimestamp()
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(docRef, updates)
        console.log(
          `[FIRESTORE][WORKSPACES][UPDATE] Project: ${FIREBASE_PROJECT_ID} | Synchronized workspace ${data.ws_id} with updates: ${Object.keys(updates).join(', ')}`
        )
      }
    }

    return memberQueryError
      ? { remoteWorkspaces, synced: true, memberQueryFailed: true, memberQueryError }
      : { remoteWorkspaces, synced: true }
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
    const passId = String(rec.pass_id || rec.cred_id || rec.credential_id || '').trim()
    if (!passId) {
      return {
        synced: false,
        reason: 'Invalid password record format: missing pass_id.'
      }
    }

    formattedPasswords.push({
      pass_id: passId,
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
  metadata?: { name?: string },
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
    if (metadata?.name && metadata.name.trim()) {
      updates.ws_name = metadata.name.trim()
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
    if (data.ws_owner_id === user.uid) {
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_updated) {
        updates.ws_at_updated = serverTimestamp()
      }
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

/**
 * Performs a strictly non-real-time, one-time fetch of workspace data when switching or visiting a workspace.
 * Reads the latest document with getDoc, updates ws_at_last_visit,
 * and does NOT establish any continuous listeners or polling loops.
 */
export async function syncWorkspaceOnSwitch(
  user: User | null,
  workspaceId: string,
  firestoreInstance?: Firestore
): Promise<FirestoreWorkspaceDocument | null> {
  if (!user || !user.uid || !workspaceId) return null

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) return null
    const rawData = snap.data() as FirestoreWorkspaceDocument
    const data: FirestoreWorkspaceDocument = {
      ...rawData,
      ws_id: rawData.ws_id || snap.id,
      ws_apps: Array.isArray(rawData.ws_apps) ? rawData.ws_apps : []
    }
    if (!isAuthorizedUser(user.uid, data)) return null

    const updates: Record<string, any> = {
      ws_at_last_visit: serverTimestamp()
    }
    if (data.ws_owner_id === user.uid) {
      if (!data.ws_at_created) {
        updates.ws_at_created = serverTimestamp()
      }
      if (!data.ws_at_updated) {
        updates.ws_at_updated = serverTimestamp()
      }
    }
    await updateDoc(docRef, updates)
    lastVisitedWorkspaceId = workspaceId
    lastVisitedTimestamp = Date.now()

    console.log(
      `[FIRESTORE][WORKSPACES][SWITCH] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | UID: ${user.uid} | One-time fetch and last visit update complete.`
    )
    return data
  } catch (error) {
    console.error(
      `[FIRESTORE][WORKSPACES][SWITCH][ERROR] Workspace: ${workspaceId} | UID: ${user.uid}:`,
      error
    )
    return null
  }
}

export interface WorkspaceCollaboratorProfile {
  user_id: string
  user_name: string
  user_email: string
  user_dp_link: string
}

export interface WorkspaceCollaborationDetails {
  workspaceId: string
  ownerId: string
  owner: WorkspaceCollaboratorProfile | null
  collaborators: WorkspaceCollaboratorProfile[]
  rawUserIds: string[]
}

const EMAIL_VALIDATION_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

export function isValidCollaboratorEmail(email: string): boolean {
  const trimmed = (email || '').trim()
  return trimmed.length > 0 && EMAIL_VALIDATION_REGEX.test(trimmed)
}

function mapUserDocToProfile(uid: string, raw?: Partial<FirestoreUserDocument> | null): WorkspaceCollaboratorProfile {
  return {
    user_id: (raw?.user_id || uid).trim(),
    user_name: (raw?.user_name || '').trim() || 'Social HUB User',
    user_email: (raw?.user_email || '').trim(),
    user_dp_link: (raw?.user_dp_link || '').trim()
  }
}

/**
 * Resolves minimal user directory profiles from `user_directory/{uid}` for a list of UIDs.
 * Full `users/{uid}` documents remain private; only falls back to `users/{currentUserUid}` for self.
 */
export async function resolveUserProfilesByIds(
  uids: string[],
  firestoreInstance?: Firestore,
  currentUserUid?: string
): Promise<Map<string, WorkspaceCollaboratorProfile>> {
  const uniqueIds = Array.from(new Set((uids || []).map((id) => (id || '').trim()).filter(Boolean)))
  const result = new Map<string, WorkspaceCollaboratorProfile>()
  if (uniqueIds.length === 0) return result

  const db = firestoreInstance || getFirebaseFirestore()
  await Promise.all(
    uniqueIds.map(async (uid) => {
      try {
        const dirSnap = await getDoc(doc(db, USER_DIRECTORY_COLLECTION, uid))
        if (dirSnap.exists()) {
          const data = dirSnap.data() as Partial<FirestoreUserDirectoryDocument>
          result.set(uid, mapUserDocToProfile(uid, data))
          return
        }
        // Only read own private `users/{uid}` document as a fallback
        if (currentUserUid && uid === currentUserUid) {
          const selfSnap = await getDoc(doc(db, USERS_COLLECTION, uid))
          if (selfSnap.exists()) {
            const data = selfSnap.data() as Partial<FirestoreUserDocument>
            result.set(uid, mapUserDocToProfile(uid, data))
            return
          }
        }
        result.set(uid, {
          user_id: uid,
          user_name: 'Unknown User',
          user_email: `UID: ${uid.slice(0, 8)}...`,
          user_dp_link: ''
        })
      } catch (err) {
        console.warn(`[FIRESTORE][COLLAB] Could not resolve directory profile ${uid}:`, err)
        result.set(uid, {
          user_id: uid,
          user_name: 'Unknown User',
          user_email: `UID: ${uid.slice(0, 8)}...`,
          user_dp_link: ''
        })
      }
    })
  )

  return result
}

export function formatFirestoreCollabError(
  error: unknown,
  operation: string,
  workspaceId = 'N/A',
  fallbackMessage = 'Something went wrong while updating workspace collaborators.',
  authUid = 'N/A'
): string {
  const errObj = error as { code?: string; message?: string }
  const errCode = typeof errObj?.code === 'string' ? errObj.code : 'unknown'
  const rawMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
  console.error(
    `[FIRESTORE][COLLAB][ERROR] Operation: ${operation} | UID: ${authUid} | Workspace: ${workspaceId} | Code: ${errCode} | Message: ${rawMsg}`
  )
  if (errCode === 'permission-denied' || /missing or insufficient permissions/i.test(rawMsg)) {
    return 'You do not have permission to manage collaborators in this workspace.'
  }
  if (
    errCode === 'unavailable' ||
    errCode === 'deadline-exceeded' ||
    errCode === 'network-request-failed' ||
    /network|offline|unavailable|failed to fetch/i.test(rawMsg)
  ) {
    return 'Unable to connect to Firebase. Please try again.'
  }
  if (errCode === 'not-found') {
    return 'Workspace document not found.'
  }
  return fallbackMessage
}

/**
 * Fetches workspace collaboration metadata (owner + collaborators resolved from `users`).
 */
export async function fetchWorkspaceCollaborationDetails(
  user: User | null,
  workspaceId: string,
  firestoreInstance?: Firestore
): Promise<WorkspaceCollaborationDetails> {
  if (!user || !user.uid || !workspaceId) {
    throw new Error('Authentication and workspace ID are required.')
  }

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      throw new Error('Workspace not found in cloud.')
    }

    const data = snap.data() as FirestoreWorkspaceDocument
    if (!isAuthorizedUser(user.uid, data)) {
      throw new Error('You do not have permission to view this workspace.')
    }

    const ownerId = (data.ws_owner_id || '').trim()
    const rawUserIds = Array.from(
      new Set(
        (Array.isArray(data.ws_users_ids) ? data.ws_users_ids : [ownerId])
          .map((id) => (id || '').trim())
          .filter(Boolean)
      )
    )

    const profiles = await resolveUserProfilesByIds([ownerId, ...rawUserIds], db, user.uid)
    const owner = ownerId ? profiles.get(ownerId) ?? null : null
    const collaborators: WorkspaceCollaboratorProfile[] = []
    const seenCollab = new Set<string>()
    for (const uid of rawUserIds) {
      if (!uid || uid === ownerId || seenCollab.has(uid)) continue
      seenCollab.add(uid)
      const prof = profiles.get(uid)
      if (prof) collaborators.push(prof)
    }

    return {
      workspaceId,
      ownerId,
      owner,
      collaborators,
      rawUserIds
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('not found in cloud') || error.message.includes('permission to view'))) {
      throw error
    }
    throw new Error(
      formatFirestoreCollabError(error, 'fetchWorkspaceCollaborationDetails', workspaceId, 'Unable to load workspace collaborators.')
    )
  }
}

/**
 * Searches the minimal `user_directory` collection by `user_email` using trimmed, lowercase matching.
 * Uses bounded equality queries (`limit(5)`) without exposing full `users` documents.
 */
export async function findRegisteredUserByEmail(
  email: string,
  firestoreInstance?: Firestore
): Promise<WorkspaceCollaboratorProfile | null> {
  const trimmed = (email || '').trim()
  if (!isValidCollaboratorEmail(trimmed)) {
    throw new Error('Please enter a valid email address.')
  }
  const normalizedLower = trimmed.toLowerCase()
  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const directoryRef = collection(db, USER_DIRECTORY_COLLECTION)

    // Bounded lowercase equality query on minimal user_directory
    const qLower = query(directoryRef, where('user_email', '==', normalizedLower), limit(5))
    const snapLower = await getDocs(qLower)
    if (!snapLower.empty) {
      const first = snapLower.docs[0]
      return mapUserDocToProfile(first.id, first.data() as Partial<FirestoreUserDirectoryDocument>)
    }

    return null
  } catch (error) {
    throw new Error(
      formatFirestoreCollabError(error, 'findRegisteredUserByEmail', 'N/A', 'Something went wrong while looking up the user.')
    )
  }
}

/**
 * Adds a registered collaborator UID to `ws_users_ids` atomically via `arrayUnion`.
 * Enforces owner-only authorization and prevents duplicate/owner additions.
 */
export async function addWorkspaceCollaborator(
  user: User | null,
  workspaceId: string,
  collaboratorUid: string,
  firestoreInstance?: Firestore
): Promise<{
  added: boolean
  status: 'added' | 'already_collaborator' | 'is_owner' | 'unauthorized' | 'not_found' | 'error'
  message: string
}> {
  if (!user || !user.uid || !workspaceId || !collaboratorUid) {
    return { added: false, status: 'unauthorized', message: 'Authentication and valid user ID are required.' }
  }

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      return { added: false, status: 'not_found', message: 'Workspace document not found.' }
    }

    const data = snap.data() as FirestoreWorkspaceDocument
    if (data.ws_owner_id !== user.uid) {
      return { added: false, status: 'unauthorized', message: 'Only the workspace owner can add collaborators.' }
    }

    if (collaboratorUid === data.ws_owner_id) {
      return { added: false, status: 'is_owner', message: 'This user is the owner of this workspace.' }
    }

    const currentIds = Array.isArray(data.ws_users_ids) ? data.ws_users_ids : []
    if (currentIds.includes(collaboratorUid)) {
      return {
        added: false,
        status: 'already_collaborator',
        message: 'This user is already a collaborator in this workspace.'
      }
    }

    const idsToAdd = currentIds.includes(data.ws_owner_id)
      ? [collaboratorUid]
      : [data.ws_owner_id, collaboratorUid]

    await updateDoc(docRef, {
      ws_users_ids: arrayUnion(...idsToAdd),
      ws_at_updated: serverTimestamp()
    })

    console.log(
      `[FIRESTORE][WORKSPACES][COLLAB][ADD] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Workspace: ${workspaceId} | Added UID: ${collaboratorUid}`
    )
    return { added: true, status: 'added', message: 'Collaborator added successfully.' }
  } catch (error) {
    return {
      added: false,
      status: 'error',
      message: formatFirestoreCollabError(error, 'addWorkspaceCollaborator', workspaceId, 'Something went wrong while updating workspace collaborators.', user.uid)
    }
  }
}

/**
 * Removes a collaborator UID from `ws_users_ids` atomically via `arrayRemove`.
 * Enforces owner-only authorization and prevents removing the owner.
 */
export async function removeWorkspaceCollaborator(
  user: User | null,
  workspaceId: string,
  collaboratorUid: string,
  firestoreInstance?: Firestore
): Promise<{ removed: boolean; message: string }> {
  if (!user || !user.uid || !workspaceId || !collaboratorUid) {
    return { removed: false, message: 'Authentication and valid user ID are required.' }
  }

  try {
    const db = firestoreInstance || getFirebaseFirestore()
    const docRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
    const snap = await getDoc(docRef)
    if (!snap.exists()) {
      return { removed: false, message: 'Workspace document not found.' }
    }

    const data = snap.data() as FirestoreWorkspaceDocument
    if (data.ws_owner_id !== user.uid) {
      return { removed: false, message: 'Only the workspace owner can remove collaborators.' }
    }

    if (collaboratorUid === data.ws_owner_id) {
      return { removed: false, message: 'The workspace owner cannot be removed.' }
    }

    await updateDoc(docRef, {
      ws_users_ids: arrayRemove(collaboratorUid),
      ws_at_updated: serverTimestamp()
    })

    console.log(
      `[FIRESTORE][WORKSPACES][COLLAB][REMOVE] Project: ${FIREBASE_PROJECT_ID} | Workspace: ${workspaceId} | Removed UID: ${collaboratorUid}`
    )
    return { removed: true, message: 'Collaborator removed successfully.' }
  } catch (error) {
    return {
      removed: false,
      message: formatFirestoreCollabError(error, 'removeWorkspaceCollaborator', workspaceId, 'Something went wrong while removing the collaborator.')
    }
  }
}
