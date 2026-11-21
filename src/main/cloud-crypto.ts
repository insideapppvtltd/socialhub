import crypto from 'node:crypto'
import type { StoredCredentialRecord } from './password-manager'

export const CLOUD_CRYPTO_VERSION = 1
export const SCRYPT_DEFAULT_COST = 16384 // N: 2^14
export const SCRYPT_DEFAULT_BLOCK_SIZE = 8 // r
export const SCRYPT_DEFAULT_PARALLELISM = 1 // p
export const SCRYPT_KEY_LEN = 32 // 256 bits
export const AES_GCM_IV_LEN = 12 // 96 bits recommended for GCM
export const AES_GCM_TAG_LEN = 16 // 128 bits
export const DEK_LEN = 32 // 256-bit data encryption key
export const SALT_LEN = 16 // 128-bit random salt
export const WRAP_AAD = 'socialhub-dek-wrap-v1'

export interface PasswordCryptoKdf {
  name: 'scrypt'
  salt: string // base64
  cost: number // N
  blockSize: number // r
  parallelism: number // p
  keyLen: number // 32
}

export interface PasswordCryptoWrapping {
  algorithm: 'AES-256-GCM'
  iv: string // base64
  authTag: string // base64
  encryptedDek: string // base64
}

export interface UserPasswordCryptoMetadata {
  version: 1
  kdf: PasswordCryptoKdf
  wrapping: PasswordCryptoWrapping
  created_at: number
}

export interface FirestorePasswordRecord {
  credential_id: string
  pass_link: string
  pass_name: string
  pass_value: string
}

export interface CloudEncryptedCredentialRecord {
  credential_id: string
  encryption_version: 1
  iv: string // base64
  ciphertext: string // base64
  auth_tag: string // base64
  updated_at: number
}

export interface DecryptedCredentialPayload {
  id: string
  workspaceId: string
  accountId: string
  origin: string
  username: string
  password: string
  createdAt: number
  updatedAt: number
}

/**
 * Validates the structure and parameter ranges of UserPasswordCryptoMetadata.
 */
export function validatePasswordCryptoMetadata(data: unknown): data is UserPasswordCryptoMetadata {
  if (!data || typeof data !== 'object') return false
  const m = data as Partial<UserPasswordCryptoMetadata>
  if (m.version !== 1) return false
  if (!m.kdf || typeof m.kdf !== 'object') return false
  if (m.kdf.name !== 'scrypt') return false
  if (typeof m.kdf.salt !== 'string' || !m.kdf.salt.trim()) return false
  if (typeof m.kdf.cost !== 'number' || m.kdf.cost < 1024 || m.kdf.cost > 1048576) return false
  if (typeof m.kdf.blockSize !== 'number' || m.kdf.blockSize < 1 || m.kdf.blockSize > 64) return false
  if (typeof m.kdf.parallelism !== 'number' || m.kdf.parallelism < 1 || m.kdf.parallelism > 16) return false
  if (m.kdf.keyLen !== SCRYPT_KEY_LEN) return false

  if (!m.wrapping || typeof m.wrapping !== 'object') return false
  if (m.wrapping.algorithm !== 'AES-256-GCM') return false
  if (typeof m.wrapping.iv !== 'string' || !m.wrapping.iv.trim()) return false
  if (typeof m.wrapping.authTag !== 'string' || !m.wrapping.authTag.trim()) return false
  if (typeof m.wrapping.encryptedDek !== 'string' || !m.wrapping.encryptedDek.trim()) return false

  return true
}

/**
 * Validates a single cloud-encrypted credential record (supports new FirestorePasswordRecord and legacy format).
 */
export function validateCloudEncryptedRecord(
  data: unknown
): data is FirestorePasswordRecord | CloudEncryptedCredentialRecord {
  if (!data || typeof data !== 'object') return false
  const r = data as any
  if (typeof r.credential_id !== 'string' || !r.credential_id.trim()) return false

  // New format: pass_link, pass_name, pass_value
  if (typeof r.pass_value === 'string' && r.pass_value.trim()) {
    try {
      const parsed = typeof r.pass_value === 'object' ? r.pass_value : JSON.parse(r.pass_value)
      return Boolean(parsed && parsed.iv && parsed.ciphertext && parsed.auth_tag)
    } catch {
      return false
    }
  }

  // Legacy format: iv, ciphertext, auth_tag, encryption_version
  if (r.encryption_version === 1 && r.iv && r.ciphertext && r.auth_tag) {
    return true
  }

  return false
}

