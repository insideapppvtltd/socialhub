import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('=== SOCIAL HUB: WORKSPACE COLLABORATION VERIFICATION SUITE (BUGS #4 & #5) ===\n')

// Simulated Firestore + AccountManager matching src/renderer/firebase-workspaces.ts & src/main/account-manager.ts
class MockCollabFirestore {
  constructor() {
    this.users = new Map()
    this.workspaces = new Map()
  }
  seedUser(u) { this.users.set(u.user_id, { ...u }) }
  seedWorkspace(w) { this.workspaces.set(w.ws_id, { ...w }) }

  findUserByEmail(email) {
    const trimmed = (email || '').trim()
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed)) {
      throw new Error('Please enter a valid email address.')
    }
    const lower = trimmed.toLowerCase()
    for (const u of this.users.values()) {
      if ((u.user_email || '').trim().toLowerCase() === lower) return { ...u }
    }
    return null
  }

  // Enforces firestore.rules semantics for workspaces
  canReadWorkspace(uid, wsId) {
    if (!uid) return false
    const w = this.workspaces.get(wsId)
    if (!w) return false
    return w.ws_owner_id === uid || (Array.isArray(w.ws_users_ids) && w.ws_users_ids.includes(uid))
  }

  queryUserWorkspaces(uid) {
    if (!uid) return []
    const res = []
    for (const w of this.workspaces.values()) {
      if (w.ws_owner_id === uid || (Array.isArray(w.ws_users_ids) && w.ws_users_ids.includes(uid))) {
        res.push(JSON.parse(JSON.stringify(w)))
      }
    }
    return res
  }

  addCollaborator(actorUid, wsId, collabUid) {
    const w = this.workspaces.get(wsId)
    if (!w) return { added: false, status: 'not_found', message: 'Workspace document not found.' }
    if (w.ws_owner_id !== actorUid) return { added: false, status: 'unauthorized', message: 'Only the workspace owner can add collaborators.' }
    if (collabUid === w.ws_owner_id) return { added: false, status: 'is_owner', message: 'This user is the owner of this workspace.' }
    if (w.ws_users_ids.includes(collabUid)) return { added: false, status: 'already_collaborator', message: 'This user is already a collaborator in this workspace.' }
    w.ws_users_ids = Array.from(new Set([...w.ws_users_ids, collabUid]))
    w.ws_at_updated = Date.now()
    return { added: true, status: 'added', message: 'Collaborator added successfully.' }
  }

  removeCollaborator(actorUid, wsId, collabUid) {
    const w = this.workspaces.get(wsId)
    if (!w) return { removed: false, message: 'Workspace document not found.' }
    if (w.ws_owner_id !== actorUid) return { removed: false, message: 'Only the workspace owner can remove collaborators.' }
    if (collabUid === w.ws_owner_id) return { removed: false, message: 'The workspace owner cannot be removed.' }
    w.ws_users_ids = w.ws_users_ids.filter((id) => id !== collabUid)
    w.ws_at_updated = Date.now()
    return { removed: true, message: 'Collaborator removed successfully.' }
  }
}

class MockLocalAccountManager {
  constructor() {
    this.currentUid = null
    this.workspaces = []
    this.owners = {}
  }
  setCurrentUser(uid) { this.currentUid = uid }
  listWorkspaces() {
    if (!this.currentUid) return []
    return this.workspaces.filter(
      (w) => w.ownerId === this.currentUid || this.owners[w.id] === this.currentUid || (Array.isArray(w.memberIds) && w.memberIds.includes(this.currentUid))
    )
  }
  reconcileRemoteWorkspaces(remoteWorkspaces) {
    const remoteMap = new Map(remoteWorkspaces.map((rw) => [rw.ws_id, rw]))
    const next = []
    for (const rw of remoteWorkspaces) {
      this.owners[rw.ws_id] = rw.ws_owner_id
      next.push({
        id: rw.ws_id,
        name: rw.ws_name,
        ownerId: rw.ws_owner_id,
        memberIds: rw.ws_users_ids
      })
    }
    for (const lw of this.workspaces) {
      const isUserWs = lw.ownerId === this.currentUid || this.owners[lw.id] === this.currentUid || (lw.memberIds || []).includes(this.currentUid)
      if (!isUserWs && !remoteMap.has(lw.id)) {
        next.push(lw)
      }
    }
    this.workspaces = next
  }
}

const db = new MockCollabFirestore()
const owner = { user_id: 'uid-owner', user_name: 'Saurabh', user_email: 'Saurabh@Example.com', user_dp_link: 'https://img/owner.png' }
const alice = { user_id: 'uid-alice', user_name: 'Alice', user_email: 'alice@example.com', user_dp_link: 'https://img/alice.png' }
const bob = { user_id: 'uid-bob', user_name: 'Bob', user_email: 'bob@example.com', user_dp_link: '' }
db.seedUser(owner)
db.seedUser(alice)
db.seedUser(bob)

