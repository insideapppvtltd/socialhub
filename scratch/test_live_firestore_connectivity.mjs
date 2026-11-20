import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously } from 'firebase/auth'
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore'

console.log('=== SOCIAL HUB: LIVE FIRESTORE CONNECTIVITY & ROUND-TRIP VERIFICATION ===\n')

// Read config from .env.local
const envContent = fs.readFileSync(path.resolve('.env.local'), 'utf8')
const env = {}
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const [k, ...v] = trimmed.split('=')
  env[k.trim()] = v.join('=').trim()
}

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyCuQgFfRHGqVa16la1wLYA9xJoXloUgsTc',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'social-hub-32839.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'social-hub-32839',
  appId: env.VITE_FIREBASE_APP_ID || '1:782427575896:web:152aaee895175e192adc2d'
}
const databaseId = env.VITE_FIREBASE_DATABASE_ID || 'default'

async function runLiveVerification() {
  console.log(`[STAGE 1] Initializing Firebase App...`)
  console.log(`  -> Project ID: ${firebaseConfig.projectId}`)
  console.log(`  -> Target Database: "${databaseId}"`)
  const app = initializeApp(firebaseConfig, 'live-test-app-' + Date.now())

  console.log(`\n[STAGE 2] Testing Firebase Authentication...`)
  const auth = getAuth(app)
  const cred = await signInAnonymously(auth)
  const uid = cred.user.uid
  assert.ok(uid, 'Authentication failed to return a valid UID')
  console.log(`  -> Authenticated anonymously! UID: ${uid}`)

  console.log(`\n[STAGE 3] Initializing Cloud Firestore with Long-Polling...`)
  const db = initializeFirestore(
    app,
    {
      experimentalForceLongPolling: true
    },
    databaseId
  )
  assert.ok(db, 'Firestore instance creation failed')
  console.log(`  -> Firestore initialized with database: "${databaseId}", experimentalForceLongPolling: true`)

  console.log(`\n[STAGE 4] Live User Read Probe (users/${uid})...`)
  const userRef = doc(db, 'users', uid)
  const userSnapBefore = await getDoc(userRef)
  console.log(`  -> Initial getDoc succeeded! Exists: ${userSnapBefore.exists()}`)

  console.log(`\n[STAGE 5] Live User Write (setDoc users/${uid})...`)
  const userPayload = {
    user_id: uid,
    user_name: 'Live Test User',
    user_email: '',
    user_dp_link: '',
    user_at_created: serverTimestamp(),
    user_at_last_visit: serverTimestamp(),
    user_status: 1
  }
  await setDoc(userRef, userPayload)
  console.log(`  -> setDoc to users/${uid} completed successfully!`)

  console.log(`\n[STAGE 6] Live User Read Verification (getDoc users/${uid})...`)
  const userSnapAfter = await getDoc(userRef)
  assert.strictEqual(userSnapAfter.exists(), true, 'Expected user doc to exist after setDoc')
  const userData = userSnapAfter.data()
  assert.strictEqual(userData.user_id, uid)
  assert.strictEqual(userData.user_name, 'Live Test User')
  assert.strictEqual(userData.user_status, 1)
  console.log(`  -> Verified written user document in Cloud Firestore!`)

  console.log(`\n[STAGE 7] Live Workspace Read & Write (workspaces/ws-live-${uid})...`)
  const wsId = `ws-live-${uid}`
  const wsRef = doc(db, 'workspaces', wsId)
  const wsSnapBefore = await getDoc(wsRef)
  console.log(`  -> Existence check for non-existent workspace: exists = ${wsSnapBefore.exists()}`)
  assert.strictEqual(wsSnapBefore.exists(), false)

  const wsPayload = {
    ws_id: wsId,
    ws_owner_id: uid,
    ws_accounts: [
      {
        ws_acc_id: 'acc-whatsapp-test',
        ws_acc_name: 'WhatsApp Test',
        ws_acc_link: 'https://web.whatsapp.com'
      }
    ],
    ws_passwords: [],
    ws_status: 1,
    ws_users_ids: [uid]
  }
  await setDoc(wsRef, wsPayload)
  console.log(`  -> setDoc to workspaces/${wsId} completed successfully!`)

  const wsSnapAfter = await getDoc(wsRef)
  assert.strictEqual(wsSnapAfter.exists(), true)
  const wsData = wsSnapAfter.data()
  assert.strictEqual(wsData.ws_id, wsId)
  assert.strictEqual(wsData.ws_owner_id, uid)
  assert.strictEqual(wsData.ws_accounts.length, 1)
  assert.strictEqual(wsData.ws_accounts[0].ws_acc_name, 'WhatsApp Test')
  console.log(`  -> Verified written workspace document in Cloud Firestore!`)

  console.log(`\n[STAGE 8] Cleaning up temporary live workspace doc...`)
  await deleteDoc(wsRef)
  const wsSnapDeleted = await getDoc(wsRef)
  assert.strictEqual(wsSnapDeleted.exists(), false)
  console.log(`  -> Cleaned up temporary test workspace successfully.`)

  console.log('\n=========================================================================')
  console.log('LIVE FIRESTORE CONNECTIVITY & SYNCHRONIZATION FULLY VERIFIED (100% PASS)')
  console.log('=========================================================================\n')
}

runLiveVerification().catch((err) => {
  console.error('\nLIVE VERIFICATION FAILED:', err)
  process.exit(1)
})
