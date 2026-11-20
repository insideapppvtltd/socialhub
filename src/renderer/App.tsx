import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import hubLogo from '../assets/icon_wh_small.png'
import {
  Bell,
  BellOff,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Download,
  Layers,
  LogOut,
  MapPin,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  Pencil,
  PhoneCall,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Shield,
  ShieldCheck,
  Sun,
  Trash2,
  User as UserIcon,
  Video,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth'
import type { Account, AccountPermissions, DownloadUpdate, HubNotificationItem, HubState, PermissionState, Preferences, ThemeMode, Workspace } from '../main/types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from '../main/types'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp, resolvePlatformName } from '../shared/apps'
import { getFirebaseAuth, logoutUser } from './firebase'
import { WelcomeScreen } from './WelcomeScreen'

type AccountMenu = { id: string; x: number; y: number } | null
type EditorDialog =
  | { kind: 'add' }
  | { kind: 'rename'; account: Account }
  | { kind: 'confirm-remove'; account: Account }
  | { kind: 'confirm-cache'; account: Account }
  | { kind: 'confirm-logout' }
  | { kind: 'add-workspace' }
  | { kind: 'rename-workspace'; workspace: Workspace }
  | { kind: 'delete-workspace'; workspace: Workspace }
  | { kind: 'permissions'; account: Account }
  | { kind: 'global-permissions' }
  | null

const initialState: HubState = {
  workspaces: [],
  activeWorkspaceId: null,
  accounts: [],
  activeAccountId: null,
  preferences: { doNotDisturb: false, minimizeToTray: true, launchAtStartup: false, theme: 'system' },
  globalDefaultPermissions: DEFAULT_ACCOUNT_PERMISSIONS
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return 'Just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 14) return `${diffDay}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function App() {
  const [state, setState] = useState(initialState)
  const [notifications, setNotifications] = useState<HubNotificationItem[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [activeCallCount, setActiveCallCount] = useState(0)
  const [menu, setMenu] = useState<AccountMenu>(null)
  const [dialog, setDialog] = useState<EditorDialog>(null)
  const [trayMenuOpen, setTrayMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [download, setDownload] = useState<DownloadUpdate | null>(null)
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null)
  const [firebaseAuthChecked, setFirebaseAuthChecked] = useState(false)
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimeout.current) clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => setToast(''), 3200)
  }, [])

  const addAccount = useCallback(() => {
    setDialog({ kind: 'add' })
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser()
      showToast('Logged out successfully.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Logout failed.')
    }
  }, [showToast])

  const submitAccount = useCallback(async (name: string, appId?: string, url?: string, workspaceId?: string) => {
    try {
      if (dialog?.kind === 'rename') {
        await window.socialHub.renameAccount(dialog.account.id, name)
      } else {
        if (!appId) throw new Error('Select an app or website.')
        await window.socialHub.addAccount({ name, appId, url, workspaceId })
      }
      setDialog(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not add account.')
    }
  }, [dialog, showToast])

  const submitAddWorkspace = useCallback(async (name: string) => {
    try {
      const ws = await window.socialHub.addWorkspace(name)
      await window.socialHub.activateWorkspace(ws.id)
      setDialog(null)
      showToast(`Workspace “${ws.name}” created.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create workspace.')
    }
  }, [showToast])

  const submitRenameWorkspace = useCallback(async (id: string, name: string) => {
    try {
      const ws = await window.socialHub.renameWorkspace(id, name)
      setDialog(null)
      showToast(`Workspace renamed to “${ws.name}”.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not rename workspace.')
    }
  }, [showToast])

  const submitDeleteWorkspace = useCallback(async (id: string) => {
    try {
      await window.socialHub.deleteWorkspace(id)
      setDialog(null)
      showToast('Workspace deleted.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not delete workspace.')
    }
  }, [showToast])

  useEffect(() => {
    let active = true
    void window.socialHub.getState().then((next) => {
      if (active) setState(next)
    }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not load accounts.')
    })
    void window.socialHub.getNotifications().then((items) => {
      if (active) setNotifications(items)
    }).catch((error: unknown) => {
      console.error('Could not load notifications:', error)
    })
    void window.socialHub.getActiveCallStatus?.().then((status) => {
      if (active && status) setActiveCallCount(status.count)
    }).catch(() => {})
    const offState = window.socialHub.onState(setState)
    const offNotifications = window.socialHub.onNotifications((items) => {
      if (active) setNotifications(items)
    })
    const offCallStatus = window.socialHub.onActiveCallStatus?.((status) => {
      if (active && status) setActiveCallCount(status.count)
    })
    const offDownload = window.socialHub.onDownload(setDownload)
    const offShortcut = window.socialHub.onAddAccountShortcut(() => void addAccount())
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.tray-setting')) setTrayMenuOpen(false)
      if (!target.closest('.context-menu, .account-row')) setMenu(null)
      if (!target.closest('.workspace-dropdown-container')) setWorkspaceMenuOpen(false)
      if (!target.closest('.notifications-panel, .notifications-nav-btn')) setNotificationsOpen(false)
    }
    document.addEventListener('pointerdown', closeMenusOutside)
    return () => {
      active = false
      offState()
      offNotifications()
      offCallStatus?.()
      offDownload()
      offShortcut()
      document.removeEventListener('pointerdown', closeMenusOutside)
      if (toastTimeout.current) clearTimeout(toastTimeout.current)
    }
  }, [addAccount, showToast])

  useEffect(() => {
    try {
      return onAuthStateChanged(
        getFirebaseAuth(),
        (user) => {
          setFirebaseUser(user)
          setFirebaseAuthChecked(true)
        },
        (error) => {
          console.error('[AUTH][STATE] Firebase auth state error:', error)
          setFirebaseAuthChecked(true)
          showToast(error.message)
        }
      )
    } catch (error) {
      console.error('[AUTH][INIT] Firebase auth initialization error:', error)
      setFirebaseAuthChecked(true)
    }
  }, [showToast])

  useEffect(() => {
    window.socialHub.setSidebarOverlay(Boolean(!firebaseUser || dialog || menu || workspaceMenuOpen || notificationsOpen))
    return () => window.socialHub.setSidebarOverlay(false)
  }, [firebaseUser, dialog, menu, workspaceMenuOpen, notificationsOpen])

  const activeWorkspace =
    state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0]
  const currentWorkspaceId = state.activeWorkspaceId ?? activeWorkspace?.id
  const workspaceAccounts = state.accounts.filter(
    (account) => account.workspaceId === currentWorkspaceId
  )

  const unreadNotificationsCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  )

  const handleNotificationClick = async (notif: HubNotificationItem) => {
    try {
      if (!notif.read) {
        await window.socialHub.markNotificationRead(notif.id)
      }
      setNotificationsOpen(false)
      const targetAccount = state.accounts.find((a) => a.id === notif.accountId)
      if (!targetAccount) {
        showToast('Account no longer exists.')
        return
      }
      if (notif.workspaceId && notif.workspaceId !== state.activeWorkspaceId) {
        const targetWorkspace = state.workspaces.find((w) => w.id === notif.workspaceId)
        if (targetWorkspace) {
          await window.socialHub.activateWorkspace(targetWorkspace.id)
        }
      }
      await window.socialHub.activateAccount(targetAccount.id)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not activate account.')
    }
  }

  const handleDismissNotification = async (event: MouseEvent, id: string) => {
    event.stopPropagation()
    try {
      await window.socialHub.removeNotification(id)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not dismiss notification.')
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await window.socialHub.markAllNotificationsRead()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not mark all notifications as read.')
    }
  }

  const handleClearAllNotifications = async () => {
    try {
      await window.socialHub.clearNotifications()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not clear notifications.')
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void addAccount()
      } else if (/^[1-9]$/.test(event.key)) {
        const account = workspaceAccounts[Number(event.key) - 1]
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
  }, [addAccount, state.activeAccountId, workspaceAccounts])

  const setPreference = async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    try {
      const preferences = await window.socialHub.updatePreferences({ [key]: value })
      setState((current) => ({ ...current, preferences }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update setting.')
    }
  }

  useEffect(() => {
    const applyResolvedTheme = () => {
      const mode: ThemeMode = state.preferences.theme ?? 'system'
      let resolved: 'light' | 'dark' = 'light'
      if (mode === 'dark') {
        resolved = 'dark'
      } else if (mode === 'light') {
        resolved = 'light'
      } else {
        resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      document.documentElement.setAttribute('data-theme', resolved)
    }

    applyResolvedTheme()

    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if ((state.preferences.theme ?? 'system') === 'system') {
        applyResolvedTheme()
      }
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [state.preferences.theme])

  const invoke = async (task: () => Promise<unknown>, success?: string) => {
    try {
      await task()
      if (success) showToast(success)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Action failed.')
    }
    setMenu(null)
  }

  const totalUnread = workspaceAccounts.reduce((sum, account) => sum + account.unread, 0)

  if (!firebaseAuthChecked) {
    return (
      <div className="auth-splash-screen" role="status" aria-label="Loading Social HUB">
        <div className="auth-splash-card">
          <img src={hubLogo} alt="Social HUB" className="auth-splash-logo" />
          <div className="auth-splash-spinner" />
          <p className="auth-splash-text">Starting Social HUB...</p>
        </div>
      </div>
    )
  }

  if (!firebaseUser) {
    return (
      <WelcomeScreen
        currentTheme={state.preferences.theme}
        onThemeChange={(theme) => void setPreference('theme', theme)}
      />
    )
  }

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

        {/* Workspace Bar */}
        <div className="workspace-bar">
          <div className="workspace-dropdown-container">
            <button
              className="workspace-trigger"
              aria-haspopup="menu"
              aria-expanded={workspaceMenuOpen}
              onClick={() => setWorkspaceMenuOpen((prev) => !prev)}
            >
              <div className="workspace-info">
                <span className="workspace-icon"><Layers size={14} /></span>
                <span className="workspace-name">{activeWorkspace?.name ?? 'Personal'}</span>
                <span className="workspace-badge">{workspaceAccounts.length}</span>
              </div>
              <ChevronDown size={13} className={`chevron ${workspaceMenuOpen ? 'rotate' : ''}`} />
            </button>

            {workspaceMenuOpen && (
              <div className="workspace-menu" role="menu">
                <div className="workspace-menu-header">
                  <span>WORKSPACES</span>
                  <button
                    className="workspace-add-mini"
                    title="Add Workspace"
                    onClick={() => {
                      setWorkspaceMenuOpen(false)
                      setDialog({ kind: 'add-workspace' })
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </div>

                <div className="workspace-items-list">
                  {state.workspaces.map((ws) => {
                    const count = state.accounts.filter((a) => a.workspaceId === ws.id).length
                    const isActive = ws.id === currentWorkspaceId
                    return (
                      <div
                        key={ws.id}
                        className={`workspace-menu-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          setWorkspaceMenuOpen(false)
                          void window.socialHub.activateWorkspace(ws.id).catch((err: unknown) => {
                            showToast(err instanceof Error ? err.message : 'Could not switch workspace.')
                          })
                        }}
                      >
                        <span className="ws-item-title">{ws.name}</span>
                        <span className="ws-item-count">{count}</span>
                        {isActive && <Check size={12} className="ws-check" />}
                        <div className="ws-item-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="ws-action-btn"
                            title="Rename Workspace"
                            onClick={() => {
                              setWorkspaceMenuOpen(false)
                              setDialog({ kind: 'rename-workspace', workspace: ws })
                            }}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            className="ws-action-btn danger"
                            title="Delete Workspace"
                            onClick={() => {
                              setWorkspaceMenuOpen(false)
                              setDialog({ kind: 'delete-workspace', workspace: ws })
                            }}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="workspace-menu-footer">
                  <button
                    className="workspace-add-full"
                    onClick={() => {
                      setWorkspaceMenuOpen(false)
                      setDialog({ kind: 'add-workspace' })
                    }}
                  >
                    <Plus size={13} />
                    <span>New workspace</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <section className="account-section" aria-label="Web app accounts">
          <div className="section-heading">
            <span>{activeWorkspace?.name ? `${activeWorkspace.name.toUpperCase()} ACCOUNTS` : 'YOUR ACCOUNTS'}</span>
            {totalUnread > 0 && <span className="total-pill">{totalUnread > 99 ? '99+' : totalUnread} unread</span>}
          </div>

          <nav className="account-list">
            {workspaceAccounts.length === 0 ? (
              <div className="workspace-empty-state">
                <p>No accounts in this workspace</p>
                <button className="add-account-empty" onClick={() => void addAccount()}>
                  <Plus size={13} /> Add an account
                </button>
              </div>
            ) : (
              workspaceAccounts.map((account) => (
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
              ))
            )}
          </nav>

          {workspaceAccounts.length > 0 && (
            <button className="add-account" onClick={() => void addAccount()}>
              <span className="add-icon"><Plus size={16} /></span>
              <span>Add an account</span>
              <kbd>⌘ N</kbd>
            </button>
          )}
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
          <button
            className={`sidebar-nav-item notifications-nav-btn ${notificationsOpen ? 'active' : ''}`}
            onClick={() => setNotificationsOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={notificationsOpen}
          >
            <span className="nav-item-left">
              <Bell size={15} />
              <span>Notifications</span>
              {activeCallCount > 0 && (
                <span
                  className="sidebar-call-indicator"
                  title="Incoming call in progress"
                  aria-label="Incoming call in progress"
                >
                  <PhoneCall size={12} className="sidebar-call-icon" />
                </span>
              )}
            </span>
            {unreadNotificationsCount > 0 && (
              <span className="nav-item-badge notifications-unread-badge">
                {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
              </span>
            )}
          </button>
          <button
            className="sidebar-nav-item permissions-nav-btn"
            onClick={() => setDialog({ kind: 'global-permissions' })}
          >
            <span className="nav-item-left">
              <ShieldCheck size={15} />
              <span>Permissions</span>
            </span>
            <span className="nav-item-badge">Defaults</span>
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
          <div className="preferences-appearance-row" role="region" aria-label="Appearance settings">
            <span className="appearance-label">Appearance</span>
            <div className="theme-toggle-group" role="radiogroup" aria-label="Theme selection">
              <button
                type="button"
                role="radio"
                aria-checked={state.preferences.theme === 'system'}
                className={`theme-btn ${state.preferences.theme === 'system' ? 'selected' : ''}`}
                onClick={() => void setPreference('theme', 'system')}
                title="System theme"
              >
                <Monitor size={12} />
                <span>System</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.preferences.theme === 'light'}
                className={`theme-btn ${state.preferences.theme === 'light' ? 'selected' : ''}`}
                onClick={() => void setPreference('theme', 'light')}
                title="Light theme"
              >
                <Sun size={12} />
                <span>Light</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.preferences.theme === 'dark'}
                className={`theme-btn ${state.preferences.theme === 'dark' ? 'selected' : ''}`}
                onClick={() => void setPreference('theme', 'dark')}
                title="Dark theme"
              >
                <Moon size={12} />
                <span>Dark</span>
              </button>
            </div>
          </div>
          {/* User Profile & Logout */}
          <div className="user-profile-row">
            <div
              className="user-profile-info"
              title={firebaseUser.email || `Anonymous User (UID: ${firebaseUser.uid})`}
            >
              <div className="user-profile-avatar">
                {firebaseUser.photoURL ? (
                  <img src={firebaseUser.photoURL} alt="" className="user-profile-img" referrerPolicy="no-referrer" />
                ) : (
                  <UserIcon size={13} />
                )}
              </div>
              <div className="user-profile-text">
                <span className="user-profile-name">
                  {firebaseUser.displayName ||
                    (firebaseUser.isAnonymous ? 'Anonymous' : firebaseUser.email?.split('@')[0] || 'User')}
                </span>
                <span className="user-profile-sub">
                  {firebaseUser.isAnonymous ? `UID: ${firebaseUser.uid.slice(0, 8)}...` : firebaseUser.email}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="logout-button"
              title="Log out of Social HUB"
              aria-label="Log out of Social HUB"
              onClick={() => setDialog({ kind: 'confirm-logout' })}
            >
              <LogOut size={13} />
              <span>Logout</span>
            </button>
          </div>
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

      {notificationsOpen && (
        <div className="notifications-panel" role="region" aria-label="Notifications Center">
          <div className="notifications-header">
            <div className="notifications-title-wrap">
              <h3 className="notifications-title">Notifications</h3>
              {unreadNotificationsCount > 0 && (
                <span className="notifications-count-pill">
                  {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount} unread
                </span>
              )}
            </div>
            <div className="notifications-actions">
              {notifications.length > 0 && (
                <>
                  {unreadNotificationsCount > 0 && (
                    <button
                      className="notif-action-btn"
                      onClick={() => void handleMarkAllRead()}
                      title="Mark all as read"
                      aria-label="Mark all as read"
                    >
                      <CheckCheck size={14} />
                    </button>
                  )}
                  <button
                    className="notif-action-btn danger"
                    onClick={() => void handleClearAllNotifications()}
                    title="Clear all notifications"
                    aria-label="Clear all notifications"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
              <button
                className="notif-action-btn"
                onClick={() => setNotificationsOpen(false)}
                title="Close panel"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="notifications-list" role="list">
            {notifications.length === 0 ? (
              <div className="notifications-empty">
                <div className="notifications-empty-icon">
                  <Bell size={20} />
                </div>
                <h4>No notifications</h4>
                <p>Incoming messages, calls, and downloads will appear here.</p>
              </div>
            ) : (
              notifications.map((notif) => {
                let TypeIcon = MessageSquare
                let iconClass = 'chat'
                if (notif.type === 'call') {
                  TypeIcon = notif.callType === 'video' ? Video : PhoneCall
                  iconClass = 'call'
                } else if (notif.type === 'download') {
                  TypeIcon = Download
                  iconClass = 'download'
                }

                return (
                  <div
                    key={notif.id}
                    className={`notification-item ${notif.read ? 'read' : 'unread'}`}
                    role="listitem"
                    tabIndex={0}
                    onClick={() => void handleNotificationClick(notif)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void handleNotificationClick(notif)
                      }
                    }}
                  >
                    <div className={`notif-type-icon ${iconClass}`}>
                      <TypeIcon size={14} />
                    </div>
                    <div className="notif-content">
                      <div className="notif-meta-row">
                        <span className="notif-origin">
                          {notif.workspaceName} • {notif.accountName} • {notif.platformName || resolvePlatformName(notif.accountAppId)}
                        </span>
                        <span className="notif-time">{formatRelativeTime(notif.timestamp)}</span>
                      </div>
                      <strong className="notif-title">{notif.title}</strong>
                      {notif.body && <span className="notif-body">{notif.body}</span>}
                    </div>
                    <div className="notif-item-actions">
                      {!notif.read && <span className="notif-unread-dot" title="Unread" />}
                      <button
                        className="notif-dismiss-btn"
                        title="Dismiss notification"
                        aria-label="Dismiss notification"
                        onClick={(e) => void handleDismissNotification(e, notif.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {menu && (
        <AccountContextMenu
          account={state.accounts.find((account) => account.id === menu.id)}
          x={menu.x}
          y={menu.y}
          onRename={(account) => {
            setMenu(null)
            setDialog({ kind: 'rename', account })
          }}
          onMute={(account) => void invoke(() => window.socialHub.setMuted(account.id, !account.muted))}
          onReload={(account) => void invoke(() => window.socialHub.reloadAccount(account.id))}
          onClearCache={(account) => {
            setMenu(null)
            setDialog({ kind: 'confirm-cache', account })
          }}
          onPermissions={(account) => {
            setMenu(null)
            setDialog({ kind: 'permissions', account })
          }}
          onRemove={(account) => {
            setMenu(null)
            setDialog({ kind: 'confirm-remove', account })
          }}
        />
      )}

      {dialog && (
        <HubDialog
          dialog={dialog}
          workspaces={state.workspaces}
          accounts={state.accounts}
          activeWorkspaceId={currentWorkspaceId ?? null}
          onClose={() => setDialog(null)}
          onSubmitAccount={(name, appId, url, workspaceId) => void submitAccount(name, appId, url, workspaceId)}
          onSubmitAddWorkspace={(name) => void submitAddWorkspace(name)}
          onSubmitRenameWorkspace={(id, name) => void submitRenameWorkspace(id, name)}
          onSubmitPermissions={async (permissions) => {
            if (dialog.kind !== 'permissions') return
            await window.socialHub.setAccountPermissions(dialog.account.id, permissions)
            showToast(`Permissions updated for ${dialog.account.name}.`)
            setDialog(null)
          }}
          globalDefaults={state.globalDefaultPermissions}
          onSubmitGlobalPermissions={async (permissions) => {
            await window.socialHub.updateGlobalDefaultPermissions(permissions)
            showToast('Default permissions updated.')
            setDialog(null)
          }}
          onResetGlobalPermissions={async () => {
            const reset = await window.socialHub.resetGlobalDefaultPermissions()
            showToast('Default permissions reset to initial values.')
            return reset
          }}
          onConfirm={() => {
            if (dialog.kind === 'confirm-remove') {
              void invoke(() => window.socialHub.removeAccount(dialog.account.id), 'Account removed.')
              setDialog(null)
            } else if (dialog.kind === 'confirm-cache') {
              void invoke(() => window.socialHub.clearCache(dialog.account.id), 'Cache cleared.')
              setDialog(null)
            } else if (dialog.kind === 'delete-workspace') {
              void submitDeleteWorkspace(dialog.workspace.id)
            } else if (dialog.kind === 'confirm-logout') {
              setDialog(null)
              void handleLogout()
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
  workspaces,
  accounts,
  activeWorkspaceId,
  globalDefaults,
  onClose,
  onSubmitAccount,
  onSubmitAddWorkspace,
  onSubmitRenameWorkspace,
  onSubmitPermissions,
  onSubmitGlobalPermissions,
  onResetGlobalPermissions,
  onConfirm
}: {
  dialog: Exclude<EditorDialog, null>
  workspaces: Workspace[]
  accounts: Account[]
  activeWorkspaceId: string | null
  globalDefaults: AccountPermissions
  onClose: () => void
  onSubmitAccount: (name: string, appId?: string, url?: string, workspaceId?: string) => void
  onSubmitAddWorkspace: (name: string) => void
  onSubmitRenameWorkspace: (id: string, name: string) => void
  onSubmitPermissions: (permissions: AccountPermissions) => Promise<void>
  onSubmitGlobalPermissions: (permissions: AccountPermissions) => Promise<void>
  onResetGlobalPermissions: () => Promise<AccountPermissions>
  onConfirm: () => void
}) {
  const [appMode, setAppMode] = useState<'app' | 'custom'>('app')

  if (dialog.kind === 'global-permissions') {
    return (
      <GlobalPermissionsDialog
        globalDefaults={globalDefaults}
        onClose={onClose}
        onSave={onSubmitGlobalPermissions}
        onResetDefaults={onResetGlobalPermissions}
      />
    )
  }

  if (dialog.kind === 'permissions') {
    return (
      <PermissionsDialog
        account={dialog.account}
        globalDefaults={globalDefaults}
        onClose={onClose}
        onSave={onSubmitPermissions}
      />
    )
  }

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
          } else {
            const workspaceId = formData.get('workspace-id')
            const selectedWsId = typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined
            if (appMode === 'custom') {
              const url = formData.get('website-url')
              if (typeof url === 'string') onSubmitAccount(name, CUSTOM_APP_ID, url, selectedWsId)
            } else {
              const appId = formData.get('app-id')
              if (typeof appId === 'string') onSubmitAccount(name, appId, undefined, selectedWsId)
            }
          }
        }}>
          <h2>{rename ? 'Rename account' : 'Add an account'}</h2>
          <p>{rename ? 'Choose a name for this account.' : 'Choose an app or add any secure website. Each account gets its own login session.'}</p>
          {!rename && (
            <>
              <label htmlFor="account-workspace">Workspace</label>
              <select
                id="account-workspace"
                name="workspace-id"
                defaultValue={activeWorkspaceId ?? workspaces[0]?.id}
              >
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>

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

  if (dialog.kind === 'add-workspace' || dialog.kind === 'rename-workspace') {
    const isRename = dialog.kind === 'rename-workspace'
    return (
      <div className="dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <form className="hub-dialog" onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const name = formData.get('workspace-name')
          if (typeof name !== 'string' || !name.trim()) return
          if (isRename) {
            onSubmitRenameWorkspace(dialog.workspace.id, name)
          } else {
            onSubmitAddWorkspace(name)
          }
        }}>
          <h2>{isRename ? 'Rename workspace' : 'Add workspace'}</h2>
          <p>{isRename ? 'Choose a new name for this workspace.' : 'Create a new workspace to group your accounts.'}</p>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            name="workspace-name"
            maxLength={40}
            required
            autoFocus
            defaultValue={isRename ? dialog.workspace.name : ''}
            placeholder="e.g. Work, Marketing, Social"
          />
          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="dialog-primary">{isRename ? 'Save name' : 'Create workspace'}</button>
          </div>
        </form>
      </div>
    )
  }

  if (dialog.kind === 'delete-workspace') {
    const accountCount = accounts.filter((a) => a.workspaceId === dialog.workspace.id).length
    const isOnlyWorkspace = workspaces.length <= 1

    if (accountCount > 0) {
      return (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}>
          <section className="hub-dialog" role="alertdialog" aria-modal="true">
            <h2>Cannot delete workspace</h2>
            <p>
              “{dialog.workspace.name}” contains {accountCount} account{accountCount === 1 ? '' : 's'}. You must remove or move all accounts before this workspace can be deleted.
            </p>
            <div className="dialog-actions">
              <button type="button" className="dialog-primary" onClick={onClose}>Understood</button>
            </div>
          </section>
        </div>
      )
    }

    if (isOnlyWorkspace) {
      return (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}>
          <section className="hub-dialog" role="alertdialog" aria-modal="true">
            <h2>Cannot delete workspace</h2>
            <p>
              “{dialog.workspace.name}” is your only workspace. Social Hub requires at least one active workspace.
            </p>
            <div className="dialog-actions">
              <button type="button" className="dialog-primary" onClick={onClose}>Understood</button>
            </div>
          </section>
        </div>
      )
    }

    return (
      <div className="dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <section className="hub-dialog" role="alertdialog" aria-modal="true">
          <h2>Delete workspace?</h2>
          <p>
            Are you sure you want to delete the empty workspace “{dialog.workspace.name}”? This action cannot be undone.
          </p>
          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="dialog-danger" onClick={onConfirm}>Delete workspace</button>
          </div>
        </section>
      </div>
    )
  }

  if (dialog.kind === 'confirm-logout') {
    return (
      <div
        className="dialog-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <section className="hub-dialog" role="alertdialog" aria-modal="true">
          <h2>Log out of Social HUB?</h2>
          <p>
            Are you sure you want to log out? Your workspaces, accounts, notifications, and login sessions will remain safely preserved on this device.
          </p>
          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="dialog-danger" onClick={onConfirm}>
              Log out
            </button>
          </div>
        </section>
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
  onPermissions,
  onRemove
}: {
  account?: Account
  x: number
  y: number
  onRename: (account: Account) => void
  onMute: (account: Account) => void
  onReload: (account: Account) => void
  onClearCache: (account: Account) => void
  onPermissions: (account: Account) => void
  onRemove: (account: Account) => void
}) {
  if (!account) return null
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => onRename(account)}>Rename account</button>
      <button onClick={() => onMute(account)}>{account.muted ? <Volume2 size={14} /> : <VolumeX size={14} />}{account.muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={() => onReload(account)}><RefreshCw size={14} />Reload</button>
      <button onClick={() => onClearCache(account)}>Clear cache</button>
      <button onClick={() => onPermissions(account)}><Shield size={14} />Permissions</button>
      <hr />
      <button className="danger" onClick={() => onRemove(account)}><Trash2 size={14} />Remove account</button>
    </div>
  )
}

function accountOrigin(account: Account): string {
  try {
    return new URL(account.url).origin
  } catch {
    return account.url
  }
}

function PermissionsDialog({
  account,
  globalDefaults,
  onClose,
  onSave
}: {
  account: Account
  globalDefaults: AccountPermissions
  onClose: () => void
  onSave: (permissions: AccountPermissions) => Promise<void>
}) {
  const [permissions, setPermissions] = useState<AccountPermissions>(() => ({
    ...globalDefaults,
    ...(account.permissions ?? {})
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const origin = accountOrigin(account)

  const updateKey = (key: keyof AccountPermissions, value: PermissionState) => {
    setPermissions((prev) => ({ ...prev, [key]: value }))
  }

  const resetDefaults = () => {
    setPermissions({ ...globalDefaults })
  }

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(permissions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions.')
      setSaving(false)
    }
  }

  const categories: Array<{
    key: keyof AccountPermissions
    label: string
    description: string
    icon: typeof Shield
  }> = [
    {
      key: 'camera',
      label: 'Camera',
      description: 'Allow site to capture video from your camera',
      icon: Camera
    },
    {
      key: 'microphone',
      label: 'Microphone',
      description: 'Allow site to capture audio from your microphone',
      icon: Mic
    },
    {
      key: 'notifications',
      label: 'Notifications',
      description: 'Allow site to send desktop notifications',
      icon: Bell
    },
    {
      key: 'screenShare',
      label: 'Screen Sharing',
      description: 'Allow site to prompt to share windows or screens',
      icon: Monitor
    },
    {
      key: 'clipboard',
      label: 'Clipboard Access',
      description: 'Allow site to read from and write to system clipboard',
      icon: Clipboard
    },
    {
      key: 'geolocation',
      label: 'Geolocation',
      description: 'Allow site to access your physical location',
      icon: MapPin
    },
    {
      key: 'downloads',
      label: 'Downloads',
      description: 'Allow site to trigger automatic file downloads',
      icon: Download
    }
  ]

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <form
        className="hub-dialog permissions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-title"
        onSubmit={handleSave}
      >
        <header className="permissions-header">
          <div className="permissions-title-wrap">
            <span className="permissions-icon-badge">
              <Shield size={18} />
            </span>
            <div>
              <h2 id="perm-title">Permissions</h2>
              <div className="permissions-subtitle">
                <strong>{account.name}</strong> · <span className="permissions-origin">{origin}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="permissions-reset-btn"
            onClick={resetDefaults}
            disabled={saving}
            title="Reset all to defaults"
          >
            <RotateCcw size={12} />
            <span>Reset to defaults</span>
          </button>
        </header>

        <div className="permissions-os-note">
          Operating system privacy settings take precedence. If Camera or Microphone is blocked in OS settings, Social HUB cannot grant access.
        </div>

        {error && <div className="permissions-error-banner" role="alert">{error}</div>}

        <div className="permissions-list">
          {categories.map((cat) => {
            const Icon = cat.icon
            const state = permissions[cat.key]
            return (
              <div key={cat.key} className="permission-row">
                <div className="permission-info">
                  <div className="permission-row-header">
                    <Icon size={14} className="permission-cat-icon" />
                    <span className="permission-label">{cat.label}</span>
                  </div>
                  <span className="permission-desc">{cat.description}</span>
                </div>
                <div className="permission-toggle-group" role="group" aria-label={`${cat.label} permission`}>
                  <button
                    type="button"
                    className={`perm-btn allow ${state === 'allow' ? 'selected' : ''}`}
                    aria-pressed={state === 'allow'}
                    disabled={saving}
                    onClick={() => updateKey(cat.key, 'allow')}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    className={`perm-btn block ${state === 'block' ? 'selected' : ''}`}
                    aria-pressed={state === 'block'}
                    disabled={saving}
                    onClick={() => updateKey(cat.key, 'block')}
                  >
                    Block
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="dialog-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save permissions'}
          </button>
        </div>
      </form>
    </div>
  )
}

function GlobalPermissionsDialog({
  globalDefaults,
  onClose,
  onSave,
  onResetDefaults
}: {
  globalDefaults: AccountPermissions
  onClose: () => void
  onSave: (permissions: AccountPermissions) => Promise<void>
  onResetDefaults: () => Promise<AccountPermissions>
}) {
  const [permissions, setPermissions] = useState<AccountPermissions>(() => ({
    ...DEFAULT_ACCOUNT_PERMISSIONS,
    ...globalDefaults
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateKey = (key: keyof AccountPermissions, value: PermissionState) => {
    setPermissions((prev) => ({ ...prev, [key]: value }))
  }

  const resetToFactory = async () => {
    try {
      const reset = await onResetDefaults()
      setPermissions({ ...reset })
    } catch {
      setPermissions({ ...DEFAULT_ACCOUNT_PERMISSIONS })
    }
  }

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(permissions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save default permissions.')
      setSaving(false)
    }
  }

  const categories: Array<{
    key: keyof AccountPermissions
    label: string
    description: string
    icon: typeof ShieldCheck
  }> = [
    {
      key: 'camera',
      label: 'Camera',
      description: 'Default camera access for new accounts',
      icon: Camera
    },
    {
      key: 'microphone',
      label: 'Microphone',
      description: 'Default microphone access for new accounts',
      icon: Mic
    },
    {
      key: 'notifications',
      label: 'Notifications',
      description: 'Default notification permission for new accounts',
      icon: Bell
    },
    {
      key: 'screenShare',
      label: 'Screen Sharing',
      description: 'Default screen sharing permission for new accounts',
      icon: Monitor
    },
    {
      key: 'clipboard',
      label: 'Clipboard Access',
      description: 'Default clipboard access for new accounts',
      icon: Clipboard
    },
    {
      key: 'geolocation',
      label: 'Geolocation',
      description: 'Default physical location permission for new accounts',
      icon: MapPin
    },
    {
      key: 'downloads',
      label: 'Downloads',
      description: 'Default file download permission for new accounts',
      icon: Download
    }
  ]

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <form
        className="hub-dialog permissions-dialog global-permissions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-perm-title"
        onSubmit={handleSave}
      >
        <header className="permissions-header">
          <div className="permissions-title-wrap">
            <span className="permissions-icon-badge">
              <ShieldCheck size={18} />
            </span>
            <div>
              <h2 id="global-perm-title">Permissions</h2>
              <div className="permissions-subtitle">
                <strong>Default settings</strong> · <span className="permissions-origin">Applied to newly created accounts</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="permissions-reset-btn"
            onClick={resetToFactory}
            disabled={saving}
            title="Reset to initial factory defaults"
          >
            <RotateCcw size={12} />
            <span>Reset to defaults</span>
          </button>
        </header>

        <div className="permissions-os-note">
          These settings define default permissions for newly created accounts. Existing accounts keep their current settings, and individual account permissions can still be managed independently.
        </div>

        {error && <div className="permissions-error-banner" role="alert">{error}</div>}

        <div className="permissions-list">
          {categories.map((cat) => {
            const Icon = cat.icon
            const state = permissions[cat.key]
            return (
              <div key={cat.key} className="permission-row">
                <div className="permission-info">
                  <div className="permission-row-header">
                    <Icon size={14} className="permission-cat-icon" />
                    <span className="permission-label">{cat.label}</span>
                  </div>
                  <span className="permission-desc">{cat.description}</span>
                </div>
                <div className="permission-toggle-group" role="group" aria-label={`${cat.label} default permission`}>
                  <button
                    type="button"
                    className={`perm-btn allow ${state === 'allow' ? 'selected' : ''}`}
                    aria-pressed={state === 'allow'}
                    disabled={saving}
                    onClick={() => updateKey(cat.key, 'allow')}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    className={`perm-btn block ${state === 'block' ? 'selected' : ''}`}
                    aria-pressed={state === 'block'}
                    disabled={saving}
                    onClick={() => updateKey(cat.key, 'block')}
                  >
                    Block
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="dialog-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save defaults'}
          </button>
        </div>
      </form>
    </div>
  )
}