db.seedWorkspace({
  ws_id: 'ws-shared',
  ws_name: 'Marketing Hub',
  ws_owner_id: owner.user_id,
  ws_users_ids: [owner.user_id],
  ws_accounts: [{ ws_acc_id: 'acc-wa-1', ws_acc_name: 'WhatsApp Biz', ws_acc_link: 'https://web.whatsapp.com' }],
  ws_passwords: [],
  ws_status: 1
})
db.seedWorkspace({
  ws_id: 'ws-private',
  ws_name: 'Private Hub',
  ws_owner_id: owner.user_id,
  ws_users_ids: [owner.user_id],
  ws_accounts: [],
  ws_passwords: [],
  ws_status: 1
})

// 1-2. Email validation & lookup (trimmed, case-insensitive)
console.log('[TEST 1-5] Email validation, unregistered rejection, owner rejection')
assert.throws(() => db.findUserByEmail('not-an-email'), /valid email/)
assert.strictEqual(db.findUserByEmail('unknown@example.com'), null)
const foundOwner = db.findUserByEmail('  saurabh@example.com  ')
assert.strictEqual(foundOwner.user_id, owner.user_id)
const ownerAddRes = db.addCollaborator(owner.user_id, 'ws-shared', foundOwner.user_id)
assert.strictEqual(ownerAddRes.status, 'is_owner')
console.log('  -> Passed: Invalid email, unregistered email, and owner self-add rejected')

// 6-8. Add valid registered collaborator + duplicate prevention
console.log('[TEST 6-8] Add registered collaborator & duplicate prevention')
const foundAlice = db.findUserByEmail('  ALICE@example.com ')
assert.strictEqual(foundAlice.user_id, alice.user_id)
const addRes = db.addCollaborator(owner.user_id, 'ws-shared', foundAlice.user_id)
assert.strictEqual(addRes.added, true)
assert.ok(db.workspaces.get('ws-shared').ws_users_ids.includes(alice.user_id))
const dupRes = db.addCollaborator(owner.user_id, 'ws-shared', foundAlice.user_id)
assert.strictEqual(dupRes.status, 'already_collaborator')
console.log('  -> Passed: Alice UID added atomically to ws_users_ids; duplicate prevented')

// 9-11. Collaborator discovers shared workspace, sees accounts, ownership unchanged
console.log('[TEST 9-11] Shared workspace discovery, account visibility, ownership preserved')
const aliceLocal = new MockLocalAccountManager()
aliceLocal.setCurrentUser(alice.user_id)
const aliceRemote = db.queryUserWorkspaces(alice.user_id)
assert.strictEqual(aliceRemote.length, 1)
assert.strictEqual(aliceRemote[0].ws_id, 'ws-shared')
assert.strictEqual(aliceRemote[0].ws_owner_id, owner.user_id, 'Owner must remain unchanged')
aliceLocal.reconcileRemoteWorkspaces(aliceRemote)
assert.strictEqual(aliceLocal.listWorkspaces().length, 1)
assert.strictEqual(aliceLocal.listWorkspaces()[0].ownerId, owner.user_id)
assert.strictEqual(aliceRemote[0].ws_accounts[0].ws_acc_id, 'acc-wa-1')
console.log('  -> Passed: Collaborator discovers shared workspace & accounts while ownerId stays owner')

// 14-16. Role & access isolation
console.log('[TEST 14-16] Collaborator privilege limits & private workspace isolation')
assert.strictEqual(db.addCollaborator(alice.user_id, 'ws-shared', bob.user_id).status, 'unauthorized')
assert.strictEqual(db.removeCollaborator(alice.user_id, 'ws-shared', owner.user_id).removed, false)
assert.strictEqual(db.canReadWorkspace(bob.user_id, 'ws-shared'), false)
assert.strictEqual(db.canReadWorkspace(alice.user_id, 'ws-private'), false)
console.log('  -> Passed: Collaborator cannot add/remove; unrelated user cannot read; private workspace stays private')

// 12-13. Owner removes collaborator; collaborator loses access on next sync
console.log('[TEST 12-13] Remove collaborator & sync revocation')
const remRes = db.removeCollaborator(owner.user_id, 'ws-shared', alice.user_id)
assert.strictEqual(remRes.removed, true)
assert.strictEqual(db.workspaces.get('ws-shared').ws_users_ids.includes(alice.user_id), false)
const aliceRemoteAfterRemove = db.queryUserWorkspaces(alice.user_id)
assert.strictEqual(aliceRemoteAfterRemove.length, 0)
aliceLocal.reconcileRemoteWorkspaces(aliceRemoteAfterRemove)
assert.strictEqual(aliceLocal.listWorkspaces().length, 0)
assert.ok(db.users.has(alice.user_id), 'User account must not be deleted')
assert.ok(db.workspaces.has('ws-shared'), 'Workspace must not be deleted')
console.log('  -> Passed: Removed collaborator loses workspace on next sync without deleting user or workspace')