/**
 * Derives a 256-bit wrapping key from the master password using scrypt.
 */
export function deriveWrappingKey(masterPassword: string, kdf: PasswordCryptoKdf): Buffer {
  if (!masterPassword || typeof masterPassword !== 'string' || masterPassword.length < 6) {
    throw new Error('Master password must be at least 6 characters long.')
  }
  const salt = Buffer.from(kdf.salt, 'base64')
  if (salt.length < SALT_LEN) {
    throw new Error('Invalid salt length in encryption metadata.')
  }

  return crypto.scryptSync(masterPassword, salt, kdf.keyLen, {
    N: kdf.cost,
    r: kdf.blockSize,
    p: kdf.parallelism,
    maxmem: 64 * 1024 * 1024 // 64 MB max memory
  })
}

/**
 * Creates new cloud password metadata and generates a random 256-bit DEK.
 * Used during first-time master password setup.
 */
export function generateUserPasswordCrypto(masterPassword: string): {
  metadata: UserPasswordCryptoMetadata
  dek: Buffer
} {
  if (!masterPassword || typeof masterPassword !== 'string' || masterPassword.length < 6) {
    throw new Error('Master password must be at least 6 characters long.')
  }

  // 1. Generate random 256-bit Data Encryption Key (DEK)
  const dek = crypto.randomBytes(DEK_LEN)

  // 2. Generate random 128-bit salt for scrypt
  const salt = crypto.randomBytes(SALT_LEN)
  const kdf: PasswordCryptoKdf = {
    name: 'scrypt',
    salt: salt.toString('base64'),
    cost: SCRYPT_DEFAULT_COST,
    blockSize: SCRYPT_DEFAULT_BLOCK_SIZE,
    parallelism: SCRYPT_DEFAULT_PARALLELISM,
    keyLen: SCRYPT_KEY_LEN
  }

  // 3. Derive 256-bit wrapping key
  const wrappingKey = deriveWrappingKey(masterPassword, kdf)

  // 4. Wrap (encrypt) DEK with AES-256-GCM using wrapping key
  const iv = crypto.randomBytes(AES_GCM_IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv)
  cipher.setAAD(Buffer.from(WRAP_AAD, 'utf8'))

  const encryptedDek = Buffer.concat([cipher.update(dek), cipher.final()])
  const authTag = cipher.getAuthTag()

  const metadata: UserPasswordCryptoMetadata = {
    version: 1,
    kdf,
    wrapping: {
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encryptedDek: encryptedDek.toString('base64')
    },
    created_at: Date.now()
  }

  return { metadata, dek }
}

/**
 * Unwraps the Data Encryption Key (DEK) using the master password and stored metadata.
 * Throws an Error if the master password is wrong or ciphertext/tag has been tampered with.
 */
export function unwrapUserPasswordCrypto(
  masterPassword: string,
  metadata: UserPasswordCryptoMetadata
): Buffer {
  if (!validatePasswordCryptoMetadata(metadata)) {
    throw new Error('Invalid or unsupported encryption metadata.')
  }

  const wrappingKey = deriveWrappingKey(masterPassword, metadata.kdf)
  const iv = Buffer.from(metadata.wrapping.iv, 'base64')
  const authTag = Buffer.from(metadata.wrapping.authTag, 'base64')
  const encryptedDek = Buffer.from(metadata.wrapping.encryptedDek, 'base64')

  if (iv.length !== AES_GCM_IV_LEN || authTag.length !== AES_GCM_TAG_LEN || encryptedDek.length !== DEK_LEN) {
    throw new Error('Corrupted or tampered encryption wrapping parameters.')
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv)
    decipher.setAAD(Buffer.from(WRAP_AAD, 'utf8'))
    decipher.setAuthTag(authTag)

    const dek = Buffer.concat([decipher.update(encryptedDek), decipher.final()])
    if (dek.length !== DEK_LEN) {
      throw new Error('Unwrapped key has invalid length.')
    }
    return dek
  } catch (error) {
    throw new Error('Incorrect master password or corrupted encryption key.')
  }
}

/**
 * Builds Authenticated Additional Data (AAD) for credential encryption.
 * Strictly binds ciphertext to workspaceId and credentialId to prevent cross-workspace relocation attacks.
 */
