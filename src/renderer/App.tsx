import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import hubLogo from '../assets/icon_wh_small.png'
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Volume2,
  VolumeX
} from 'lucide-react'
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signOut, type User } from 'firebase/auth'
import type { Account, DownloadUpdate, HubState } from '../main/types'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp } from '../shared/apps'
import { getFirebaseAuth, getFirebaseConfigError } from './firebase'

type AccountMenu = { id: string; x: number; y: number } | null
type EditorDialog =
  | { kind: 'add' }
  | { kind: 'rename'; account: Account }
  | { kind: 'confirm-remove'; account: Account }
  | { kind: 'confirm-cache'; account: Account }
  | null

const initialState: HubState = {
  accounts: [],
  activeAccountId: null,
  preferences: { doNotDisturb: false, minimizeToTray: true, launchAtStartup: false }
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export default function App() {
  const [state, setState] = useState(initialState)
  const [menu, setMenu] = useState<AccountMenu>(null)
  const [dialog, setDialog] = useState<EditorDialog>(null)
  const [trayMenuOpen, setTrayMenuOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [download, setDownload] = useState<DownloadUpdate | null>(null)
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [firebaseAuthChecked, setFirebaseAuthChecked] = useState(false)
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firebaseSetupError = getFirebaseConfigError()
    ?? (!import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID ? 'Add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local.' : null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimeout.current) clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => setToast(''), 3200)
  }, [])

  const addAccount = useCallback(() => {
    setDialog({ kind: 'add' })
  }, [])

  const toggleFirebaseSignIn = async () => {
    try {
      if (firebaseUser) {
        await signOut(getFirebaseAuth())
        return
      }
      if (firebaseSetupError) throw new Error(firebaseSetupError)
      const idToken = await window.socialHub.getGoogleAuthToken()
      await signInWithCredential(getFirebaseAuth(), GoogleAuthProvider.credential(idToken))
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Google sign-in failed.')
    }
  }

  const submitAccount = useCallback(async (name: string, appId?: string, url?: string) => {
    try {
      if (dialog?.kind === 'rename') {
        await window.socialHub.renameAccount(dialog.account.id, name)
      } else {
        if (!appId) throw new Error('Select an app or website.')
        await window.socialHub.addAccount({ name, appId, url })
      }
      setDialog(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not add account.')
    }
  }, [dialog, showToast])

  useEffect(() => {
    let active = true
    void window.socialHub.getState().then((next) => {
      if (active) setState(next)
    }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not load accounts.')
    })
    const offState = window.socialHub.onState(setState)
    const offDownload = window.socialHub.onDownload(setDownload)
    const offShortcut = window.socialHub.onAddAccountShortcut(() => void addAccount())
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.tray-setting')) setTrayMenuOpen(false)
      if (!target.closest('.context-menu, .account-row')) setMenu(null)
    }
    document.addEventListener('pointerdown', closeMenusOutside)
    return () => {
      active = false
      offState()
      offDownload()
      offShortcut()
      document.removeEventListener('pointerdown', closeMenusOutside)
      if (toastTimeout.current) clearTimeout(toastTimeout.current)
    }
  }, [addAccount, showToast])

  useEffect(() => {
    if (getFirebaseConfigError()) {
      setFirebaseAuthChecked(true)
      return
    }
    try {
      return onAuthStateChanged(
        getFirebaseAuth(),
        (user) => {
          setFirebaseUser(user)
          setFirebaseAuthChecked(true)
        },
        (error) => {
          setFirebaseAuthChecked(true)
          showToast(error.message)
        }
      )
    } catch (error) {
      setFirebaseAuthChecked(true)
      showToast(error instanceof Error ? error.message : 'Could not initialize Firebase.')
    }
  }, [showToast])

  useEffect(() => {
    window.socialHub.setSidebarOverlay(Boolean(dialog || menu))
    return () => window.socialHub.setSidebarOverlay(false)
  }, [dialog, menu])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void addAccount()
      } else if (/^[1-9]$/.test(event.key)) {
        const account = state.accounts[Number(event.key) - 1]
        if (account) {
          event.preventDefault()
          void window.socialHub.activateAccount(account.id)
        }
      } else if (event.key.toLowerCase() === 'r' && state.activeAccountId) {
        event.preventDefault()
        void window.socialHub.reloadAccount(state.activeAccountId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addAccount, state.activeAccountId, state.accounts])

  const setPreference = async (key: 'doNotDisturb' | 'minimizeToTray' | 'launchAtStartup', value: boolean) => {
    try {
      const preferences = await window.socialHub.updatePreferences({ [key]: value })
      setState((current) => ({ ...current, preferences }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update setting.')
    }
  }

  const invoke = async (task: () => Promise<unknown>, success?: string) => {
    try {
      await task()
      if (success) showToast(success)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Action failed.')
    }
    setMenu(null)
  }

  const totalUnread = state.accounts.reduce((sum, account) => sum + account.unread, 0)

  return (
    <main className="hub-shell">
      <aside className="sidebar">
        <header className="brand">
          <img className="brand-logo" src={hubLogo} alt="" />
          <div className="brand-copy">
            <strong>Social Hub</strong>
            <span>All your accounts, together</span>
          </div>
        </header>

        <section className="account-section" aria-label="Web app accounts">
          <div className="section-heading">
            <span>YOUR ACCOUNTS</span>
            {totalUnread > 0 && <span className="total-pill">{totalUnread > 99 ? '99+' : totalUnread} unread</span>}
          </div>
          <nav className="account-list">
            {state.accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                active={account.id === state.activeAccountId}
                onSelect={() => {
                  void window.socialHub.activateAccount(account.id).catch((error: unknown) => {
                    showToast(error instanceof Error ? error.message : 'Could not switch accounts.')
                  })
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: account.id, x: Math.min(event.clientX, window.innerWidth - 230), y: event.clientY })
                }}
              />
            ))}
          </nav>
          <button className="add-account" onClick={() => void addAccount()}>
            <span className="add-icon"><Plus size={16} /></span>
            <span>Add an account</span>
            <kbd>⌘ N</kbd>
          </button>
        </section>

        <section className="privacy-card">
          <div className="privacy-icon"><ShieldCheck size={17} /></div>
          <div>
            <strong>Private by design</strong>
            <p>Each account has its own secure browser session.</p>
          </div>
        </section>

        {download && (
          <div className="download-status" role="status">
            <Download size={15} />
            <div className="download-copy">
              <span>{download.state === 'progressing' ? 'Downloading' : download.state === 'completed' ? 'Downloaded' : 'Download ended'}</span>
              <strong>{download.filename}</strong>
              {download.state === 'progressing' && download.totalBytes > 0 && (
                <div className="progress-track"><span style={{ width: `${Math.min(100, download.receivedBytes / download.totalBytes * 100)}%` }} /></div>
              )}
            </div>
            <button className="tiny-close" aria-label="Dismiss download" onClick={() => setDownload(null)}>×</button>
          </div>
        )}

        <footer className="sidebar-footer">
          <button
            className={`dnd-toggle ${state.preferences.doNotDisturb ? 'enabled' : ''}`}
            onClick={() => void setPreference('doNotDisturb', !state.preferences.doNotDisturb)}
          >
            {state.preferences.doNotDisturb ? <BellOff size={16} /> : <Bell size={16} />}
            <span>Do Not Disturb</span>
            <span className={`switch ${state.preferences.doNotDisturb ? 'on' : ''}`} />
          </button>
          <div className="footer-row">
            <span><Settings2 size={15} /> Preferences</span>
            <div className="tray-setting">
              <button
                className="small-select"
                aria-haspopup="menu"
                aria-expanded={trayMenuOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  setTrayMenuOpen((open) => !open)
                }}
              >
                Close to tray <ChevronDown size={13} />
              </button>
              {trayMenuOpen && (
                <div className="tray-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                  <button
                    role="menuitemradio"
                    aria-checked={state.preferences.minimizeToTray}
                    onClick={() => {
                      void setPreference('minimizeToTray', true)
                      setTrayMenuOpen(false)
                    }}
                  >
                    Minimize to tray
                    {state.preferences.minimizeToTray && <Check size={13} />}
                  </button>
                  <button
                    role="menuitemradio"
                    aria-checked={!state.preferences.minimizeToTray}
                    onClick={() => {
                      void setPreference('minimizeToTray', false)
                      setTrayMenuOpen(false)
                    }}
                  >
                    Quit when closing
                    {!state.preferences.minimizeToTray && <Check size={13} />}
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            className="firebase-auth-button"
            disabled={!firebaseAuthChecked}
            title={firebaseSetupError ?? firebaseUser?.email ?? undefined}
            onClick={() => void toggleFirebaseSignIn()}
          >
            {firebaseUser ? <LogOut size={15} /> : <LogIn size={15} />}
            <span>
              {firebaseUser
                ? `Sign out${firebaseUser.displayName ? ` · ${firebaseUser.displayName}` : ''}`
                : firebaseSetupError ? 'Google sign-in setup required' : 'Sign in with Google'}
            </span>
          </button>
          <button className="startup-row" onClick={() => void setPreference('launchAtStartup', !state.preferences.launchAtStartup)}>
            <span><Volume2 size={15} /> Launch at startup</span>
            <span className={`switch ${state.preferences.launchAtStartup ? 'on' : ''}`} />
          </button>
          <div className="bottom-note">
            <span>Every app runs in its own isolated session.</span>
            <CircleHelp size={14} aria-label="Help" />
          </div>
        </footer>
      </aside>

      {menu && (
        <AccountContextMenu
          account={state.accounts.find((account) => account.id === menu.id)}
          x={menu.x}
          y={menu.y}
          onRename={(account) => setDialog({ kind: 'rename', account })}
          onMute={(account) => void invoke(() => window.socialHub.setMuted(account.id, !account.muted))}
          onReload={(account) => void invoke(() => window.socialHub.reloadAccount(account.id))}
          onClearCache={(account) => {
            setDialog({ kind: 'confirm-cache', account })
          }}
          onRemove={(account) => {
            setDialog({ kind: 'confirm-remove', account })
          }}
        />
      )}
      {dialog && (
        <HubDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSubmitAccount={(name, appId, url) => void submitAccount(name, appId, url)}
          onConfirm={() => {
            if (dialog.kind === 'confirm-remove') {
              void invoke(() => window.socialHub.removeAccount(dialog.account.id), 'Account removed.')
              setDialog(null)
            } else if (dialog.kind === 'confirm-cache') {
              void invoke(() => window.socialHub.clearCache(dialog.account.id), 'Cache cleared.')
              setDialog(null)
            }
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  )
}

function HubDialog({
  dialog,
  onClose,
  onSubmitAccount,
  onConfirm
}: {
  dialog: Exclude<EditorDialog, null>
  onClose: () => void
  onSubmitAccount: (name: string, appId?: string, url?: string) => void
  onConfirm: () => void
}) {
  const [appMode, setAppMode] = useState<'app' | 'custom'>('app')
  if (dialog.kind === 'add' || dialog.kind === 'rename') {
    const rename = dialog.kind === 'rename'
    return (
      <div className="dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <form className="hub-dialog" onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const name = formData.get('account-name')
          if (typeof name !== 'string' || !name.trim()) return
          if (rename) {
            onSubmitAccount(name)
          } else if (appMode === 'custom') {
            const url = formData.get('website-url')
            if (typeof url === 'string') onSubmitAccount(name, CUSTOM_APP_ID, url)
          } else {
            const appId = formData.get('app-id')
            if (typeof appId === 'string') onSubmitAccount(name, appId)
          }
        }}>
          <h2>{rename ? 'Rename account' : 'Add an account'}</h2>
          <p>{rename ? 'Choose a name for this account.' : 'Choose an app or add any secure website. Each account gets its own login session.'}</p>
          {!rename && (
            <>
              <label htmlFor="app-mode">Type</label>
              <select id="app-mode" name="app-mode" value={appMode} onChange={(event) => setAppMode(event.currentTarget.value === 'custom' ? 'custom' : 'app')}>
                <option value="app">App</option>
                <option value="custom">Custom website</option>
              </select>
              {appMode === 'app' ? (
                <>
                  <label htmlFor="app-id">App</label>
                  <select id="app-id" name="app-id" defaultValue="whatsapp">
                    {[...new Set(APP_CATALOG.map((app) => app.category))].map((category) => (
                      <optgroup key={category} label={category}>
                        {APP_CATALOG.filter((app) => app.category === category).map((app) => (
                          <option key={app.id} value={app.id}>{app.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor="website-url">Website URL</label>
                  <input id="website-url" name="website-url" type="url" required placeholder="https://example.com" />
                </>
              )}
            </>
          )}
          <label htmlFor="account-name">Account name</label>
          <input id="account-name" name="account-name" maxLength={40} required autoFocus defaultValue={rename ? dialog.account.name : ''} placeholder="e.g. Personal" />
          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="dialog-primary">{rename ? 'Save name' : 'Add account'}</button>
          </div>
        </form>
      </div>
    )
  }

  const remove = dialog.kind === 'confirm-remove'
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="hub-dialog" role="alertdialog" aria-modal="true">
        <h2>{remove ? 'Remove account?' : 'Clear account cache?'}</h2>
        <p>
          {remove
            ? `“${dialog.account.name}” and its saved site session data will be permanently deleted.`
            : `Cached files for “${dialog.account.name}” will be deleted. Your login data will be kept.`}
        </p>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className={remove ? 'dialog-danger' : 'dialog-primary'} onClick={onConfirm}>
            {remove ? 'Remove account' : 'Clear cache'}
          </button>
        </div>
      </section>
    </div>
  )
}

function AccountRow({
  account,
  active,
  onSelect,
  onContextMenu
}: {
  account: Account
  active: boolean
  onSelect: () => void
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button className={`account-row ${active ? 'active' : ''}`} onClick={onSelect} onContextMenu={onContextMenu}>
      <span className="avatar-wrap">
        <span className="avatar" style={{ background: account.color }}>{getInitials(account.name)}</span>
        <span className="online-dot" />
      </span>
      <span className="account-meta">
        <span className="account-name">{account.name}</span>
        <span className="account-secondary">{account.muted ? <><VolumeX size={12} /> Muted</> : accountServiceName(account)}</span>
      </span>
      {account.unread > 0 && <span className="unread-badge">{account.unread > 99 ? '99+' : account.unread}</span>}
      {active && <span className="active-mark"><Check size={11} /></span>}
    </button>
  )
}

function accountServiceName(account: Account): string {
  const app = getCatalogApp(account.appId)
  if (app) return app.name
  try {
    return new URL(account.url).hostname
  } catch {
    return 'Website'
  }
}

function AccountContextMenu({
  account,
  x,
  y,
  onRename,
  onMute,
  onReload,
  onClearCache,
  onRemove
}: {
  account?: Account
  x: number
  y: number
  onRename: (account: Account) => void
  onMute: (account: Account) => void
  onReload: (account: Account) => void
  onClearCache: (account: Account) => void
  onRemove: (account: Account) => void
}) {
  if (!account) return null
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => onRename(account)}>Rename account</button>
      <button onClick={() => onMute(account)}>{account.muted ? <Volume2 size={14} /> : <VolumeX size={14} />}{account.muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={() => onReload(account)}><RefreshCw size={14} />Reload</button>
      <button onClick={() => onClearCache(account)}>Clear cache</button>
      <hr />
      <button className="danger" onClick={() => onRemove(account)}><Trash2 size={14} />Remove account</button>
    </div>
  )
}
