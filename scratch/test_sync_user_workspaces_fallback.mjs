import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

console.log('=== SOCIAL HUB: syncUserWorkspaces GRACEFUL MEMBER-QUERY FALLBACK TEST ===\n')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialhub-sync-test-'))
const outFile = path.join(tmpDir, 'firebase-workspaces.mjs')

// Minimal localStorage polyfill for node
globalThis.localStorage = {
  _map: new Map(),
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null },
  setItem(k, v) { this._map.set(k, String(v)) },
  removeItem(k) { this._map.delete(k) },
  clear() { this._map.clear() }
}

// Configurable mock Firestore state
const mockState = {
  ownerDocs: [],
  memberDocs: [],
  ownerError: null,
  memberError: null,
  updatedDocs: []
}

const mockFirestorePlugin = {
  name: 'mock-firebase',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^firebase\/firestore$/ }, () => ({
      path: 'firebase/firestore',
      namespace: 'mock-firestore'
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'mock-firestore' }, () => ({
      contents: `
        const state = globalThis.__MOCK_FIRESTORE_STATE__;
        export const collection = (db, name) => ({ db, name });
        export const doc = (db, name, id) => ({ db, name, id });
        export const where = (field, op, val) => ({ field, op, val });
        export const query = (col, ...constraints) => ({ col, constraints });
        export const limit = (n) => ({ limit: n });
        export const serverTimestamp = () => ({ __serverTimestamp: true });
        export const deleteField = () => ({ __deleteField: true });
        export const arrayUnion = (...vals) => ({ __arrayUnion: vals });
        export const arrayRemove = (...vals) => ({ __arrayRemove: vals });
        export const getDoc = async () => ({ exists: () => false, data: () => ({}) });
        export const setDoc = async () => {};
        export const deleteDoc = async () => {};
        export const runTransaction = async () => {};
        export const updateDoc = async (ref, updates) => {
          state.updatedDocs.push({ id: ref.id, updates });
        };
        export const getDocs = async (q) => {
          const w = q.constraints.find((c) => c.field);
          if (w?.field === 'ws_owner_id') {
            if (state.ownerError) throw state.ownerError;
            return {
              empty: state.ownerDocs.length === 0,
              size: state.ownerDocs.length,
              docs: state.ownerDocs.map((d) => ({ id: d.ws_id, data: () => ({ ...d }) }))
            };
          }
          if (w?.field === 'ws_users_ids') {
            if (state.memberError) throw state.memberError;
            return {
              empty: state.memberDocs.length === 0,
              size: state.memberDocs.length,
              docs: state.memberDocs.map((d) => ({ id: d.ws_id, data: () => ({ ...d }) }))
            };
          }
          return { empty: true, size: 0, docs: [] };
        };
      `,
      loader: 'js'
    }))
    pluginBuild.onResolve({ filter: /^\.\/firebase$/ }, () => ({
      path: './firebase',
      namespace: 'mock-firebase-init'
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'mock-firebase-init' }, () => ({
      contents: `
        export const FIREBASE_PROJECT_ID = 'social-hub-32839';
        export const getFirebaseFirestore = () => ({});
      `,
      loader: 'js'
    }))
  }
}

globalThis.__MOCK_FIRESTORE_STATE__ = mockState

