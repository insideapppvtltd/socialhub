import { getApp, getApps, initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  signInAnonymously,
  signInWithCredential,
  signOut,
  type Auth,
  type User
} from 'firebase/auth'
import { initializeFirestore, type Firestore } from 'firebase/firestore'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyCuQgFfRHGqVa16la1wLYA9xJoXloUgsTc',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'social-hub-32839.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'social-hub-32839',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:782427575896:web:152aaee895175e192adc2d'
}

export const FIREBASE_PROJECT_ID = config.projectId
export const FIREBASE_DATABASE_ID = import.meta.env.VITE_FIREBASE_DATABASE_ID || 'default'

export function getFirebaseConfigError(): string | null {
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  return missing.length ? `Firebase setup is incomplete. Add these values to .env.local: ${missing.join(', ')}.` : null
}

export function getFirebaseAuth(): Auth {
  const configError = getFirebaseConfigError()
  if (configError) throw new Error(configError)

  const app = getApps().length ? getApp() : initializeApp(config)
  return getAuth(app)
}

let dbInstance: Firestore | null = null

export function resetFirebaseFirestoreInstance(): void {
  dbInstance = null
}

export function getFirebaseFirestore(): Firestore {
  if (dbInstance) return dbInstance
  const configError = getFirebaseConfigError()
  if (configError) throw new Error(configError)

  const app = getApps().length ? getApp() : initializeApp(config)
  const databaseId = FIREBASE_DATABASE_ID
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
  console.log(
    `[FIRESTORE][INIT] Project: ${config.projectId} | Database: ${databaseId} | LongPolling: true | NavigatorOnline: ${isOnline}`
  )
  dbInstance = initializeFirestore(
    app,
    {
      experimentalForceLongPolling: true
    },
    databaseId
  )
  return dbInstance
}

export async function loginAnonymously(): Promise<User> {
  const auth = getFirebaseAuth()
  const cred = await signInAnonymously(auth)
  return cred.user
}

export async function loginWithGoogleCredential(idToken: string): Promise<User> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Invalid Google ID token.')
  }
  const auth = getFirebaseAuth()
  const credential = GoogleAuthProvider.credential(idToken)
  const cred = await signInWithCredential(auth, credential)
  return cred.user
}

export async function loginWithGoogle(): Promise<User> {
  const idToken = await window.socialHub.getGoogleAuthToken()
  return loginWithGoogleCredential(idToken)
}

export async function logoutUser(): Promise<void> {
  const auth = getFirebaseAuth()
  await signOut(auth)
}

