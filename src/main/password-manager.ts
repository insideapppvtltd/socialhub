import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Workspace } from './types'
import {
  generateUserPasswordCrypto,
  unwrapUserPasswordCrypto,
  decryptCloudCredential,
  validatePasswordCryptoMetadata,
  type UserPasswordCryptoMetadata,
  type CloudEncryptedCredentialRecord,
  type FirestorePasswordRecord
} from './cloud-crypto'

export interface AccountInfo {
  id: string
  name: string
  appId?: string
  workspaceId?: string
}

export interface StoredCredentialRecord {
  id: string
  workspaceId: string
  accountId: string
  origin: string
  username: string
  passwordEncrypted: string // base64 representation of safeStorage.encryptString()
  createdAt: number
  updatedAt: number
  syncedToCloud?: boolean
  pendingSync?: boolean
}

export interface CredentialSummary {
  id: string
  workspaceId: string
  workspaceName: string
  accountId: string
  accountName: string
  accountAppId?: string
  origin: string
  username: string
  createdAt: number
  updatedAt: number
}

export interface CredentialMatch {
  id: string
  username: string
  accountName: string
}

export interface EncryptionProvider {
  isAvailable(): boolean
  encrypt(plainText: string): string
  decrypt(cipherTextBase64: string): string
}

export const defaultEncryptionProvider: EncryptionProvider = {
  isAvailable: () => {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.())
    } catch {
      return false
    }
  },
  encrypt: (plainText: string) => {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Secure storage encryption is not available on this system.')
    }
    return safeStorage.encryptString(plainText).toString('base64')
  },
  decrypt: (cipherTextBase64: string) => {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Secure storage encryption is not available on this system.')
    }
    const buf = Buffer.from(cipherTextBase64, 'base64')
    return safeStorage.decryptString(buf)
  }
}

export function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin.toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
}

export class PasswordManager {
  private readonly store: Store<{ credentials: StoredCredentialRecord[] }>
  private readonly encryption: EncryptionProvider

  constructor(storeName = 'social-hub-passwords', encryptionProvider = defaultEncryptionProvider) {
    this.store = new Store<{ credentials: StoredCredentialRecord[] }>({
      name: storeName,
      defaults: { credentials: [] as StoredCredentialRecord[] }
    })
    this.encryption = encryptionProvider
  }