export function buildCredentialAad(workspaceId: string, credentialId: string): Buffer {
  return Buffer.from(`${workspaceId}:${credentialId}:v1`, 'utf8')
}

/**
 * Encrypts a credential record into a FirestorePasswordRecord using AES-256-GCM and DEK.
 * The encryption envelope (ciphertext, nonce, auth tag, version, timestamp) is encapsulated inside pass_value.
 */
export function encryptCloudCredential(
  dek: Buffer,
  workspaceId: string,
  record: StoredCredentialRecord,
  plainPassword: string
): FirestorePasswordRecord {
  if (!dek || dek.length !== DEK_LEN) {
    throw new Error('Valid 256-bit Data Encryption Key is required for cloud encryption.')
  }
  if (!workspaceId || record.workspaceId !== workspaceId) {
    throw new Error('Workspace ID mismatch during credential encryption.')
  }

  const payload: DecryptedCredentialPayload = {
    id: record.id,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    origin: record.origin,
    username: record.username,
    password: plainPassword,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }

  const payloadJson = JSON.stringify(payload)
  const iv = crypto.randomBytes(AES_GCM_IV_LEN)
  const aad = buildCredentialAad(workspaceId, record.id)

  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  cipher.setAAD(aad)

  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payloadJson, 'utf8')), cipher.final()])
  const authTag = cipher.getAuthTag()

  const envelope = {
    encryption_version: 1,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    auth_tag: authTag.toString('base64'),
    updated_at: record.updatedAt || Date.now()
  }

  return {
    credential_id: record.id,
    pass_link: record.origin,
    pass_name: record.username,
    pass_value: JSON.stringify(envelope)
  }
}

/**
 * Decrypts a FirestorePasswordRecord (or legacy CloudEncryptedCredentialRecord) using AES-256-GCM and DEK.
 * Strictly verifies authentication tag and AAD matching workspaceId.
 */
export function decryptCloudCredential(
  dek: Buffer,
  workspaceId: string,
  cloudRecord: FirestorePasswordRecord | CloudEncryptedCredentialRecord | any
): DecryptedCredentialPayload {
  if (!dek || dek.length !== DEK_LEN) {
    throw new Error('Valid 256-bit Data Encryption Key is required for cloud decryption.')
  }
  if (!validateCloudEncryptedRecord(cloudRecord)) {
    throw new Error('Invalid cloud encrypted credential record format.')
  }

  let ivStr: string
  let authTagStr: string
  let ciphertextStr: string

  if ('pass_value' in cloudRecord && cloudRecord.pass_value) {
    let env: any
    if (typeof cloudRecord.pass_value === 'string') {
      try {
        env = JSON.parse(cloudRecord.pass_value)
      } catch {
        env = JSON.parse(Buffer.from(cloudRecord.pass_value, 'base64').toString('utf8'))
      }
    } else {
      env = cloudRecord.pass_value
    }
    ivStr = env.iv
    authTagStr = env.auth_tag || env.authTag
    ciphertextStr = env.ciphertext
  } else if ('iv' in cloudRecord) {
    // Backward compatibility with legacy format
    ivStr = cloudRecord.iv
    authTagStr = cloudRecord.auth_tag
    ciphertextStr = cloudRecord.ciphertext
  } else {
    throw new Error('Invalid cloud encrypted credential record format.')
  }

  const iv = Buffer.from(ivStr, 'base64')
  const authTag = Buffer.from(authTagStr, 'base64')
  const ciphertext = Buffer.from(ciphertextStr, 'base64')

  if (iv.length !== AES_GCM_IV_LEN || authTag.length !== AES_GCM_TAG_LEN) {
    throw new Error('Invalid nonce or authentication tag size.')
  }

  const aad = buildCredentialAad(workspaceId, cloudRecord.credential_id)

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv)
    decipher.setAAD(aad)
    decipher.setAuthTag(authTag)

    const decryptedBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = JSON.parse(decryptedBuf.toString('utf8')) as DecryptedCredentialPayload

    // Validate payload consistency
    if (!payload.id || payload.id !== cloudRecord.credential_id) {
      throw new Error('Credential ID tampering detected.')
    }
    if (!payload.workspaceId || payload.workspaceId !== workspaceId) {
      throw new Error('Cross-workspace credential tampering detected.')
    }

    return payload
  } catch (error) {
    throw new Error(
      `Failed to decrypt cloud credential ${cloudRecord.credential_id}: Authentication failed or payload tampered.`
    )
  }
}
