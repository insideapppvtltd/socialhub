import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, signOut, type Auth, type User } from 'firebase/auth'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyCuQgFfRHGqVa16la1wLYA9xJoXloUgsTc',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'social-hub-32839.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'social-hub-32839',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:782427575896:web:152aaee895175e192adc2d'
}

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

export async function loginAnonymously(): Promise<User> {
  const auth = getFirebaseAuth()
  const cred = await signInAnonymously(auth)
  return cred.user
}

export async function logoutUser(): Promise<void> {
  const auth = getFirebaseAuth()
  await signOut(auth)
}
