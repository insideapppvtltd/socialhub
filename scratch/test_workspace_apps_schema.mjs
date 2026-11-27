import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

console.log('=== SOCIAL HUB: EXCLUSIVE ws_apps SCHEMA & ONE-TIME CLEANUP TEST SUITE ===\n')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialhub-apps-exclusive-'))
const outFile = path.join(tmpDir, 'firebase-workspaces.mjs')

globalThis.localStorage = {
  _map: new Map(),
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null },
  setItem(k, v) { this._map.set(k, String(v)) },
  removeItem(k) { this._map.delete(k) },
  clear() { this._map.clear() }
}

const store = {
  workspaces: new Map(),
  updateCalls: []
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
        const store = globalThis.__APPS_STORE__;
        export const collection = (db, ...segments) => ({ path: segments.join('/') });
        export const doc = (db, ...segments) => ({ path: segments.join('/'), id: segments[segments.length - 1] });
        export const where = (field, op, val) => ({ field, op, val });
        export const query = (col, ...constraints) => ({ col, constraints });
        export const limit = (n) => ({ limit: n });
        export const serverTimestamp = () => Date.now();
        export const deleteField = () => ({ __deleteField: true });
        export const arrayUnion = (...vals) => ({ __arrayUnion: vals });
        export const arrayRemove = (...vals) => ({ __arrayRemove: vals });

        const applyUpdates = (existing, updates) => {
          const next = { ...existing };
          for (const [k, v] of Object.entries(updates)) {
            if (v && typeof v === 'object' && v.__deleteField) {
              delete next[k];
            } else {
              next[k] = JSON.parse(JSON.stringify(v));
            }
          }
          return next;
        };

        export const getDoc = async (ref) => {
          const parts = ref.path.split('/');
          const d = store.workspaces.get(parts[1]);
          return { exists: () => Boolean(d), id: parts[1], data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) };
        };

        export const setDoc = async (ref, data) => {
          const parts = ref.path.split('/');
          store.workspaces.set(parts[1], JSON.parse(JSON.stringify(data)));
        };

        export const updateDoc = async (ref, updates) => {
          const parts = ref.path.split('/');
          store.updateCalls.push({ id: parts[1], keys: Object.keys(updates) });
          const existing = store.workspaces.get(parts[1]) || {};
          store.workspaces.set(parts[1], applyUpdates(existing, updates));
        };

        export const deleteDoc = async (ref) => {
          const parts = ref.path.split('/');
          store.workspaces.delete(parts[1]);
        };

        export const runTransaction = async (db, fn) => {
          const txn = {
            get: async (ref) => getDoc(ref),
            update: (ref, updates) => {
              const parts = ref.path.split('/');
              store.updateCalls.push({ id: parts[1], keys: Object.keys(updates) });
              const existing = store.workspaces.get(parts[1]) || {};
              store.workspaces.set(parts[1], applyUpdates(existing, updates));
            }
          };
          return await fn(txn);
        };

        export const getDocs = async (target) => {
          const w = target.constraints?.find((c) => c.field);
          const docs = [];
          for (const d of store.workspaces.values()) {
            if (w?.field === 'ws_owner_id' && d.ws_owner_id === w.val) {
              docs.push({ id: d.ws_id, data: () => JSON.parse(JSON.stringify(d)) });
            } else if (w?.field === 'ws_users_ids' && Array.isArray(d.ws_users_ids) && d.ws_users_ids.includes(w.val)) {
              docs.push({ id: d.ws_id, data: () => JSON.parse(JSON.stringify(d)) });
            }
          }
          return { empty: docs.length === 0, size: docs.length, docs };
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

globalThis.__APPS_STORE__ = store

await build({
  entryPoints: [path.resolve('src/renderer/firebase-workspaces.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [mockFirestorePlugin]
})

const {
  syncWorkspaceCreation,
  syncAccountAddition,
  syncAccountUpdate,
  syncAccountRemoval,
  syncUserWorkspaces,
  syncWorkspaceOnSwitch
} = await import(pathToFileURL(outFile).href)

const user = { uid: 'uid-owner-apps-1' }

try {
  // 1. New workspace writes only ws_apps
  console.log('[TEST 1] New workspace creation writes only ws_apps')
  await syncWorkspaceCreation(user, { id: 'ws-new-1', name: 'Product' }, [], {})
  const created = store.workspaces.get('ws-new-1')
  assert.ok(Array.isArray(created.ws_apps))
  assert.strictEqual('ws_accounts' in created, false)
  console.log('  -> Passed\n')

  // 2. App addition, editing, deletion modify only ws_apps
  console.log('[TEST 2] App addition, editing, deletion modify only ws_apps')
  assert.strictEqual(
    await syncAccountAddition(user, 'ws-new-1', { id: 'app-1', name: 'Slack Team', url: 'https://app.slack.com' }, {}),
    true
  )
  assert.deepStrictEqual(store.workspaces.get('ws-new-1').ws_apps, [
    { ws_app_id: 'app-1', ws_app_name: 'Slack Team', ws_app_link: 'https://app.slack.com' }
  ])
  assert.strictEqual('ws_accounts' in store.workspaces.get('ws-new-1'), false)

  assert.strictEqual(
    await syncAccountUpdate(user, 'ws-new-1', { id: 'app-1', name: 'Slack HQ', url: 'https://slack.com' }, {}),
    true
  )
  assert.deepStrictEqual(store.workspaces.get('ws-new-1').ws_apps, [
    { ws_app_id: 'app-1', ws_app_name: 'Slack HQ', ws_app_link: 'https://slack.com' }
  ])
  assert.strictEqual('ws_accounts' in store.workspaces.get('ws-new-1'), false)

  assert.strictEqual(await syncAccountRemoval(user, 'ws-new-1', 'app-1', {}), true)
  assert.deepStrictEqual(store.workspaces.get('ws-new-1').ws_apps, [])
  assert.strictEqual('ws_accounts' in store.workspaces.get('ws-new-1'), false)
  console.log('  -> Passed\n')

  // 3. Legacy-only document is migrated to ws_apps and ws_accounts is deleted
  console.log('[TEST 3] Legacy-only document migrated without losing apps & removes ws_accounts')
  store.workspaces.set('ws-legacy-only', {
    ws_id: 'ws-legacy-only',
    ws_name: 'Legacy Only',
    ws_owner_id: user.uid,
    ws_users_ids: [user.uid],
    ws_accounts: [
      { ws_acc_id: 'legacy-1', ws_acc_name: 'WhatsApp Legacy', ws_acc_link: 'https://web.whatsapp.com' }
    ],
    ws_passwords: [],
    ws_status: 1,
    ws_at_created: 100,
    ws_at_updated: 200,
    ws_at_last_visit: 300
  })

  // 4. Document with both ws_apps and ws_accounts preserves ws_apps and deletes ws_accounts
  console.log('[TEST 4] Dual-field document preserves ws_apps and removes ws_accounts')
  store.workspaces.set('ws-dual', {
    ws_id: 'ws-dual',
    ws_name: 'Dual Field',
    ws_owner_id: user.uid,
    ws_users_ids: [user.uid],
    ws_apps: [
      { ws_app_id: 'app-keep-1', ws_app_name: 'Notion', ws_app_link: 'https://www.notion.so' }
    ],
    ws_accounts: [
      { ws_acc_id: 'app-keep-1', ws_acc_name: 'Old Name', ws_acc_link: 'https://old.notion.so' }
    ],
    ws_passwords: [],
    ws_status: 1,
    ws_at_created: 100,
    ws_at_updated: 200,
    ws_at_last_visit: 300
  })

  store.updateCalls.length = 0
  const sync1 = await syncUserWorkspaces(user, [], [], {})
  assert.strictEqual(sync1.synced, true)

  const legacyAfter = store.workspaces.get('ws-legacy-only')
  assert.strictEqual('ws_accounts' in legacyAfter, false, 'ws_accounts must be deleted from legacy-only doc')
  assert.deepStrictEqual(legacyAfter.ws_apps, [
    { ws_app_id: 'legacy-1', ws_app_name: 'WhatsApp Legacy', ws_acc_link: undefined, ws_app_link: 'https://web.whatsapp.com' }
  ].map(({ ws_app_id, ws_app_name, ws_app_link }) => ({ ws_app_id, ws_app_name, ws_app_link })))
  assert.strictEqual(legacyAfter.ws_at_updated, 200, 'Cleanup must not modify timestamps')

  const dualAfter = store.workspaces.get('ws-dual')
  assert.strictEqual('ws_accounts' in dualAfter, false, 'ws_accounts must be deleted from dual doc')
  assert.deepStrictEqual(dualAfter.ws_apps, [
    { ws_app_id: 'app-keep-1', ws_app_name: 'Notion', ws_app_link: 'https://www.notion.so' }
  ])
  assert.strictEqual(dualAfter.ws_at_updated, 200, 'Cleanup must not modify timestamps')
  console.log('  -> Passed\n')

  // 5. Repeated cleanup is idempotent and performs 0 writes
  console.log('[TEST 5] Repeated sync performs 0 redundant writes')
  store.updateCalls.length = 0
  const sync2 = await syncUserWorkspaces(user, [], [], {})
  assert.strictEqual(sync2.synced, true)
  assert.strictEqual(store.updateCalls.length, 0, 'Subsequent sync must perform zero Firestore writes')
  const switchRes = await syncWorkspaceOnSwitch(user, 'ws-dual', {})
  assert.strictEqual(switchRes.ws_apps.length, 1)
  assert.strictEqual(switchRes.ws_apps[0].ws_app_id, 'app-keep-1')
  console.log('  -> Passed\n')

  // 6. Session partition convention preserved
  console.log('[TEST 6] Partition convention persist:account-${account.id} preserved')
  const vmSrc = fs.readFileSync('src/main/view-manager.ts', 'utf8')
  assert.ok(vmSrc.includes('persist:account-${account.id}'), 'Electron session partition convention must remain intact')
  console.log('  -> Passed\n')

  console.log('=========================================================================')
  console.log('ALL EXCLUSIVE ws_apps & CLEANUP TESTS PASSED (100% PASS)')
  console.log('=========================================================================')
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
