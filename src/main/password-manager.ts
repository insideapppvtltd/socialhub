import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Workspace } from './types'
import {
  generateUserPasswordCrypto,
  unwrapUserPasswordCrypto,
  encryptCloudCredential,
  decryptCloudCredential,
  validatePasswordCryptoMetadata,
  validateCloudEncryptedRecord,
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
        updatedAt: now
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
      updatedAt: now
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
      updatedAt: Date.now()
    }

    credentials[idx] = updated
    this.store.set('credentials', credentials)
    return updated
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
  // CLOUD SYNCHRONIZATION METHODS (End-to-End Encrypted)
  // -------------------------------------------------------------
  private cloudDek: Buffer | null = null

  isCloudUnlocked(): boolean {
    return this.cloudDek !== null && this.cloudDek.length === 32
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

    if (!cleanOrigin || !trimmedPassword || !workspaceId || !accountId) {
      throw new Error('Incomplete credential data from cloud.')
    }

    const encrypted = this.encryption.encrypt(trimmedPassword)
    const credentials = [...(this.store.get('credentials') || [])]
    const now = Date.now()
    const targetId = id || randomUUID()

    const existingIndex = credentials.findIndex(
      (c) =>
        c.id === targetId ||
        (c.workspaceId === workspaceId &&
          c.accountId === accountId &&
          normalizeOrigin(c.origin) === cleanOrigin &&
          c.username.toLowerCase() === cleanUsername.toLowerCase())
    )

    if (existingIndex >= 0) {
      const existing = credentials[existingIndex]
      const updated: StoredCredentialRecord = {
        ...existing,
        id: existing.id,
        workspaceId,
        accountId,
        origin: cleanOrigin,
        username: cleanUsername,
        passwordEncrypted: encrypted,
        updatedAt: updatedAt || now
      }
      credentials[existingIndex] = updated
      this.store.set('credentials', credentials)
      return updated
    }

    const newRecord: StoredCredentialRecord = {
      id: targetId,
      workspaceId,
      accountId,
      origin: cleanOrigin,
      username: cleanUsername,
      passwordEncrypted: encrypted,
      createdAt: createdAt || now,
      updatedAt: updatedAt || now
    }

    credentials.push(newRecord)
    this.store.set('credentials', credentials)
    return newRecord
  }

  syncWorkspaceCredentialsWithCloud(
    workspaceId: string,
    remoteRecords: (FirestorePasswordRecord | CloudEncryptedCredentialRecord)[]
  ): {
    mergedRecords: FirestorePasswordRecord[]
    localUpdated: boolean
    remoteUpdated: boolean
  } {
    if (!this.cloudDek) {
      throw new Error('Password Manager must be unlocked with master password before synchronizing.')
    }

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

    // 1. Process and decrypt remote records
    for (const remote of remoteRecords || []) {
      if (!validateCloudEncryptedRecord(remote)) continue

      try {
        const decrypted = decryptCloudCredential(this.cloudDek, workspaceId, remote)

        // Convert remote record to FirestorePasswordRecord format if it was legacy
        let formattedRemote: FirestorePasswordRecord
        const rec = remote as any
        if (typeof rec.pass_value === 'string' && typeof rec.pass_link === 'string' && typeof rec.pass_name === 'string') {
          formattedRemote = rec as FirestorePasswordRecord
        } else {
          // Migrate legacy record
          const envelope = {
            encryption_version: 1,
            iv: rec.iv,
            ciphertext: rec.ciphertext,
            auth_tag: rec.auth_tag,
            updated_at: rec.updated_at || decrypted.updatedAt || Date.now()
          }
          formattedRemote = {
            credential_id: rec.credential_id,
            pass_link: decrypted.origin,
            pass_name: decrypted.username,
            pass_value: JSON.stringify(envelope)
          }
        }

        mergedMap.set(formattedRemote.credential_id, formattedRemote)

        // Extract updated_at from envelope if present
        let remoteUpdatedAt = decrypted.updatedAt || 0
        try {
          const parsedEnv = JSON.parse(formattedRemote.pass_value)
          if (parsedEnv.updated_at) remoteUpdatedAt = parsedEnv.updated_at
        } catch {}

        const local = localCredentials.find((c) => c.id === decrypted.id)
        if (!local) {
          // Missing locally -> download and store locally with safeStorage
          this.saveCredentialFromCloud(
            workspaceId,
            decrypted.accountId,
            decrypted.origin,
            decrypted.username,
            decrypted.password,
            decrypted.id,
            decrypted.createdAt,
            decrypted.updatedAt
          )
          localUpdated = true
        } else if (remoteUpdatedAt > (local.updatedAt || 0)) {
          // Cloud has newer revision -> update local
          this.saveCredentialFromCloud(
            workspaceId,
            decrypted.accountId,
            decrypted.origin,
            decrypted.username,
            decrypted.password,
            local.id,
            local.createdAt,
            remoteUpdatedAt
          )
          localUpdated = true
        }
      } catch (err) {
        console.warn(`[PASSWORDS][SYNC] Could not decrypt cloud credential ${(remote as any).credential_id}:`, err)
      }
    }

    // 2. Process local credentials to upload missing or newer ones
    const freshLocal = (this.store.get('credentials') || []).filter(
      (c) => c.workspaceId === workspaceId
    )

    for (const loc of freshLocal) {
      const existingCloud = mergedMap.get(loc.id)
      let existingUpdatedAt = 0
      if (existingCloud) {
        try {
          const parsed = JSON.parse(existingCloud.pass_value)
          existingUpdatedAt = parsed.updated_at || 0
        } catch {}
      }

      if (!existingCloud || (loc.updatedAt || 0) > existingUpdatedAt) {
        try {
          const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
          const encryptedCloud = encryptCloudCredential(this.cloudDek, workspaceId, loc, plainPass)
          mergedMap.set(loc.id, encryptedCloud)
        } catch (err) {
          console.error(`[PASSWORDS][SYNC] Failed to encrypt local credential ${loc.id} for cloud:`, err)
        }
      }
    }

    const mergedRecords = Array.from(mergedMap.values())

    // Determine whether remote Firestore document needs to be updated
    let remoteUpdated = false
    if (mergedRecords.length !== (remoteRecords || []).length) {
      remoteUpdated = true
    } else {
      const remoteMap = new Map((remoteRecords || []).map((r: any) => [r.credential_id, r]))
      for (const merged of mergedRecords) {
        const remote = remoteMap.get(merged.credential_id)
        if (
          !remote ||
          remote.pass_value !== merged.pass_value ||
          remote.pass_link !== merged.pass_link ||
          remote.pass_name !== merged.pass_name
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
    if (!this.cloudDek) return null
    const credentials = this.store.get('credentials') || []
    const loc = credentials.find((c) => c.id === credentialId)
    if (!loc) return null

    try {
      const plainPass = this.encryption.decrypt(loc.passwordEncrypted)
      return encryptCloudCredential(this.cloudDek, loc.workspaceId, loc, plainPass)
    } catch {
      return null
    }
  }
}

