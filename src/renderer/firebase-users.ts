import { doc, getDoc, setDoc, updateDoc, serverTimestamp, deleteField, type Firestore } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import type { UserPasswordCryptoMetadata } from '../main/cloud-crypto'
import { getFirebaseFirestore, FIREBASE_PROJECT_ID } from './firebase'

export const USERS_COLLECTION = 'users'
export const PASSWORD_CRYPTO_COLLECTION = 'password_crypto'

export interface FirestoreUserDocument {
  user_id: string
  user_name: string
  user_email: string
  user_dp_link: string
  user_login_provider: 'GOOGLE' | 'ANONYMOUS'
  user_at_created: any
  user_at_last_visit: any
  user_status: number
}

/**
 * Derives user display name, email, and photo link safely from Firebase user profile.
 * Anonymous users receive a clean default without inventing a fake email.
 */
export function resolveUserProfile(user: User): {
  name: string
  email: string
  dpLink: string
} {
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

let lastSyncedUid: string | null = null
let lastSyncTimestamp = 0
let inFlightSyncUid: string | null = null
let inFlightSync: Promise<FirestoreUserDocument | null> | null = null

export function resetUserSyncCache(): void {
  lastSyncedUid = null
  lastSyncTimestamp = 0
  inFlightSyncUid = null
  inFlightSync = null
}

/**
 * Synchronizes authenticated user information to the 'users' Firestore collection.
 * Creates document `users/{firebase_uid}` if absent, or updates it if present.
 * Never overwrites `user_at_created`. Initializes `user_status` to 1 if missing.
 * Prevents redundant writes from React re-renders while ensuring fresh logins are never skipped.
 */
export async function syncUserDocument(
  user: User | null,
  firestoreInstance?: Firestore,
  force = false
): Promise<FirestoreUserDocument | null> {
  if (!user || !user.uid) {
    return null
  }

  const now = Date.now()
  const isDifferentUser = lastSyncedUid !== user.uid
  if (!force && !isDifferentUser && now - lastSyncTimestamp < 60000) {
    console.log(
      `[FIRESTORE][USERS][SKIP] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Reason: Recent sync completed within 60s`
    )
    return null
  }

  if (inFlightSync && inFlightSyncUid === user.uid) {
    console.log(
      `[FIRESTORE][USERS][JOIN] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Joining existing in-flight sync`
    )
    return inFlightSync
  }

  inFlightSyncUid = user.uid
  inFlightSync = (async () => {
    let currentOp = 'INITIALIZE'
    try {
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
      console.log(
        `[FIRESTORE][USERS][START] Project: ${FIREBASE_PROJECT_ID} | Operation: syncUserDocument | UID: ${user.uid} | Force: ${force} | NavigatorOnline: ${isOnline}`
      )

      const db = firestoreInstance || getFirebaseFirestore()
      const userRef = doc(db, USERS_COLLECTION, user.uid)

      currentOp = 'READ'
      console.log(
        `[FIRESTORE][USERS][READ][START] Project: ${FIREBASE_PROJECT_ID} | Operation: getDoc | Doc: users/${user.uid}`
      )
      const snap = await getDoc(userRef)
      console.log(
        `[FIRESTORE][USERS][READ][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Doc: users/${user.uid} | Exists: ${snap.exists()}`
      )
      const profile = resolveUserProfile(user)

      if (!snap.exists()) {
        currentOp = 'WRITE_CREATE'
        console.log(
          `[FIRESTORE][USERS][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: setDoc | Doc: users/${user.uid} | Name: ${profile.name}`
        )
        const newDoc: FirestoreUserDocument = {
          user_id: user.uid,
          user_name: profile.name,
          user_email: profile.email,
          user_dp_link: profile.dpLink,
          user_login_provider: user.isAnonymous ? 'ANONYMOUS' : 'GOOGLE',
          user_at_created: serverTimestamp(),
          user_at_last_visit: serverTimestamp(),
          user_status: 1
        }
        await setDoc(userRef, newDoc)
        lastSyncedUid = user.uid
        lastSyncTimestamp = Date.now()
        console.log(
          `[FIRESTORE][USERS][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: create | Doc: users/${user.uid} | Provider: ${newDoc.user_login_provider}`
        )
        return newDoc
      } else {
        currentOp = 'WRITE_UPDATE'
        console.log(
          `[FIRESTORE][USERS][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | Operation: updateDoc | Doc: users/${user.uid}`
        )
        const existing = snap.data() as Partial<FirestoreUserDocument>
        const updates: Record<string, any> = {
          user_name: profile.name || existing?.user_name || 'User',
          user_email: profile.email,
          user_dp_link: profile.dpLink,
          user_login_provider: existing?.user_login_provider || (user.isAnonymous ? 'ANONYMOUS' : 'GOOGLE'),
          user_at_last_visit: serverTimestamp()
        }

        // Important: user_id, user_at_created, and user_status are never modified on update
        await updateDoc(userRef, updates)
        lastSyncedUid = user.uid
        lastSyncTimestamp = Date.now()
        console.log(
          `[FIRESTORE][USERS][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: update | Doc: users/${user.uid}`
        )
        return {
          ...existing,
          ...updates,
          user_id: user.uid,
          user_at_created: existing?.user_at_created
        } as FirestoreUserDocument
      }
    } catch (error) {
      const errObj = error as { code?: string; message?: string }
      const errCode = errObj?.code || 'UNKNOWN_ERROR'
      const errMsg = errObj?.message || (error instanceof Error ? error.message : String(error))
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : 'N/A'
      console.error(
        `[FIRESTORE][USERS][ERROR] Stage: ${currentOp} | Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Doc: users/${user.uid} | Code: ${errCode} | Message: ${errMsg} | NavigatorOnline: ${isOnline}`
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

/**
 * Fetches the current user document from Firestore.
 */
export async function getUserDocument(
  user: User | null,
  firestoreInstance?: Firestore
): Promise<FirestoreUserDocument | null> {
  if (!user || !user.uid) return null
  try {
    console.log(`[FIRESTORE][USERS][READ][START] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Operation: getUserDocument`)
    const db = firestoreInstance || getFirebaseFirestore()
    const userRef = doc(db, USERS_COLLECTION, user.uid)
    const snap = await getDoc(userRef)
    if (snap.exists()) {
      const data = snap.data() as FirestoreUserDocument
      console.log(
        `[FIRESTORE][USERS][READ][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Provider: ${data.user_login_provider}`
      )
      return data
    }
    console.log(`[FIRESTORE][USERS][READ][NOT_FOUND] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid}`)
    return null
  } catch (error) {
    console.error(`[FIRESTORE][USERS][READ][ERROR] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid}:`, error)
    return null
  }
}

export type PasswordCryptoLookupStatus =
  | 'found'
  | 'not_found'
  | 'permission_denied'
  | 'unavailable'
  | 'error'

export interface PasswordCryptoLookupResult {
  status: PasswordCryptoLookupStatus
  metadata: UserPasswordCryptoMetadata | null
  error?: string
}

let inFlightCryptoLookupUid: string | null = null
let inFlightCryptoLookupPromise: Promise<PasswordCryptoLookupResult> | null = null
let cachedCryptoLookupUid: string | null = null
let cachedCryptoLookupResult: PasswordCryptoLookupResult | null = null

export function resetPasswordCryptoLookupCache(): void {
  cachedCryptoLookupUid = null
  cachedCryptoLookupResult = null
  inFlightCryptoLookupUid = null
  inFlightCryptoLookupPromise = null
}

/**
 * Retrieves the user's E2EE password_crypto metadata from the separate password_crypto/{uid} collection.
 * Includes backward-compatible migration from legacy users/{uid} document if not yet migrated.
 * Accurately distinguishes between:
 * - 'found': Metadata exists and was successfully retrieved.
 * - 'not_found': User genuinely does not have metadata anywhere.
 * - 'permission_denied': Access was denied by Firestore security rules.
 * - 'unavailable': Client is offline or Firestore is unreachable.
 * - 'error': Generic error.
 *
 * Implements deduplication of concurrent in-flight requests and avoids infinite retry loops on permission-denied.
 */
export async function getUserPasswordCryptoResult(
  user: User | null,
  firestoreInstance?: Firestore,
  force = false
): Promise<PasswordCryptoLookupResult> {
  if (!user || !user.uid) {
    return { status: 'not_found', metadata: null }
  }

  // 1. If not forcing a refresh and we recently cached a permission_denied result for this UID, return it immediately
  if (!force && cachedCryptoLookupUid === user.uid && cachedCryptoLookupResult?.status === 'permission_denied') {
    return cachedCryptoLookupResult
  }

  // 2. Prevent concurrent in-flight lookups for the same UID
  if (inFlightCryptoLookupUid === user.uid && inFlightCryptoLookupPromise) {
    return inFlightCryptoLookupPromise
  }

  inFlightCryptoLookupUid = user.uid
  inFlightCryptoLookupPromise = (async (): Promise<PasswordCryptoLookupResult> => {
    const db = firestoreInstance || getFirebaseFirestore()
    const dbId = (db as any)?._databaseId?.database || (db as any)?.databaseId || '(default)'
    const cryptoRef = doc(db, PASSWORD_CRYPTO_COLLECTION, user.uid)
    const userRef = doc(db, USERS_COLLECTION, user.uid)
    const cryptoDocPath = `${PASSWORD_CRYPTO_COLLECTION}/${user.uid}`
    const userDocPath = `${USERS_COLLECTION}/${user.uid}`

    let cryptoSnap: any = null
    let cryptoError: any = null

    // 1. Separate Diagnostic: Reading password_crypto/{uid}
    try {
      console.log(
        `[FIRESTORE][CRYPTO][READ][START] Database: ${dbId} | Project: ${FIREBASE_PROJECT_ID} | Collection: ${PASSWORD_CRYPTO_COLLECTION} | DocId: ${user.uid} | Path: ${cryptoDocPath} | AuthUID: ${user.uid} | Operation: getDoc`
      )
      cryptoSnap = await getDoc(cryptoRef)
      if (cryptoSnap.exists()) {
        const meta = cryptoSnap.data() as UserPasswordCryptoMetadata
        console.log(
          `[FIRESTORE][CRYPTO][READ][SUCCESS] Database: ${dbId} | Path: ${cryptoDocPath} | AuthUID: ${user.uid} | DocExists: true | HasValidWrapping: ${Boolean(meta?.wrapping?.encryptedDek)}`
        )
        const result: PasswordCryptoLookupResult = { status: 'found', metadata: meta }
        cachedCryptoLookupUid = user.uid
        cachedCryptoLookupResult = result
        return result
      } else {
        console.log(
          `[FIRESTORE][CRYPTO][READ][NOT_FOUND] Database: ${dbId} | Path: ${cryptoDocPath} | AuthUID: ${user.uid} | Document does not exist in password_crypto collection.`
        )
      }
    } catch (err: any) {
      cryptoError = err
      const errCode = err?.code || 'UNKNOWN'
      const errMsg = err?.message || String(err)
      console.warn(
        `[FIRESTORE][CRYPTO][READ][WARN] Database: ${dbId} | Path: ${cryptoDocPath} | AuthUID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
      )
    }

    // 2. Separate Diagnostic: Reading users/{uid} (fallback for legacy records)
    let userSnap: any = null
    let userError: any = null
    try {
      console.log(
        `[FIRESTORE][USERS_FALLBACK][READ][START] Database: ${dbId} | Project: ${FIREBASE_PROJECT_ID} | Collection: ${USERS_COLLECTION} | DocId: ${user.uid} | Path: ${userDocPath} | AuthUID: ${user.uid} | Operation: getDoc`
      )
      userSnap = await getDoc(userRef)
      if (userSnap.exists()) {
        const userData = userSnap.data() as any
        const hasLegacyField = Boolean(userData && 'password_crypto' in userData && userData.password_crypto)

        // 3. Separate Diagnostic: Reading the legacy password_crypto field
        console.log(
          `[FIRESTORE][USERS_FALLBACK][LEGACY_FIELD] Database: ${dbId} | Path: ${userDocPath} | AuthUID: ${user.uid} | DocExists: true | HasLegacyPasswordField: ${hasLegacyField}`
        )

        if (hasLegacyField) {
          const legacyCrypto = userData.password_crypto as UserPasswordCryptoMetadata
          console.log(
            `[FIRESTORE][CRYPTO][MIGRATE][START] Found legacy password_crypto in ${userDocPath}. Attempting migration write to ${cryptoDocPath}...`
          )

          try {
            await setDoc(cryptoRef, legacyCrypto)
            console.log(
              `[FIRESTORE][CRYPTO][MIGRATE][SUCCESS] Successfully migrated password_crypto to ${cryptoDocPath}.`
            )

            // Verify write succeeded before attempting cleanup
            const verifySnap = await getDoc(cryptoRef)
            if (verifySnap.exists()) {
              try {
                await updateDoc(userRef, {
                  password_crypto: deleteField()
                })
                console.log(
                  `[FIRESTORE][CRYPTO][CLEANUP] Removed legacy password_crypto field from ${userDocPath}.`
                )
              } catch (cleanupErr) {
                console.warn(
                  `[FIRESTORE][CRYPTO][CLEANUP][WARN] Could not delete legacy field from ${userDocPath}:`,
                  cleanupErr
                )
              }
            }
          } catch (migrateErr) {
            console.warn(
              `[FIRESTORE][CRYPTO][MIGRATE][PENDING] Migration write to ${cryptoDocPath} pending Firestore rules update in Firebase Console:`,
              migrateErr
            )
          }

          // Legacy metadata is valid and ready to use
          const result: PasswordCryptoLookupResult = { status: 'found', metadata: legacyCrypto }
          cachedCryptoLookupUid = user.uid
          cachedCryptoLookupResult = result
          return result
        }
      } else {
        console.log(
          `[FIRESTORE][USERS_FALLBACK][READ][NOT_FOUND] Database: ${dbId} | Path: ${userDocPath} | AuthUID: ${user.uid} | User doc does not exist.`
        )
      }
    } catch (err: any) {
      userError = err
      const errCode = err?.code || 'UNKNOWN'
      const errMsg = err?.message || String(err)
      console.warn(
        `[FIRESTORE][USERS_FALLBACK][READ][WARN] Database: ${dbId} | Path: ${userDocPath} | AuthUID: ${user.uid} | Code: ${errCode} | Message: ${errMsg}`
      )
    }

    // 4. Neither collection contained readable metadata. Determine exact cause:
    const err = cryptoError || userError
    if (err) {
      const code = err.code || ''
      const msg = err.message || String(err)
      if (code === 'permission-denied' || msg.includes('permission') || msg.includes('insufficient permissions')) {
        const failedPath = cryptoError ? cryptoDocPath : userDocPath
        const failedOp = cryptoError ? `getDoc(${cryptoDocPath})` : `getDoc(${userDocPath})`
        console.error(
          `[FIRESTORE][CRYPTO][PERMISSION_DENIED] Database: ${dbId} | FailedPath: ${failedPath} | Operation: ${failedOp} | AuthUID: ${user.uid} | Code: ${code} | Message: ${msg}`
        )
        const result: PasswordCryptoLookupResult = {
          status: 'permission_denied',
          metadata: null,
          error: 'Missing or insufficient permissions reading encryption metadata. Please publish Firestore security rules in Firebase Console.'
        }
        cachedCryptoLookupUid = user.uid
        cachedCryptoLookupResult = result
        return result
      }
      if (code === 'unavailable' || msg.includes('offline') || msg.includes('client is offline')) {
        console.warn(
          `[FIRESTORE][CRYPTO][UNAVAILABLE] Database: ${dbId} | AuthUID: ${user.uid} | Message: ${msg}`
        )
        return {
          status: 'unavailable',
          metadata: null,
          error: 'Failed to access encryption metadata because the client is offline or Firestore is unavailable.'
        }
      }
      return {
        status: 'error',
        metadata: null,
        error: msg
      }
    }

    // 5. Both reads succeeded cleanly with no errors, and neither contained metadata -> Genuinely not configured
    console.log(
      `[FIRESTORE][CRYPTO][READ][NOT_FOUND] Database: ${dbId} | AuthUID: ${user.uid} | No encryption metadata found in either collection.`
    )
    const result: PasswordCryptoLookupResult = { status: 'not_found', metadata: null }
    cachedCryptoLookupUid = user.uid
    cachedCryptoLookupResult = result
    return result
  })()

  try {
    return await inFlightCryptoLookupPromise
  } finally {
    if (inFlightCryptoLookupUid === user.uid) {
      inFlightCryptoLookupUid = null
      inFlightCryptoLookupPromise = null
    }
  }
}

/**
 * Retrieves the user's E2EE password_crypto metadata from the separate password_crypto/{uid} collection.
 * Includes backward-compatible migration from legacy users/{uid} document if not yet migrated.
 */
export async function getUserPasswordCrypto(
  user: User | null,
  firestoreInstance?: Firestore
): Promise<UserPasswordCryptoMetadata | null> {
  const res = await getUserPasswordCryptoResult(user, firestoreInstance)
  return res.metadata
}

/**
 * Saves or updates password_crypto metadata in the dedicated password_crypto/{uid} collection.
 */
export async function syncUserPasswordCrypto(
  user: User | null,
  metadata: UserPasswordCryptoMetadata,
  firestoreInstance?: Firestore
): Promise<{ success: boolean; error?: string }> {
  if (!user || !user.uid) {
    return { success: false, error: 'User is not authenticated.' }
  }
  try {
    console.log(
      `[FIRESTORE][CRYPTO][WRITE][START] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Collection: password_crypto`
    )
    const db = firestoreInstance || getFirebaseFirestore()
    const cryptoRef = doc(db, PASSWORD_CRYPTO_COLLECTION, user.uid)
    await setDoc(cryptoRef, metadata)
    console.log(
      `[FIRESTORE][CRYPTO][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Successfully stored password_crypto in dedicated collection`
    )
    return { success: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(
      `[FIRESTORE][CRYPTO][WRITE][ERROR] Project: ${FIREBASE_PROJECT_ID} | UID: ${user.uid} | Failed to synchronize password_crypto:`,
      error
    )
    return { success: false, error: errMsg }
  }
}
