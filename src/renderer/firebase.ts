import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? ''
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
