import { doc, getDoc, setDoc, updateDoc, serverTimestamp, type Firestore } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import { getFirebaseFirestore, FIREBASE_PROJECT_ID } from './firebase'

export const USERS_COLLECTION = 'users'

export interface FirestoreUserDocument {
  user_id: string
  user_name: string
  user_email: string
  user_dp_link: string
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
          user_at_created: serverTimestamp(),
          user_at_last_visit: serverTimestamp(),
          user_status: 1
        }
        await setDoc(userRef, newDoc)
        lastSyncedUid = user.uid
        lastSyncTimestamp = Date.now()
        console.log(
          `[FIRESTORE][USERS][WRITE][SUCCESS] Project: ${FIREBASE_PROJECT_ID} | Operation: create | Doc: users/${user.uid}`
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
          user_at_last_visit: serverTimestamp()
        }

        // Initialize user_status if missing; do not overwrite existing status unnecessarily
        if (existing?.user_status === undefined || existing?.user_status === null) {
          updates.user_status = 1
        }

        // Important: user_at_created is omitted so it is NEVER overwritten
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
