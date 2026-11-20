import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Workspace } from './types'

export interface AccountInfo {
  id: string
  name: string
  appId?: string
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

  listSummaries(workspaces: Workspace[], accounts: AccountInfo[]): CredentialSummary[] {
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
}

