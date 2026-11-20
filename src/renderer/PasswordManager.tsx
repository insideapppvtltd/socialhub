import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  Pencil,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { CredentialSummary } from '../preload'

interface PasswordManagerProps {
  onClose: () => void
  showToast: (message: string) => void
}

export function PasswordManager({ onClose, showToast }: PasswordManagerProps) {
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

  const loadCredentials = async () => {
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
  }

  useEffect(() => {
    void loadCredentials()
    let offUpdate: (() => void) | undefined
    try {
      if (typeof window.socialHub?.onPasswordsUpdated === 'function') {
        offUpdate = window.socialHub.onPasswordsUpdated(() => {
          void loadCredentials()
        })
      }
    } catch (e) {
      console.warn('[PASSWORDS] Could not subscribe to password updates:', e)
    }
    return () => {
      offUpdate?.()
    }
  }, [])

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
      void loadCredentials()
    } catch (error) {
      console.error('[PASSWORDS] Failed to update credential:', error)
      showToast('Could not update credential.')
    }
  }

  // Delete credential
  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this saved password?')) {
      return
    }
    try {
      await window.socialHub.deleteCredential(id)
      showToast('Password deleted.')
      void loadCredentials()
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
              captured, securely encrypted, and isolated by workspace.
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
                  <span className="passwords-ws-badge">
                    {ws.accounts.reduce((sum, a) => sum + a.sites.reduce((s, st) => s + st.items.length, 0), 0)}{' '}
                    saved
                  </span>
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
                                      onClick={() => void handleDelete(cred.id)}
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