  saveCredential(
    workspaceId: string,
    accountId: string,
    origin: string,
    username: string,
    plainPassword: string
  ): StoredCredentialRecord {
    const cleanOrigin = normalizeOrigin(origin)
    const cleanUsername = (username || '').trim()
    const trimmedPassword = (plainPassword || '').trim()

    if (!cleanOrigin) {
      throw new Error('Invalid website origin.')
    }
    if (!trimmedPassword) {
      throw new Error('Cannot save empty password.')
    }
    if (!workspaceId) {
      throw new Error('Workspace ID is required.')
    }
    if (!accountId) {
      throw new Error('Account ID is required.')
    }

    const encrypted = this.encryption.encrypt(plainPassword)
    const credentials = [...(this.store.get('credentials') || [])]
    const now = Date.now()

    // Match existing credential in the same workspace, account, and website origin
    const existingIndex = credentials.findIndex(
      (c) =>
        c.workspaceId === workspaceId &&
        c.accountId === accountId &&
        normalizeOrigin(c.origin) === cleanOrigin &&
        (cleanUsername ? c.username.toLowerCase() === cleanUsername.toLowerCase() : true)
    )

    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated: StoredCredentialRecord = {
        ...existing,
        username: cleanUsername || existing.username,
        passwordEncrypted: encrypted,
        updatedAt: now,
        syncedToCloud: false,
        pendingSync: true
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord: StoredCredentialRecord = {
      id: randomUUID(),
      workspaceId,
      accountId,
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: now,
      updatedAt: now,
      syncedToCloud: false,
      pendingSync: true
    }

    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  reconcileWorkspaceIds(workspaces: Workspace[], accounts: AccountInfo[]): boolean {
    const credentials = this.store.get('credentials') || []
    if (credentials.length === 0) return false

    const wsIds = new Set(workspaces.map((w) => w.id))
    const accMap = new Map(accounts.map((a) => [a.id, a]))
    let modified = false

    const updated = credentials.map((c) => {
      let targetWsId = c.workspaceId

      // 1. If account is known and has a valid workspaceId, align with account
      const acc = accMap.get(c.accountId)
      if (acc && acc.workspaceId && wsIds.has(acc.workspaceId)) {
        targetWsId = acc.workspaceId
      } else if (
        !targetWsId ||
        !wsIds.has(targetWsId) ||
        targetWsId === 'workspace-default-personal' ||
        targetWsId === 'default-ws'
      ) {
        // 2. If current workspaceId is invalid/legacy and there is only 1 user workspace, assign to it
        if (workspaces.length === 1) {
          targetWsId = workspaces[0].id
        }
      }

      if (targetWsId !== c.workspaceId) {
        modified = true
        return { ...c, workspaceId: targetWsId }
      }
      return c
    })

    if (modified) {
      this.store.set('credentials', updated)
    }
    return modified
  }

  listSummaries(workspaces: Workspace[], accounts: AccountInfo[]): CredentialSummary[] {
    this.reconcileWorkspaceIds(workspaces, accounts)
    const credentials = this.store.get('credentials') || []
    const wsMap = new Map(workspaces.map((w) => [w.id, w.name]))
    const accMap = new Map(accounts.map((a) => [a.id, a]))

    return credentials.map((c) => {
      const acc = accMap.get(c.accountId)
      return {
        id: c.id,
        workspaceId: c.workspaceId,
        workspaceName: wsMap.get(c.workspaceId) || 'Workspace',
        accountId: c.accountId,
        accountName: acc?.name || 'Account',
        accountAppId: acc?.appId,
        origin: c.origin,
        username: c.username,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }
    })
  }

  getDecryptedPassword(credentialId: string, allowedWorkspaceId?: string): string {
    const credentials = this.store.get('credentials') || []
    const record = credentials.find((c) => c.id === credentialId)
    if (!record) {
      throw new Error('Credential not found.')
    }
    if (allowedWorkspaceId && record.workspaceId !== allowedWorkspaceId) {
      throw new Error('Access denied: workspace isolation violation.')
    }
    return this.encryption.decrypt(record.passwordEncrypted)
  }

  queryMatches(workspaceId: string, origin: string, accounts: AccountInfo[]): CredentialMatch[] {
    const cleanOrigin = normalizeOrigin(origin)
    const credentials = this.store.get('credentials') || []
    const accMap = new Map(accounts.map((a) => [a.id, a.name]))

    // Strict workspace isolation: ONLY return credentials matching workspaceId and origin
    const matches = credentials.filter(
      (c) => c.workspaceId === workspaceId && normalizeOrigin(c.origin) === cleanOrigin
    )

    return matches.map((m) => ({
      id: m.id,
      username: m.username,
      accountName: accMap.get(m.accountId) || 'Account'
    }))
  }

  getFillCredential(
    credentialId: string,
    workspaceId: string,
    origin: string
  ): { username: string; password: string } {
    const cleanOrigin = normalizeOrigin(origin)
    const credentials = this.store.get('credentials') || []
    const record = credentials.find((c) => c.id === credentialId)

    if (!record) {
      throw new Error('Credential not found.')
    }
    // Strict workspace isolation check
    if (record.workspaceId !== workspaceId) {
      throw new Error('Access denied: workspace isolation violation.')
    }
    // Strict origin verification
    if (normalizeOrigin(record.origin) !== cleanOrigin) {
      throw new Error('Access denied: origin mismatch.')
    }

    const password = this.encryption.decrypt(record.passwordEncrypted)
    return {
      username: record.username,
      password
    }
  }

  updateCredential(
    credentialId: string,
    username: string,
    plainPassword?: string
  ): StoredCredentialRecord {
    const credentials = [...(this.store.get('credentials') || [])]
    const idx = credentials.findIndex((c) => c.id === credentialId)
    if (idx < 0) {
      throw new Error('Credential not found.')
    }

    const existing = credentials[idx]
    let passwordEncrypted = existing.passwordEncrypted
    if (plainPassword && plainPassword.trim()) {
      passwordEncrypted = this.encryption.encrypt(plainPassword)
    }

    const updated: StoredCredentialRecord = {
      ...existing,
      username: (username ?? existing.username).trim(),
      passwordEncrypted,
      updatedAt: Date.now(),
      pendingSync: true
    }

    credentials[idx] = updated
    this.store.set('credentials', credentials)
    return updated
  }

  getCredential(credentialId: string): StoredCredentialRecord | undefined {
    const credentials = this.store.get('credentials') || []
    return credentials.find((c) => c.id === credentialId)
  }

  deleteCredential(credentialId: string): boolean {
    const credentials = this.store.get('credentials') || []
    const filtered = credentials.filter((c) => c.id !== credentialId)
    if (filtered.length !== credentials.length) {
      this.store.set('credentials', filtered)
      return true
    }
    return false
  }

  deleteForAccount(accountId: string): void {
    const credentials = this.store.get('credentials') || []
    const filtered = credentials.filter((c) => c.accountId !== accountId)
    if (filtered.length !== credentials.length) {
      this.store.set('credentials', filtered)
    }
  }

  deleteForWorkspace(workspaceId: string): void {
    const credentials = this.store.get('credentials') || []
    const filtered = credentials.filter((c) => c.workspaceId !== workspaceId)
    if (filtered.length !== credentials.length) {
      this.store.set('credentials', filtered)
    }
  }

  // -------------------------------------------------------------
  // CLOUD SYNCHRONIZATION METHODS (Plaintext Cloud Storage with Local DPAPI)
  // -------------------------------------------------------------
  private cloudDek: Buffer | null = null

  isCloudUnlocked(): boolean {
    return true
  }

  lockCloud(): void {
    if (this.cloudDek) {
      this.cloudDek.fill(0)
      this.cloudDek = null
    }
  }

  setupCloud(masterPassword: string): UserPasswordCryptoMetadata {
    const { metadata, dek } = generateUserPasswordCrypto(masterPassword)
    this.lockCloud()
    this.cloudDek = dek
    return metadata
  }

  unlockCloud(masterPassword: string, metadata: UserPasswordCryptoMetadata): boolean {
    if (!validatePasswordCryptoMetadata(metadata)) {
      throw new Error('Invalid or corrupted cloud encryption metadata.')
    }
    const dek = unwrapUserPasswordCrypto(masterPassword, metadata)
    this.lockCloud()
    this.cloudDek = dek
    return true
  }

  saveCredentialFromCloud(
    workspaceId: string,
    accountId: string,
    origin: string,
    username: string,
    plainPassword: string,
    id?: string,
    createdAt?: number,
    updatedAt?: number
  ): StoredCredentialRecord {
    const cleanOrigin = normalizeOrigin(origin)
    const cleanUsername = (username || '').trim()
    const trimmedPassword = (plainPassword || '').trim()

    if (!cleanOrigin || !trimmedPassword || !workspaceId) {
      throw new Error('Incomplete credential data from cloud.')
    }
    const cleanAccountId = accountId || 'default-acc'

    const encrypted = this.encryption.encrypt(trimmedPassword)
    const credentials = [...(this.store.get('credentials') || [])]
    const now = Date.now()
    const targetId = id || randomUUID()

    const existingIndex = credentials.findIndex(
      (c) =>
        c.id === targetId ||
        (c.workspaceId === workspaceId &&
          c.accountId === cleanAccountId &&
          normalizeOrigin(c.origin) === cleanOrigin &&
          c.username.toLowerCase() === cleanUsername.toLowerCase())
    )

    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated: StoredCredentialRecord = {
        ...existing,
        id: existing.id,
        workspaceId,
        accountId: cleanAccountId,
        origin: cleanOrigin,
        username: cleanUsername,
        passwordEncrypted: encrypted,
        updatedAt: updatedAt || now,
        syncedToCloud: true,
        pendingSync: false
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord: StoredCredentialRecord = {
      id: targetId,
      workspaceId,
      accountId: cleanAccountId,
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: createdAt || now,
      updatedAt: updatedAt || now,
      syncedToCloud: true,
      pendingSync: false
    }

    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  formatCredentialForCloud(credentialId: string): FirestorePasswordRecord | null {
    const credentials = this.store.get('credentials') || []
    const loc = credentials.find((c) => c.id === credentialId)
    if (!loc) return null

    try {
      const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
      return {
        pass_id: loc.id,
        pass_link: loc.origin,
        pass_name: loc.username,
        pass_value: plainPass
      }
    } catch {
      return null
    }
  }

  getPlaintextWorkspacePasswords(workspaceId: string): FirestorePasswordRecord[] {
    const credentials = (this.store.get('credentials') || []).filter(
      (c) => c.workspaceId === workspaceId
    )
    const records: FirestorePasswordRecord[] = []
    for (const c of credentials) {
      try {
        const plain = this.encryption.decrypt(c.passwordEncrypted)
        records.push({
          pass_id: c.id,
          pass_link: c.origin,
          pass_name: c.username,
          pass_value: plain
        })
      } catch (err) {
        console.error(`[PASSWORDS] Could not decrypt local credential ${c.id}:`, err)
      }
    }
    return records
  }

  syncWorkspaceCredentialsWithCloud(
    workspaceId: string,
    remoteRecords: (FirestorePasswordRecord | CloudEncryptedCredentialRecord | any)[]
  ): {
    mergedRecords: FirestorePasswordRecord[]
    localUpdated: boolean
    remoteUpdated: boolean
  } {
    // Automatically reconcile any orphaned or legacy workspace credentials
    const allStored = this.store.get('credentials') || []
    let storeMigrated = false
    for (const c of allStored) {
      if (
        (!c.workspaceId ||
          c.workspaceId === 'workspace-default-personal' ||
          c.workspaceId === 'default-ws') &&
        workspaceId
      ) {
        c.workspaceId = workspaceId
        storeMigrated = true
      }
    }
    if (storeMigrated) {
      this.store.set('credentials', allStored)
    }

    let localUpdated = false
    const localCredentials = (this.store.get('credentials') || []).filter(
      (c) => c.workspaceId === workspaceId
    )

    const mergedMap = new Map<string, FirestorePasswordRecord>()

    // 1. Process remote records (handle plaintext or migrate legacy encrypted)
    for (const remote of remoteRecords || []) {
      if (!remote || typeof remote !== 'object') continue

      const passId: string = remote.pass_id || remote.cred_id || remote.credential_id || remote.id || ''
      if (!passId) continue

      // Check if remote record is a legacy encrypted record
      const isLegacyEncrypted =
        remote.encryption_version === 1 ||
        Boolean(remote.iv && remote.ciphertext) ||
        (typeof remote.pass_value === 'string' &&
          (remote.pass_value.startsWith('{"iv":') ||
            remote.pass_value.startsWith('{"encryption_version":')))

      if (isLegacyEncrypted) {
        // Attempt to decrypt using local credentials or available DEK
        let decryptedPlaintext: string | null = null
        let decryptedLink: string = remote.pass_link || ''
        let decryptedName: string = remote.pass_name || ''

        // Strategy A: Match with local credential already stored on this machine
        const localMatch = localCredentials.find(
          (c) =>
            c.id === passId ||
            (normalizeOrigin(c.origin) === normalizeOrigin(remote.pass_link || '') &&
              c.username.toLowerCase() === (remote.pass_name || '').toLowerCase())
        )

        if (localMatch) {
          try {
            decryptedPlaintext = this.encryption.decrypt(localMatch.passwordEncrypted)
            decryptedLink = localMatch.origin
            decryptedName = localMatch.username
          } catch {}
        }

        // Strategy B: If cloud DEK is available, unwrap using DEK
        if (!decryptedPlaintext && this.cloudDek) {
          try {
            const dec = decryptCloudCredential(this.cloudDek, workspaceId, remote)
            decryptedPlaintext = dec.password
            decryptedLink = dec.origin
            decryptedName = dec.username

            // Also ensure saved locally
            this.saveCredentialFromCloud(
              workspaceId,
              dec.accountId || 'default-acc',
              dec.origin,
              dec.username,
              dec.password,
              dec.id,
              dec.createdAt,
              dec.updatedAt
            )
            localUpdated = true
          } catch {}
        }

        if (decryptedPlaintext !== null) {
          // Successfully migrated to plaintext
          const migrated: FirestorePasswordRecord = {
            pass_id: passId,
            pass_link: decryptedLink,
            pass_name: decryptedName,
            pass_value: decryptedPlaintext
          }
          mergedMap.set(passId, migrated)
        } else {
          // Preserve un-decryptable record as-is rather than destroying it
          console.warn(
            `[PASSWORDS][SYNC] Could not decrypt legacy remote record ${passId}; preserving record.`
          )
          mergedMap.set(passId, {
            pass_id: passId,
            pass_link: remote.pass_link || '',
            pass_name: remote.pass_name || '',
            pass_value: remote.pass_value || ''
          })
        }
      } else {
        // Record is already plaintext format
        const plaintextRec: FirestorePasswordRecord = {
          pass_id: passId,
          pass_link: typeof remote.pass_link === 'string' ? remote.pass_link : '',
          pass_name: typeof remote.pass_name === 'string' ? remote.pass_name : '',
          pass_value: typeof remote.pass_value === 'string' ? remote.pass_value : ''
        }
        mergedMap.set(passId, plaintextRec)

        // If not found locally, import to local storage with safeStorage; if found and no local pending edits, update if remote changed
        const localMatch = localCredentials.find(
          (c) =>
            c.id === passId ||
            (normalizeOrigin(c.origin) === normalizeOrigin(plaintextRec.pass_link) &&
              c.username.toLowerCase() === plaintextRec.pass_name.toLowerCase())
        )

        if (localMatch) {
          if (!localMatch.pendingSync) {
            try {
              const currentLocalPass = this.encryption.decrypt(localMatch.passwordEncrypted)
              if (
                currentLocalPass !== plaintextRec.pass_value ||
                localMatch.username !== plaintextRec.pass_name ||
                normalizeOrigin(localMatch.origin) !== normalizeOrigin(plaintextRec.pass_link)
              ) {
                this.saveCredentialFromCloud(
                  workspaceId,
                  localMatch.accountId || 'default-acc',
                  plaintextRec.pass_link,
                  plaintextRec.pass_name,
                  plaintextRec.pass_value,
                  passId
                )
                localUpdated = true
              }
            } catch {
              this.saveCredentialFromCloud(
                workspaceId,
                localMatch.accountId || 'default-acc',
                plaintextRec.pass_link,
                plaintextRec.pass_name,
                plaintextRec.pass_value,
                passId
              )
              localUpdated = true
            }
          }
        } else if (plaintextRec.pass_value && plaintextRec.pass_link) {
          try {
            this.saveCredentialFromCloud(
              workspaceId,
              'default-acc',
              plaintextRec.pass_link,
              plaintextRec.pass_name,
              plaintextRec.pass_value,
              passId
            )
            localUpdated = true
          } catch (importErr) {
            console.error(`[PASSWORDS][SYNC] Failed to import remote credential ${passId} locally:`, importErr)
          }
        }
      }
    }

    // 2. Process local credentials to ensure all local passwords exist in cloud merged set
    const freshLocal = (this.store.get('credentials') || []).filter(
      (c) => c.workspaceId === workspaceId
    )
    const remoteIdSet = new Set(
      (remoteRecords || [])
        .map((r: any) => r.pass_id || r.cred_id || r.credential_id || r.id)
        .filter(Boolean)
    )

    let allStoredUpdated = false
    const allStoredList = [...(this.store.get('credentials') || [])]

    for (const loc of freshLocal) {
      if (remoteIdSet.has(loc.id)) {
        // Credential is in remote Firestore
        if (loc.pendingSync) {
          // Local has unsaved edits: push local plaintext to mergedMap
          try {
            const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
            mergedMap.set(loc.id, {
              pass_id: loc.id,
              pass_link: loc.origin,
              pass_name: loc.username,
              pass_value: plainPass
            })
            // Clear pendingSync and mark synced
            const idx = allStoredList.findIndex((c) => c.id === loc.id)
            if (idx >= 0) {
              allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
              allStoredUpdated = true
            }
          } catch (err) {
            console.error(`[PASSWORDS][SYNC] Failed to decrypt local credential ${loc.id}:`, err)
          }
        } else {
          // Mark as confirmed syncedToCloud locally
          if (!loc.syncedToCloud) {
            const idx = allStoredList.findIndex((c) => c.id === loc.id)
            if (idx >= 0) {
              allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
              allStoredUpdated = true
            }
          }
        }
      } else {
        // Local credential is NOT in remote Firestore
        if (loc.syncedToCloud && !loc.pendingSync) {
          // It was previously confirmed in cloud, but now absent: DELETED REMOTELY!
          const idx = allStoredList.findIndex((c) => c.id === loc.id)
          if (idx >= 0) {
            allStoredList.splice(idx, 1)
            allStoredUpdated = true
            localUpdated = true
          }
          // Do NOT add to mergedMap!
        } else {
          // It is a pending local credential (e.g. newly auto-saved, created offline, or not yet synced)
          try {
            const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
            mergedMap.set(loc.id, {
              pass_id: loc.id,
              pass_link: loc.origin,
              pass_name: loc.username,
              pass_value: plainPass
            })
            const idx = allStoredList.findIndex((c) => c.id === loc.id)
            if (idx >= 0) {
              allStoredList[idx] = { ...allStoredList[idx], syncedToCloud: true, pendingSync: false }
              allStoredUpdated = true
            }
          } catch (err) {
            console.error(`[PASSWORDS][SYNC] Failed to decrypt local credential ${loc.id}:`, err)
          }
        }
      }
    }

    if (allStoredUpdated) {
      this.store.set('credentials', allStoredList)
    }

    const mergedRecords = Array.from(mergedMap.values())

    // 3. Determine whether remote Firestore document needs to be updated
    let remoteUpdated = false
    if (mergedRecords.length !== (remoteRecords || []).length) {
      remoteUpdated = true
    } else {
      const remoteMap = new Map<string, any>(
        (remoteRecords || []).map((r: any) => [r.pass_id || r.cred_id || r.credential_id || r.id, r])
      )
      for (const merged of mergedRecords) {
        const remote = remoteMap.get(merged.pass_id)
        if (
          !remote ||
          remote.pass_value !== merged.pass_value ||
          remote.pass_link !== merged.pass_link ||
          remote.pass_name !== merged.pass_name ||
          remote.pass_id === undefined || // Legacy field present -> needs schema normalization
          remote.cred_id !== undefined ||
          remote.credential_id !== undefined
        ) {
          remoteUpdated = true
          break
        }
      }
    }

    return {
      mergedRecords,
      localUpdated,
      remoteUpdated
    }
  }

  encryptCredentialForCloud(credentialId: string): FirestorePasswordRecord | null {
    return this.formatCredentialForCloud(credentialId)
  }
}