await build({
  entryPoints: [path.resolve('src/renderer/firebase-workspaces.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [mockFirestorePlugin]
})

const { syncUserWorkspaces } = await import(pathToFileURL(outFile).href)

const fakeUser = { uid: 'owner-uid-123' }
const ownedWs = {
  ws_id: 'ws-owned-1',
  ws_name: 'Owned Workspace',
  ws_owner_id: 'owner-uid-123',
  ws_users_ids: ['owner-uid-123'],
  ws_accounts: [],
  ws_passwords: [],
  ws_at_created: 1,
  ws_at_updated: 1,
  ws_at_last_visit: 1
}
const sharedWs = {
  ws_id: 'ws-shared-2',
  ws_name: 'Shared Workspace',
  ws_owner_id: 'other-owner-999',
  ws_users_ids: ['other-owner-999', 'owner-uid-123'],
  ws_accounts: [],
  ws_passwords: [],
  ws_at_created: 1,
  ws_at_updated: 1,
  ws_at_last_visit: 1
}

// Capture console.error to verify diagnostic logging
const capturedErrors = []
const origConsoleError = console.error
console.error = (...args) => {
  capturedErrors.push(args.join(' '))
  origConsoleError(...args)
}

try {
  // Case 1: Owner query succeeds, member query fails with permission-denied
  console.log('[CASE 1] Owner query succeeds, member query fails (permission-denied)')
  mockState.ownerDocs = [ownedWs]
  mockState.memberDocs = []
  mockState.ownerError = null
  mockState.memberError = Object.assign(new Error('Missing or insufficient permissions.'), {
    code: 'permission-denied'
  })
  capturedErrors.length = 0

  const res1 = await syncUserWorkspaces(fakeUser, [], [], {})
  assert.strictEqual(res1.synced, true, 'Owner sync must still succeed when member query fails')
  assert.strictEqual(res1.remoteWorkspaces.length, 1, 'Owner workspace must still be returned')
  assert.strictEqual(res1.remoteWorkspaces[0].ws_id, 'ws-owned-1')
  assert.strictEqual(res1.memberQueryFailed, true, 'Result must report memberQueryFailed=true')
  assert.strictEqual(res1.memberQueryError?.code, 'permission-denied')
  assert.ok(
    capturedErrors.some((msg) => msg.includes('[FIRESTORE][WORKSPACES][QUERY_MEMBER][ERROR]') && msg.includes('permission-denied')),
    'Must log member query failure with Firebase error code and message'
  )
  console.log('  -> Passed: Owner workspaces preserved and member-query failure logged & reported\n')

  // Case 2: Both owner and member queries succeed
  console.log('[CASE 2] Both owner and member queries succeed')
  mockState.ownerDocs = [ownedWs]
  mockState.memberDocs = [ownedWs, sharedWs]
  mockState.ownerError = null
  mockState.memberError = null
  capturedErrors.length = 0

  const res2 = await syncUserWorkspaces(fakeUser, [], [], {})
  assert.strictEqual(res2.synced, true)
  assert.strictEqual(res2.memberQueryFailed, undefined)
  assert.strictEqual(res2.remoteWorkspaces.length, 2, 'Both owned and shared workspaces must be discovered without duplicates')
  assert.deepStrictEqual(
    res2.remoteWorkspaces.map((w) => w.ws_id).sort(),
    ['ws-owned-1', 'ws-shared-2']
  )
  console.log('  -> Passed: Owner and collaborator workspaces both synchronized\n')

  // Case 3: Owner query fails
  console.log('[CASE 3] Owner query fails')
  mockState.ownerDocs = []
  mockState.memberDocs = []
  mockState.ownerError = Object.assign(new Error('Missing or insufficient permissions.'), {
    code: 'permission-denied'
  })
  mockState.memberError = null
  capturedErrors.length = 0

  const res3 = await syncUserWorkspaces(fakeUser, [], [], {})
  assert.strictEqual(res3.synced, false, 'Sync must fail when owner query fails')
  assert.deepStrictEqual(res3.remoteWorkspaces, [])
  assert.ok(
    capturedErrors.some((msg) => msg.includes('[FIRESTORE][WORKSPACES][ERROR]') && msg.includes('permission-denied')),
    'Owner query failure must be logged'
  )
  console.log('  -> Passed: Owner query failure properly reported\n')

  console.log('=========================================================================')
  console.log('ALL syncUserWorkspaces GRACEFUL FALLBACK TESTS PASSED (100% PASS)')
  console.log('=========================================================================')
} finally {
  console.error = origConsoleError
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
