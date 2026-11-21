import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  AlertCircle,
  Check,
  CloudOff,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type { User } from 'firebase/auth'
import type { Workspace } from '../main/types'
import type { CredentialSummary } from '../preload'
import { syncWorkspacePasswords, WORKSPACES_COLLECTION, type FirestoreWorkspaceDocument } from './firebase-workspaces'
import { getFirebaseFirestore } from './firebase'
import { doc, getDoc } from 'firebase/firestore'

interface PasswordManagerProps {
  user: User | null
  workspaces: Workspace[]
  onClose: () => void
  showToast: (message: string) => void
}

type CloudSyncState = 'local' | 'syncing' | 'synced' | 'failed'
type WorkspaceSyncState = 'local' | 'syncing' | 'synced' | 'failed'

export function PasswordManager({ user, workspaces, onClose, showToast }: PasswordManagerProps) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [editingCred, setEditingCred] = useState<CredentialSummary | null>(null)
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [showEditPassword, setShowEditPassword] = useState(false)
  const [copiedField, setCopiedField] = useState<{ id: string; field: 'username' | 'password' } | null>(null)

  // Cloud Sync state: 'local' | 'syncing' | 'synced' | 'failed'
  const [cloudStatus, setCloudStatus] = useState<CloudSyncState>(user ? 'syncing' : 'local')
  const [syncError, setSyncError] = useState<string | null>(null)

  // Workspace-level synchronization states
  const [workspaceSyncStatuses, setWorkspaceSyncStatuses] = useState<Record<string, WorkspaceSyncState>>({})
  const [workspaceSyncErrors, setWorkspaceSyncErrors] = useState<Record<string, string>>({})

  // Synchronization lifecycle guards and stable references
  const isSyncingRef = useRef(false)
  const syncedWorkspacesRef = useRef<Set<string>>(new Set())

  const workspacesRef = useRef<Workspace[]>(workspaces)
  workspacesRef.current = workspaces

  const loadCredentials = useCallback(async () => {
    try {
      setLoadError(null)
      const list = await window.socialHub.listCredentials()
      setCredentials(Array.isArray(list) ? list : [])
    } catch (error) {
      console.error('[PASSWORDS] Failed to load credentials:', error)
      const msg = error instanceof Error ? error.message : 'Could not load credentials.'
      setLoadError(msg)
      showToast(msg)
      setCredentials([])
    } finally {
      setLoading(false)
    }
  }, [showToast])

  // Check whether all existing workspaces have been successfully synced
  // Synchronize credentials across authorized workspaces
  const runCloudSync = useCallback(
    async (force = false, targetWorkspaceId?: string) => {
      if (!user || !user.uid) {
        setCloudStatus('local')
        setWorkspaceSyncStatuses({})
        return
      }

      if (isSyncingRef.current) {
        console.log('[PASSWORDS][SYNC] Synchronization already in-flight, skipping duplicate request.')
        return
      }

      isSyncingRef.current = true
      try {
        setCloudStatus('syncing')
        setSyncError(null)

        const currentWorkspaces = workspacesRef.current
        const workspacesToSync = targetWorkspaceId
          ? currentWorkspaces.filter((w) => w.id === targetWorkspaceId)
          : currentWorkspaces

        // Mark workspaces in progress
        setWorkspaceSyncStatuses((prev) => {
          const next = { ...prev }
          for (const ws of workspacesToSync) {
            next[ws.id] = 'syncing'
          }
          return next
        })

        const db = getFirebaseFirestore()
        let hasAnyError = false
        let lastErrorMessage = ''

        for (const ws of workspacesToSync) {
          try {
            // If already verified synced and not forced, skip redundant sync
            if (!force && syncedWorkspacesRef.current.has(ws.id)) {
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'synced' }))
              continue
            }

            console.log(
              `[PASSWORDS][SYNC][START] Project: social-hub-32839 | UID: ${user.uid} | Workspace: ${ws.id}`
            )
            const wsDocRef = doc(db, WORKSPACES_COLLECTION, ws.id)
            const wsSnap = await getDoc(wsDocRef)
            let remotePasswords: any[] = []
            if (wsSnap.exists()) {
              const wsData = wsSnap.data() as FirestoreWorkspaceDocument
              remotePasswords = Array.isArray(wsData.ws_passwords) ? wsData.ws_passwords : []
            } else {
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'failed' }))
              setWorkspaceSyncErrors((prev) => ({
                ...prev,
                [ws.id]: 'Workspace document does not exist in Firestore'
              }))
              hasAnyError = true
              lastErrorMessage = `Workspace ${ws.id} document not found`
              continue
            }

            // Sync with local store in main process (handles plaintext and migration of legacy records)
            const syncResult = await window.socialHub.syncWorkspaceCredentialsWithCloud(
              ws.id,
              remotePasswords
            )

            // Only write to Firestore if remote records actually need updating
            if (syncResult && Array.isArray(syncResult.mergedRecords)) {
              if (syncResult.remoteUpdated) {
                const writeResult = await syncWorkspacePasswords(
                  user,
                  ws.id,
                  syncResult.mergedRecords,
                  db
                )
                if (writeResult.synced) {
                  syncedWorkspacesRef.current.add(ws.id)
                  setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'synced' }))
                  setWorkspaceSyncErrors((prev) => {
                    const next = { ...prev }
                    delete next[ws.id]
                    return next
                  })
                  console.log(
                    `[PASSWORDS][SYNC][SUCCESS] Workspace: ${ws.id} successfully verified with ${syncResult.mergedRecords.length} records.`
                  )
                } else {
                  setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'failed' }))
                  setWorkspaceSyncErrors((prev) => ({ ...prev, [ws.id]: writeResult.reason }))
                  hasAnyError = true
                  lastErrorMessage = writeResult.reason
                  console.error(
                    `[PASSWORDS][SYNC][FAIL] Workspace: ${ws.id} write failed: ${writeResult.reason}`
                  )
                }
              } else {
                // Remote records already identical in Firestore; skip redundant network write
                syncedWorkspacesRef.current.add(ws.id)
                setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'synced' }))
                setWorkspaceSyncErrors((prev) => {
                  const next = { ...prev }
                  delete next[ws.id]
                  return next
                })
                console.log(
                  `[PASSWORDS][SYNC][UP_TO_DATE] Workspace: ${ws.id} already in sync (${syncResult.mergedRecords.length} records). Skipping redundant Firestore write.`
                )
              }
            } else {
              syncedWorkspacesRef.current.add(ws.id)
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'synced' }))
            }
          } catch (wsErr) {
            const msg = wsErr instanceof Error ? wsErr.message : 'Workspace sync failed'
            setWorkspaceSyncStatuses((prev) => ({ ...prev, [ws.id]: 'failed' }))
            setWorkspaceSyncErrors((prev) => ({ ...prev, [ws.id]: msg }))
            hasAnyError = true
            lastErrorMessage = msg
            console.error(`[PASSWORDS][SYNC][ERROR] Workspace ${ws.id} sync error:`, wsErr)
          }
        }

        await loadCredentials()

        if (hasAnyError) {
          setSyncError(lastErrorMessage)
          setCloudStatus('failed')
        } else {
          setSyncError(null)
          setCloudStatus('synced')
        }
      } catch (err) {
        console.error('[PASSWORDS][SYNC] Cloud synchronization error:', err)
        const msg = err instanceof Error ? err.message : 'Cloud synchronization failed.'
        setSyncError(msg)
        setCloudStatus('failed')
      } finally {
        isSyncingRef.current = false
      }
    },
    [user, loadCredentials]
  )

  // Re-sync on network connectivity return
  useEffect(() => {
    const handleOnline = () => {
      console.log('[PASSWORDS] Network online event received. Retrying sync...')
      if (user && user.uid) {
        void runCloudSync(true)
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [user, runCloudSync])

  // Initialize and load credentials on mount and when user changes
  useEffect(() => {
    let isMounted = true
    syncedWorkspacesRef.current.clear()

    const initialize = async () => {
      await loadCredentials()
      if (isMounted) {
        if (user && user.uid) {
          void runCloudSync(true)
        } else {
          setCloudStatus('local')
          setWorkspaceSyncStatuses({})
        }
      }
    }

    void initialize()

    let offUpdate: (() => void) | undefined
    try {
      if (typeof window.socialHub?.onPasswordsUpdated === 'function') {
        offUpdate = window.socialHub.onPasswordsUpdated(() => {
          if (isMounted) {
            void loadCredentials()
          }
        })
      }
    } catch (e) {
      console.warn('[PASSWORDS] Could not subscribe to password updates:', e)
    }

    return () => {
      isMounted = false
      offUpdate?.()
    }
  }, [user?.uid, runCloudSync, loadCredentials])

  // Synchronize newly added or switched workspaces
  useEffect(() => {
    if (!user || !user.uid) return
    const unsynced = workspaces.filter((ws) => !syncedWorkspacesRef.current.has(ws.id))
    if (unsynced.length > 0 && !isSyncingRef.current) {
      void runCloudSync(false)
    }
  }, [workspaces, user, runCloudSync])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingCred) {
          setEditingCred(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingCred, onClose])

  // Filtered credentials based on search
  const filteredCredentials = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return credentials
    return credentials.filter(
      (c) =>
        (c.workspaceName || '').toLowerCase().includes(q) ||
        (c.accountName || '').toLowerCase().includes(q) ||
        (c.origin || '').toLowerCase().includes(q) ||
        (c.username || '').toLowerCase().includes(q)
    )
  }, [credentials, searchQuery])

  // Hierarchical grouping: Workspace -> Account -> Website
  const hierarchy = useMemo(() => {
    type SiteGroup = { origin: string; items: CredentialSummary[] }
    type AccountGroup = { accountId: string; accountName: string; accountAppId?: string; sites: SiteGroup[] }
    type WorkspaceGroup = { workspaceId: string; workspaceName: string; accounts: AccountGroup[] }

    const wsMap = new Map<string, WorkspaceGroup>()

    for (const cred of filteredCredentials) {
      const wsId = cred.workspaceId || 'default-ws'
      const wsName = cred.workspaceName || 'Workspace'
      if (!wsMap.has(wsId)) {
        wsMap.set(wsId, {
          workspaceId: wsId,
          workspaceName: wsName,
          accounts: []
        })
      }
      const wsGroup = wsMap.get(wsId)!

      const accId = cred.accountId || 'default-acc'
      const accName = cred.accountName || 'Account'
      let accGroup = wsGroup.accounts.find((a) => a.accountId === accId)
      if (!accGroup) {
        accGroup = {
          accountId: accId,
          accountName: accName,
          accountAppId: cred.accountAppId,
          sites: []
        }
        wsGroup.accounts.push(accGroup)
      }

      const orig = cred.origin || 'unknown'
      let siteGroup = accGroup.sites.find((s) => s.origin === orig)
      if (!siteGroup) {
        siteGroup = { origin: orig, items: [] }
        accGroup.sites.push(siteGroup)
      }

      siteGroup.items.push(cred)
    }

    return Array.from(wsMap.values())
  }, [filteredCredentials])

  // Reveal or hide password
  const toggleRevealPassword = async (id: string) => {
    if (revealedPasswords[id]) {
      setRevealedPasswords((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }

    try {
      const pass = await window.socialHub.revealPassword(id)
      setRevealedPasswords((prev) => ({ ...prev, [id]: pass }))
    } catch (error) {
      console.error('[PASSWORDS] Failed to reveal password:', error)
      showToast('Could not reveal password.')
    }
  }

  // Copy username
  const handleCopyUsername = async (cred: CredentialSummary) => {
    try {
      await navigator.clipboard.writeText(cred.username)
      setCopiedField({ id: cred.id, field: 'username' })
      showToast('Username copied to clipboard.')
      setTimeout(() => setCopiedField(null), 2000)
    } catch {
      showToast('Could not copy username.')
    }
  }

  // Copy password
  const handleCopyPassword = async (cred: CredentialSummary) => {
    try {
      await window.socialHub.copyPassword(cred.id)
      setCopiedField({ id: cred.id, field: 'password' })
      showToast('Password copied to clipboard.')
      setTimeout(() => setCopiedField(null), 2000)
    } catch {
      showToast('Could not copy password.')
    }
  }

  // Open edit modal
  const handleStartEdit = async (cred: CredentialSummary) => {
    setEditingCred(cred)
    setEditUsername(cred.username)
    setEditPassword('')
    setShowEditPassword(false)
    try {
      const existingPass = await window.socialHub.revealPassword(cred.id)
      setEditPassword(existingPass)
    } catch {
      // If reveal fails, leave password input blank for user to supply new one
    }
  }

  // Save edit
  const handleSaveEdit = async () => {
    if (!editingCred) return
    try {
      await window.socialHub.updateCredential({
        id: editingCred.id,
        username: editUsername,
        password: editPassword || undefined
      })
      showToast('Credential updated.')
      setEditingCred(null)
      await loadCredentials()

      // If user is authenticated, sync the updated credential to Firestore
      if (user && editingCred.workspaceId) {
        const encryptedRecord = await window.socialHub.encryptCredentialForCloud(editingCred.id)
        if (encryptedRecord) {
          const db = getFirebaseFirestore()
          const wsDocRef = doc(db, WORKSPACES_COLLECTION, editingCred.workspaceId)
          const wsSnap = await getDoc(wsDocRef)
          if (wsSnap.exists()) {
            const wsData = wsSnap.data() as FirestoreWorkspaceDocument
            const existingList = Array.isArray(wsData.ws_passwords) ? [...wsData.ws_passwords] : []
            const idx = existingList.findIndex(
              (p) => (p.credential_id || (p as any).credentialId) === editingCred.id
            )
            if (idx >= 0) {
              existingList[idx] = encryptedRecord
            } else {
              existingList.push(encryptedRecord)
            }
            const writeResult = await syncWorkspacePasswords(user, editingCred.workspaceId, existingList, db)
            if (writeResult.synced) {
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [editingCred.workspaceId]: 'synced' }))
            } else {
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [editingCred.workspaceId]: 'failed' }))
              setWorkspaceSyncErrors((prev) => ({ ...prev, [editingCred.workspaceId]: writeResult.reason }))
            }
          }
        }
      }
    } catch (error) {
      console.error('[PASSWORDS] Failed to update credential:', error)
      showToast('Could not update credential.')
    }
  }

  // Delete credential
  const handleDelete = async (cred: CredentialSummary) => {
    if (!window.confirm('Are you sure you want to delete this saved password?')) {
      return
    }
    try {
      await window.socialHub.deleteCredential(cred.id)
      showToast('Password deleted.')
      await loadCredentials()

      // If user is authenticated, remove from Firestore ws_passwords
      if (user && cred.workspaceId) {
        try {
          const db = getFirebaseFirestore()
          const wsDocRef = doc(db, WORKSPACES_COLLECTION, cred.workspaceId)
          const wsSnap = await getDoc(wsDocRef)
          if (wsSnap.exists()) {
            const wsData = wsSnap.data() as FirestoreWorkspaceDocument
            const existingList = Array.isArray(wsData.ws_passwords) ? wsData.ws_passwords : []
            const filtered = existingList.filter(
              (p) => (p.credential_id || (p as any).credentialId) !== cred.id
            )
            const writeResult = await syncWorkspacePasswords(user, cred.workspaceId, filtered, db)
            if (writeResult.synced) {
              setWorkspaceSyncStatuses((prev) => ({ ...prev, [cred.workspaceId]: 'synced' }))
            }
          }
        } catch (cloudErr) {
          console.warn('[PASSWORDS] Failed to remove credential from cloud:', cloudErr)
        }
      }
    } catch (error) {
      console.error('[PASSWORDS] Failed to delete credential:', error)
      showToast('Could not delete password.')
    }
  }

  return (
    <div className="passwords-screen" role="region" aria-label="Password Manager">
      {/* Top Header */}
      <header className="passwords-header">
        <div className="passwords-title-area">
          <div className="passwords-icon-wrap">
            <KeyRound size={18} />
          </div>
          <div>
            <h2 className="passwords-title">Password Manager</h2>
            <span className="passwords-subtitle">
              {credentials.length} saved {credentials.length === 1 ? 'credential' : 'credentials'}
            </span>
          </div>
        </div>

        {/* Cloud Sync Status Indicator */}
        <div className="passwords-sync-control" role="region" aria-label="Cloud sync status">
          {!user ? (
            <span className="passwords-sync-pill unconfigured" title="Local machine storage only">
              <CloudOff size={13} />
              <span>Local Only</span>
            </span>
          ) : cloudStatus === 'syncing' ? (
            <span className="passwords-sync-pill syncing">
              <RefreshCw size={13} className="passwords-spin-icon" />
              <span>Syncing...</span>
            </span>
          ) : cloudStatus === 'synced' ? (
            <div className="passwords-sync-group">
              <span
                className="passwords-sync-pill synced"
                title="Credentials synchronized with Firestore"
              >
                <ShieldCheck size={13} />
                <span>Cloud Synced</span>
              </span>
              <button
                type="button"
                className="passwords-sync-action-btn"
                onClick={() => void runCloudSync(true)}
                title="Synchronize now"
                aria-label="Synchronize now"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          ) : (
            <div className="passwords-sync-group">
              <button
                type="button"
                className="passwords-sync-pill error"
                onClick={() => void runCloudSync(true)}
                title={syncError || 'Sync failed. Click to retry.'}
              >
                <AlertCircle size={13} />
                <span>Sync Failed (Retry)</span>
              </button>
            </div>
          )}
        </div>

        <div className="passwords-search-wrap">
          <Search size={14} className="passwords-search-icon" />
          <input
            type="text"
            className="passwords-search-input"
            placeholder="Search by workspace, account, website, username..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="passwords-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <button
          className="passwords-close-btn"
          onClick={onClose}
          title="Close Password Manager"
          aria-label="Close Password Manager"
        >
          <X size={18} />
        </button>
      </header>

      {/* Main Content Area */}
      <div className="passwords-body">
        {loading ? (
          <div className="passwords-loading">Loading saved passwords...</div>
        ) : loadError ? (
          <div className="passwords-empty">
            <div className="passwords-empty-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
              <KeyRound size={40} />
            </div>
            <h3>Failed to load credentials</h3>
            <p>{loadError}</p>
            <button
              className="passwords-retry-btn"
              onClick={() => {
                setLoading(true)
                void loadCredentials()
              }}
            >
              Retry
            </button>
          </div>
        ) : credentials.length === 0 ? (
          <div className="passwords-empty">
            <div className="passwords-empty-icon">
              <KeyRound size={40} />
            </div>
            <h3>No saved passwords</h3>
            <p>
              When you log in to websites in Social HUB, your credentials will be automatically
              captured, securely encrypted with DPAPI locally, and end-to-end encrypted with your master password in the cloud.
            </p>
          </div>
        ) : hierarchy.length === 0 ? (
          <div className="passwords-empty">
            <div className="passwords-empty-icon">
              <Search size={36} />
            </div>
            <h3>No matching credentials</h3>
            <p>No saved passwords match "{searchQuery}". Try a different keyword.</p>
          </div>
        ) : (
          <div className="passwords-hierarchy">
            {hierarchy.map((ws) => (
              <section key={ws.workspaceId} className="passwords-workspace-card">
                <div className="passwords-workspace-header">
                  <div className="passwords-ws-left">
                    <Layers size={14} className="passwords-ws-icon" />
                    <span className="passwords-ws-label">Workspace:</span>
                    <strong className="passwords-ws-name">{ws.workspaceName}</strong>
                  </div>
                  <div className="passwords-ws-meta">
                    <span className="passwords-ws-badge">
                      {ws.accounts.reduce((sum, a) => sum + a.sites.reduce((s, st) => s + st.items.length, 0), 0)}{' '}
                      saved
                    </span>
                    {(() => {
                      const wsStatus = workspaceSyncStatuses[ws.workspaceId] || (user ? 'syncing' : 'local')
                      const err = workspaceSyncErrors[ws.workspaceId]
                      if (wsStatus === 'synced') {
                        return (
                          <span
                            className="passwords-storage-badge cloud-synced"
                            title="Credentials synchronized to Firestore"
                          >
                            Cloud Synced
                          </span>
                        )
                      }
                      if (wsStatus === 'syncing') {
                        return (
                          <span
                            className="passwords-storage-badge syncing"
                            title="Synchronizing credentials with cloud..."
                          >
                            Syncing...
                          </span>
                        )
                      }
                      if (wsStatus === 'failed') {
                        return (
                          <span
                            className="passwords-storage-badge failed"
                            title={err || 'Cloud synchronization failed for this workspace'}
                          >
                            Sync Failed
                          </span>
                        )
                      }
                      return (
                        <span
                          className="passwords-storage-badge local-only"
                          title="Credentials are saved securely on this machine via Electron safeStorage"
                        >
                          Local Only
                        </span>
                      )
                    })()}
                  </div>
                </div>

                <div className="passwords-workspace-body">
                  {ws.accounts.map((acc) => (
                    <div key={acc.accountId} className="passwords-account-block">
                      <div className="passwords-account-header">
                        <span className="passwords-account-dot" />
                        <span className="passwords-account-title">{acc.accountName}</span>
                      </div>

                      <div className="passwords-sites-list">
                        {acc.sites.map((site) => (
                          <div key={site.origin} className="passwords-site-group">
                            <div className="passwords-site-header">
                              <Globe size={13} className="passwords-site-icon" />
                              <span className="passwords-site-origin" title={site.origin}>
                                {site.origin}
                              </span>
                            </div>

                            <div className="passwords-credentials-list">
                              {site.items.map((cred) => (
                                <div key={cred.id} className="passwords-cred-item">
                                  {/* Username row */}
                                  <div className="passwords-cred-row">
                                    <span className="passwords-cred-label">Username</span>
                                    <div className="passwords-cred-value-wrap">
                                      <span className="passwords-cred-value">
                                        {cred.username || <em className="passwords-no-user">No username saved</em>}
                                      </span>
                                      {cred.username && (
                                        <button
                                          className="passwords-copy-btn"
                                          onClick={() => void handleCopyUsername(cred)}
                                          title="Copy username"
                                          aria-label="Copy username"
                                        >
                                          {copiedField?.id === cred.id && copiedField.field === 'username' ? (
                                            <Check size={13} className="passwords-copied-icon" />
                                          ) : (
                                            <Copy size={13} />
                                          )}
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Password row */}
                                  <div className="passwords-cred-row">
                                    <span className="passwords-cred-label">Password</span>
                                    <div className="passwords-cred-value-wrap">
                                      <span className="passwords-cred-password-text">
                                        {revealedPasswords[cred.id] ? revealedPasswords[cred.id] : '••••••••••••'}
                                      </span>
                                      <button
                                        className="passwords-reveal-btn"
                                        onClick={() => void toggleRevealPassword(cred.id)}
                                        title={revealedPasswords[cred.id] ? 'Hide password' : 'Show password'}
                                        aria-label={revealedPasswords[cred.id] ? 'Hide password' : 'Show password'}
                                      >
                                        {revealedPasswords[cred.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                                      </button>
                                      <button
                                        className="passwords-copy-btn"
                                        onClick={() => void handleCopyPassword(cred)}
                                        title="Copy password"
                                        aria-label="Copy password"
                                      >
                                        {copiedField?.id === cred.id && copiedField.field === 'password' ? (
                                          <Check size={13} className="passwords-copied-icon" />
                                        ) : (
                                          <Copy size={13} />
                                        )}
                                      </button>
                                    </div>
                                  </div>

                                  {/* Item Actions */}
                                  <div className="passwords-cred-actions">
                                    <button
                                      className="passwords-edit-btn"
                                      onClick={() => void handleStartEdit(cred)}
                                      title="Edit credential"
                                      aria-label="Edit credential"
                                    >
                                      <Pencil size={12} />
                                      <span>Edit</span>
                                    </button>
                                    <button
                                      className="passwords-delete-btn"
                                      onClick={() => void handleDelete(cred)}
                                      title="Delete credential"
                                      aria-label="Delete credential"
                                    >
                                      <Trash2 size={12} />
                                      <span>Delete</span>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Edit Credential Modal Dialog */}
      {editingCred && (
        <div className="hub-dialog-backdrop" onClick={() => setEditingCred(null)}>
          <div className="hub-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit Credential">
            <div className="hub-dialog-header">
              <h3>Edit Credential</h3>
              <button
                className="hub-dialog-close"
                onClick={() => setEditingCred(null)}
                title="Cancel"
                aria-label="Cancel"
              >
                <X size={16} />
              </button>
            </div>

            <div className="hub-dialog-body">
              <label className="hub-dialog-field-label">Website Origin</label>
              <input type="text" value={editingCred.origin} disabled className="hub-dialog-input-disabled" />

              <label className="hub-dialog-field-label">Username / Email</label>
              <input
                type="text"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                placeholder="Username or email"
                autoFocus
              />

              <label className="hub-dialog-field-label">Password</label>
              <div className="hub-dialog-password-input-wrap">
                <input
                  type={showEditPassword ? 'text' : 'password'}
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  placeholder="Password"
                />
                <button
                  type="button"
                  className="hub-dialog-password-toggle"
                  onClick={() => setShowEditPassword(!showEditPassword)}
                  title={showEditPassword ? 'Hide password' : 'Show password'}
                >
                  {showEditPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <div className="hub-dialog-actions">
              <button type="button" className="hub-dialog-cancel" onClick={() => setEditingCred(null)}>
                Cancel
              </button>
              <button type="button" className="hub-dialog-submit" onClick={() => void handleSaveEdit()}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