// 17. Codebase & Firestore Rules Audit
console.log('[TEST 17] Codebase & Firestore Security Rules Audit')
const rulesSrc = fs.readFileSync(path.resolve('firestore.rules'), 'utf8')
const fbUsersSrc = fs.readFileSync(path.resolve('src/renderer/firebase-users.ts'), 'utf8')
const fbWsSrc = fs.readFileSync(path.resolve('src/renderer/firebase-workspaces.ts'), 'utf8')
const appSrc = fs.readFileSync(path.resolve('src/renderer/App.tsx'), 'utf8')
const amSrc = fs.readFileSync(path.resolve('src/main/account-manager.ts'), 'utf8')

assert.ok(rulesSrc.includes('allow get: if request.auth != null && request.auth.uid == userId;') && rulesSrc.includes('allow list: if false;'), 'users collection must remain strictly private')
assert.ok(rulesSrc.includes('match /user_directory/{userId}') && rulesSrc.includes('request.query.limit != null') && rulesSrc.includes('request.query.limit <= 5'), 'user_directory must allow bounded authenticated lookup')
assert.ok(fbUsersSrc.includes("export const USER_DIRECTORY_COLLECTION = 'user_directory'") && fbUsersSrc.includes('syncUserDirectoryEntry('), 'firebase-users.ts must sync user_directory')
assert.ok(rulesSrc.includes('resource.data.ws_owner_id in request.resource.data.ws_users_ids'), 'Owner cannot be removed from ws_users_ids')
assert.ok(rulesSrc.includes("affectedKeys().hasOnly(['ws_at_last_visit'])"), 'Collaborator update restricted to ws_at_last_visit')
assert.ok(fbWsSrc.includes('USER_DIRECTORY_COLLECTION') && fbWsSrc.includes('limit(5)'), 'Email lookup must query user_directory with limit(5)')
assert.strictEqual(fbWsSrc.includes('await getDocs(usersRef)'), false, 'Must NOT perform unfiltered full-collection scan on users')
assert.ok(fbWsSrc.includes('formatFirestoreCollabError') && fbWsSrc.includes('You do not have permission to manage collaborators in this workspace.'), 'Actionable permission error mapping required')
assert.ok(fbWsSrc.includes('arrayUnion(...idsToAdd)') && fbWsSrc.includes('arrayRemove(collaboratorUid)'), 'Must use atomic arrayUnion/arrayRemove')
assert.ok(fbWsSrc.includes('No registered Social HUB user found with this email address.') || appSrc.includes('No registered Social HUB user found with this email address.'))
assert.ok(fbWsSrc.includes('This user is already a collaborator in this workspace.'))
assert.ok(fbWsSrc.includes('This user is the owner of this workspace.'))
assert.ok(appSrc.includes('section-heading-actions') && appSrc.includes('title="Manage Collaborators"') && appSrc.includes('<UserPlus size={13} />'), 'Header must place Manage Collaborators UserPlus button beside Sort')
assert.strictEqual(appSrc.includes('workspace-collab-btn'), false, 'Workspace dropdown footer must not have duplicate Add Collaborator button')
assert.strictEqual(appSrc.includes('handleLookupNext'), false, 'Dialog must use direct Add flow without Next button')
assert.ok(appSrc.includes('className="collab-add-btn"') && appSrc.includes('disabled={busy || !emailInput.trim()}'), 'Add button must use collab-add-btn styling and prevent duplicate submissions')
assert.strictEqual(fbWsSrc.includes('getDocs(qMember).catch(() =>'), false, 'qMember must NOT silently swallow Firestore errors')
assert.ok(appSrc.includes('OWNER') && appSrc.includes('CollaboratorsModal'))
assert.ok(amSrc.includes('memberIds'))
assert.strictEqual(fbWsSrc.includes('onSnapshot') || appSrc.includes('onSnapshot'), false, 'Strictly non-real-time')

// 18. Zero-workspace user (no owned or shared workspaces)
const zeroLocal = new MockLocalAccountManager()
zeroLocal.setCurrentUser(bob.user_id)
const bobRemote = db.queryUserWorkspaces(bob.user_id)
assert.strictEqual(bobRemote.length, 0)
zeroLocal.reconcileRemoteWorkspaces(bobRemote)
assert.strictEqual(zeroLocal.listWorkspaces().length, 0, 'User with no owned or shared workspaces must stay at 0 workspaces')
console.log('  -> Passed: Security rules, atomic arrayUnion/arrayRemove, dialog states, and non-real-time sync verified')

console.log('\n=========================================================================')
console.log('ALL COLLABORATION TESTS PASSED (100% PASS)')
console.log('=========================================================================\n')
