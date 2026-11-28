import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import hubLogo from '../assets/icon_wh_small.png'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Bell,
  BellOff,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Download,
  KeyRound,
  Layers,
  Link,
  Loader2,
  LogOut,
  MapPin,
  Menu,
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
  UserPlus,
  Video,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth'
import type { Account, AccountNavigationState, AccountPermissions, DownloadUpdate, HubNotificationItem, HubState, PermissionState, Preferences, ThemeMode, Workspace } from '../main/types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from '../main/types'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp, resolvePlatformName } from '../shared/apps'
import { getFirebaseAuth, logoutUser, getFirebaseFirestore } from './firebase'
import { syncUserDocument, resetUserSyncCache } from './firebase-users'
import {
  syncUserWorkspaces,
  syncWorkspaceCreation,
  syncWorkspaceDeletion,
  syncWorkspaceLastVisit,
  syncWorkspaceOnSwitch,
  syncWorkspaceMetadataUpdate,
  syncWorkspacePasswords,
  syncAccountAddition,
  syncAccountUpdate,
  syncAccountRemoval,
  syncLocalWorkspaceOwnersWithRemote,
  isAuthorizedUser,
  fetchWorkspaceCollaborationDetails,
  findRegisteredUserByEmail,
  addWorkspaceCollaborator,
  removeWorkspaceCollaborator,
  isValidCollaboratorEmail,
  WORKSPACES_COLLECTION,
  type FirestoreWorkspaceDocument,
  type WorkspaceCollaborationDetails,
  type WorkspaceCollaboratorProfile
} from './firebase-workspaces'
import { doc, getDoc } from 'firebase/firestore'
import { WelcomeScreen } from './WelcomeScreen'
import { PasswordManager } from './PasswordManager'
import { isAndroidRuntime } from './platform/hub-bridge'

type AccountMenu = { id: string; x: number; y: number } | null
type EditorDialog =
  | { kind: 'add' }
  | { kind: 'rename'; account: Account }
  | { kind: 'edit'; account: Account }
  | { kind: 'confirm-remove'; account: Account }
  | { kind: 'confirm-cache'; account: Account }
  | { kind: 'confirm-logout' }
  | { kind: 'add-workspace' }
  | { kind: 'rename-workspace'; workspace: Workspace }
  | { kind: 'delete-workspace'; workspace: Workspace }
  | { kind: 'collaborators'; workspace: Workspace }
  | { kind: 'permissions'; account: Account }
  | { kind: 'global-permissions' }
  | null

const initialState: HubState = {
  workspaces: [],
  activeWorkspaceId: null,
  accounts: [],
  activeAccountId: null,
  preferences: { doNotDisturb: false, minimizeToTray: true, launchAtStartup: false, theme: 'system', accountSortBy: 'name' },
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
  const [passwordsOpen, setPasswordsOpen] = useState(false)
  const [activeCallCount, setActiveCallCount] = useState(0)
  const [menu, setMenu] = useState<AccountMenu>(null)
  const [dialog, setDialog] = useState<EditorDialog>(null)
  const [trayMenuOpen, setTrayMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const isAndroid = isAndroidRuntime()
  const [navStatesByAccount, setNavStatesByAccount] = useState<Record<string, AccountNavigationState>>({})
  const [copiedLinkAccountId, setCopiedLinkAccountId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [download, setDownload] = useState<DownloadUpdate | null>(null)
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null)
  const [firebaseAuthChecked, setFirebaseAuthChecked] = useState(false)
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyLinkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimeout.current) clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => setToast(''), 3200)
  }, [])

  const handleCopyAccountLink = useCallback(async (accountId: string) => {
    try {
      const copiedUrl = await window.socialHub.navCopyUrl(accountId)
      if (copiedUrl) {
        setCopiedLinkAccountId(accountId)
        if (copyLinkTimeout.current) clearTimeout(copyLinkTimeout.current)
        copyLinkTimeout.current = setTimeout(() => setCopiedLinkAccountId(null), 1800)
        showToast('Link copied to clipboard.')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not copy link.')
    }
  }, [showToast])

  const addAccount = useCallback(() => {
    if (state.workspaces.length === 0) {
      setDialog({ kind: 'add-workspace' })
      return
    }
    const currentWs = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0]
    if (currentWs?.ownerId && firebaseUser && currentWs.ownerId !== firebaseUser.uid) {
      showToast('Only the workspace owner can add apps to this workspace.')
      return
    }
    setDialog({ kind: 'add' })
  }, [state.workspaces, state.activeWorkspaceId, firebaseUser, showToast])

  const handleLogout = useCallback(async (logoutConnectedApps = false) => {
    try {
      resetUserSyncCache()
      await window.socialHub.lockCloudPassword().catch(() => {})
      if (logoutConnectedApps) {
        const result = await window.socialHub.logoutConnectedApps?.().catch((err) => {
          console.warn('[LOGOUT][APPS] Failed to clear some connected app sessions:', err)
          return { clearedCount: 0, errors: [err instanceof Error ? err.message : String(err)] }
        })
        if (result && result.errors.length > 0) {
          console.warn('[LOGOUT][APPS] Partial connected-app logout errors:', result.errors)
        }
      }
      await window.socialHub.setCurrentUser(null)
      setActiveCallCount(0)
      await logoutUser()
      showToast(
        logoutConnectedApps
          ? 'Logged out of Social HUB and connected apps.'
          : 'Logged out successfully.'
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Logout failed.')
    }
  }, [showToast])

  const submitAccount = useCallback(async (name: string, appId?: string, url?: string, workspaceId?: string) => {
    try {
      if (dialog?.kind === 'rename') {
        const updated = await window.socialHub.renameAccount(dialog.account.id, name)
        if (firebaseUser) {
          void syncAccountUpdate(firebaseUser, updated.workspaceId, {
            id: updated.id,
            name: updated.name,
            url: updated.url
          })
        }
      } else {
        if (!appId) throw new Error('Select an app or website.')
        const targetWsId = workspaceId || state.activeWorkspaceId || state.workspaces[0]?.id
        if (!targetWsId) throw new Error('Create a workspace before adding an app.')
        const added = await window.socialHub.addAccount({ name, appId, url, workspaceId: targetWsId })
        if (firebaseUser) {
          void syncAccountAddition(firebaseUser, added.workspaceId, {
            id: added.id,
            name: added.name,
            url: added.url
          }).then((res) => {
            if (res) {
              void window.socialHub.markAccountSynced(added.id)
            }
          })
        }
      }
      setDialog(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not add app.')
    }
  }, [dialog, firebaseUser, state.activeWorkspaceId, state.workspaces, showToast])

  const submitEditAccount = useCallback(async (accountId: string, name: string, url: string) => {
    try {
      const updated = await window.socialHub.updateAccount(accountId, { name, url })
      if (firebaseUser) {
        void syncAccountUpdate(firebaseUser, updated.workspaceId, {
          id: updated.id,
          name: updated.name,
          url: updated.url
        })
      }
      setDialog(null)
      showToast('App updated.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update app.')
    }
  }, [firebaseUser, showToast])

  const submitAddWorkspace = useCallback(async (name: string) => {
    try {
      const ws = await window.socialHub.addWorkspace(name)
      if (firebaseUser) {
        await syncWorkspaceCreation(firebaseUser, ws).then((res) => {
          if (res) {
            void window.socialHub.markWorkspaceSynced(ws.id)
          }
        })
      }
      await window.socialHub.activateWorkspace(ws.id)
      const nextState = await window.socialHub.getState()
      setState(nextState)
      setDialog(null)
      showToast(`Workspace “${ws.name}” created.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create workspace.')
    }
  }, [firebaseUser, showToast])

  const submitRenameWorkspace = useCallback(async (id: string, name: string) => {
    try {
      const ws = await window.socialHub.renameWorkspace(id, name)
      if (firebaseUser) {
        void syncWorkspaceMetadataUpdate(firebaseUser, id, { name })
      }
      setDialog(null)
      showToast(`Workspace renamed to “${ws.name}”.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not rename workspace.')
    }
  }, [firebaseUser, showToast])

  const submitDeleteWorkspace = useCallback(async (id: string) => {
    try {
      await window.socialHub.deleteWorkspace(id)
      if (firebaseUser) {
        void syncWorkspaceDeletion(firebaseUser, id)
      }
      const nextState = await window.socialHub.getState()
      setState(nextState)
      setDialog(null)
      showToast('Workspace deleted.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not delete workspace.')
    }
  }, [firebaseUser, showToast])

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
    }).catch(() => { })
    const offState = window.socialHub.onState(setState)
    const offNotifications = window.socialHub.onNotifications((items) => {
      if (active) setNotifications(items)
    })
    const offCallStatus = window.socialHub.onActiveCallStatus?.((status) => {
      if (active && status) setActiveCallCount(status.count)
    })
    const offDownload = window.socialHub.onDownload(setDownload)
    const offShortcut = window.socialHub.onAddAccountShortcut(() => void addAccount())
    const offNavState = window.socialHub.onNavState?.((navState) => {
      if (active && navState?.accountId) {
        setNavStatesByAccount((prev) => ({ ...prev, [navState.accountId]: navState }))
      }
    })
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.tray-setting')) setTrayMenuOpen(false)
      if (!target.closest('.context-menu, .account-row')) setMenu(null)
      if (!target.closest('.workspace-dropdown-container')) setWorkspaceMenuOpen(false)
      if (!target.closest('.account-sort-container')) setSortMenuOpen(false)
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
      offNavState?.()
      document.removeEventListener('pointerdown', closeMenusOutside)
      if (toastTimeout.current) clearTimeout(toastTimeout.current)
      if (copyLinkTimeout.current) clearTimeout(copyLinkTimeout.current)
    }
  }, [addAccount, showToast])

  const isRefreshingRef = useRef(false)
  const lastSyncTimeRef = useRef(Date.now())

  const syncWorkspacePasswordsToCloud = useCallback(
    async (workspaceId: string) => {
      if (!firebaseUser || !workspaceId) return
      try {
        const db = getFirebaseFirestore()
        const wsDocRef = doc(db, WORKSPACES_COLLECTION, workspaceId)
        const wsSnap = await getDoc(wsDocRef)
        if (!wsSnap.exists()) return
        const wsData = wsSnap.data() as FirestoreWorkspaceDocument
        if (!isAuthorizedUser(firebaseUser.uid, wsData)) return

        const remotePasswords = Array.isArray(wsData.ws_passwords) ? wsData.ws_passwords : []
        const syncResult = await window.socialHub.syncWorkspaceCredentialsWithCloud(
          workspaceId,
          remotePasswords
        )
        if (syncResult && syncResult.remoteUpdated && Array.isArray(syncResult.mergedRecords)) {
          await syncWorkspacePasswords(
            firebaseUser,
            workspaceId,
            syncResult.mergedRecords,
            db
          )
        }
      } catch (err) {
        console.error(`[PASSWORDS][IMMEDIATE_SYNC][ERROR] Workspace: ${workspaceId}:`, err)
      }
    },
    [firebaseUser]
  )

  const syncFirebaseData = useCallback(async (user: FirebaseUser) => {
    try {
      console.log(`[AUTH][SYNC] Initiating synchronization pipeline for UID: ${user.uid}`)
      // 1. Sync User document (force=true ensures fresh login write is never skipped by debounce)
      const userDoc = await syncUserDocument(user, undefined, true)
      if (userDoc) {
        console.log(`[AUTH][SYNC] User document synchronized for UID: ${user.uid}`)
      }

      // 2. Discover and synchronize user-owned workspaces from Firestore
      const hubState = await window.socialHub.getState()
      const result = await syncUserWorkspaces(user, hubState.workspaces, hubState.accounts)
      if (result.synced) {
        // Reconcile workspaces (handles remote additions, remote deletions, and renames)
        await window.socialHub.reconcileRemoteWorkspaces(result.remoteWorkspaces || [])
        const validRemoteIds = (result.remoteWorkspaces || []).map((rw) => rw.ws_id)
        syncLocalWorkspaceOwnersWithRemote(validRemoteIds, user.uid)

        // Reconcile apps and passwords for each remote workspace
        for (const rw of result.remoteWorkspaces || []) {
          // Reconcile remote apps for workspace
          await window.socialHub.reconcileRemoteAccounts(rw.ws_id, rw.ws_apps || []).catch((err) => {
            console.warn(`[AUTH][APPS] Could not reconcile apps for workspace ${rw.ws_id}:`, err)
          })

          // Reconcile passwords for workspace
          const syncResult = await window.socialHub.syncWorkspaceCredentialsWithCloud(
            rw.ws_id,
            rw.ws_passwords || []
          ).catch((err) => {
            console.warn(`[AUTH][PASSWORDS] Could not sync credentials for workspace ${rw.ws_id}:`, err)
            return null
          })
          if (
            rw.ws_owner_id === user.uid &&
            syncResult &&
            syncResult.remoteUpdated &&
            Array.isArray(syncResult.mergedRecords)
          ) {
            await syncWorkspacePasswords(user, rw.ws_id, syncResult.mergedRecords).catch((err) => {
              console.warn(`[AUTH][PASSWORDS] Could not upload merged passwords for workspace ${rw.ws_id}:`, err)
            })
          }
        }

        const updatedState = await window.socialHub.getState()
        setState(updatedState)
        lastSyncTimeRef.current = Date.now()
        console.log(`[AUTH][SYNC] Workspace synchronization pipeline completed for UID: ${user.uid}`)
      } else {
        throw new Error('Failed to synchronize workspaces with Firestore.')
      }
    } catch (error) {
      console.error(`[AUTH][SYNC] Synchronization pipeline failed for UID: ${user.uid}:`, error)
      throw error
    }
  }, [])

  const handleManualRefresh = useCallback(async () => {
    if (!firebaseUser) return
    if (isRefreshingRef.current) return
    isRefreshingRef.current = true
    try {
      showToast('Refreshing workspaces from cloud...')
      await syncFirebaseData(firebaseUser)
      showToast('Cloud workspaces refreshed.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not refresh.')
    } finally {
      isRefreshingRef.current = false
    }
  }, [firebaseUser, syncFirebaseData, showToast])

  const handleWorkspaceSwitch = useCallback(
    async (workspaceId: string) => {
      try {
        setWorkspaceMenuOpen(false)
        setMobileSidebarOpen(false)
        setPasswordsOpen(false)
        setNotificationsOpen(false)
        await window.socialHub.activateWorkspace(workspaceId)
        if (firebaseUser) {
          const docData = await syncWorkspaceOnSwitch(firebaseUser, workspaceId)
          if (docData) {
            // Reconcile workspace name if remote changed
            if (docData.ws_name) {
              const currentWs = state.workspaces.find((w) => w.id === workspaceId)
              const cleanRemoteName = docData.ws_name.trim().slice(0, 40)
              if (currentWs && cleanRemoteName && currentWs.name !== cleanRemoteName) {
                await window.socialHub.renameWorkspace(workspaceId, cleanRemoteName).catch(() => {})
              }
            }
            // Reconcile apps for workspace
            await window.socialHub.reconcileRemoteAccounts(workspaceId, docData.ws_apps || []).catch(() => {})
            // Reconcile passwords for workspace
            const syncResult = await window.socialHub.syncWorkspaceCredentialsWithCloud(
              workspaceId,
              docData.ws_passwords || []
            ).catch(() => null)
            if (
              docData.ws_owner_id === firebaseUser.uid &&
              syncResult &&
              syncResult.remoteUpdated &&
              Array.isArray(syncResult.mergedRecords)
            ) {
              void syncWorkspacePasswords(firebaseUser, workspaceId, syncResult.mergedRecords)
            }
            const nextState = await window.socialHub.getState()
            setState(nextState)
          }
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not switch workspace.')
      }
    },
    [firebaseUser, showToast]
  )

  // Immediate password upload subscription (runs even when PasswordManager is closed)
  useEffect(() => {
    if (!firebaseUser) return
    const unsubscribe = window.socialHub.onPasswordsUpdated((payload) => {
      const targetWsId = payload?.workspaceId || state.activeWorkspaceId
      if (targetWsId) {
        void syncWorkspacePasswordsToCloud(targetWsId)
      }
    })
    return () => unsubscribe?.()
  }, [firebaseUser, state.activeWorkspaceId, syncWorkspacePasswordsToCloud])

  // Periodic fresh one-time read on window focus / reopen (with 20s debounce)
  useEffect(() => {
    const handleFocus = () => {
      if (!firebaseUser) return
      const now = Date.now()
      if (now - lastSyncTimeRef.current > 20000 && !isRefreshingRef.current) {
        lastSyncTimeRef.current = now
        void syncFirebaseData(firebaseUser).catch(() => {})
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [firebaseUser, syncFirebaseData])

  useEffect(() => {
    if (!sortMenuOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSortMenuOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [sortMenuOpen])

  useEffect(() => {
    try {
      return onAuthStateChanged(
        getFirebaseAuth(),
        async (user) => {
          if (user) {
            setFirebaseAuthChecked(false)
            try {
              await window.socialHub.setCurrentUser(user.uid)
              await syncFirebaseData(user)
            } catch (err) {
              console.error('[AUTH] Sync failed during auth change:', err)
              const fallback = await window.socialHub.getState()
              setState(fallback)
            } finally {
              setFirebaseUser(user)
              setFirebaseAuthChecked(true)
            }
          } else {
            resetUserSyncCache()
            const nextState = await window.socialHub.setCurrentUser(null)
            setState(nextState)
            setFirebaseUser(null)
            setFirebaseAuthChecked(true)
          }
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
  }, [showToast, syncFirebaseData])

  useEffect(() => {
    window.socialHub.setSidebarOverlay(
      Boolean(!firebaseUser || state.workspaces.length === 0 || dialog || menu || workspaceMenuOpen || notificationsOpen || passwordsOpen)
    )
    return () => window.socialHub.setSidebarOverlay(false)
  }, [firebaseUser, state.workspaces.length, dialog, menu, workspaceMenuOpen, notificationsOpen, passwordsOpen])

  const hasWorkspaces = state.workspaces.length > 0
  const activeWorkspace = hasWorkspaces
    ? (state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0])
    : null
  const currentWorkspaceId = activeWorkspace?.id ?? null
  const isActiveWorkspaceOwner =
    !activeWorkspace || !activeWorkspace.ownerId || !firebaseUser || activeWorkspace.ownerId === firebaseUser.uid

  // Whenever the active workspace is visited or switched by the authenticated user, update ws_at_last_visit
  useEffect(() => {
    if (firebaseUser && currentWorkspaceId) {
      void syncWorkspaceLastVisit(firebaseUser, currentWorkspaceId)
    }
  }, [firebaseUser, currentWorkspaceId])
  const accountSortBy = state.preferences.accountSortBy === 'lastUsed' ? 'lastUsed' : 'name'
  const workspaceAccounts = useMemo(() => {
    if (!activeWorkspace) return []
    const filtered = state.accounts.filter((account) => account.workspaceId === currentWorkspaceId)
    return [...filtered].sort((a, b) => {
      if (accountSortBy === 'lastUsed') {
        const aTime = typeof a.lastUsedAt === 'number' ? a.lastUsedAt : -1
        const bTime = typeof b.lastUsedAt === 'number' ? b.lastUsedAt : -1
        if (aTime !== bTime) return bTime - aTime
      }
      const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      if (nameCmp !== 0) return nameCmp
      const createdCmp = (a.createdAt || '').localeCompare(b.createdAt || '')
      if (createdCmp !== 0) return createdCmp
      return a.id.localeCompare(b.id)
    })
  }, [activeWorkspace, state.accounts, currentWorkspaceId, accountSortBy])

  const activeAccount = workspaceAccounts.find((a) => a.id === state.activeAccountId) ?? null
  const activeNavState = activeAccount ? navStatesByAccount[activeAccount.id] : undefined
  const activeNavUrl = activeNavState?.url || activeAccount?.url || ''

  useEffect(() => {
    const activeAccId = state.activeAccountId
    if (!activeAccId) return
    void window.socialHub.getNavState?.(activeAccId).then((navState) => {
      if (navState) {
        setNavStatesByAccount((prev) => ({ ...prev, [navState.accountId]: navState }))
      }
    }).catch(() => {})
  }, [state.activeAccountId])

  const unreadNotificationsCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  )

  const handleSelectAccount = useCallback((accountId: string) => {
    setMobileSidebarOpen(false)
    setPasswordsOpen(false)
    setNotificationsOpen(false)
    void window.socialHub.activateAccount(accountId).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not switch accounts.')
    })
  }, [showToast])

  const handleNotificationClick = async (notif: HubNotificationItem) => {
    try {
      if (!notif.read) {
        await window.socialHub.markNotificationRead(notif.id)
      }
      setNotificationsOpen(false)
      setPasswordsOpen(false)
      const targetAccount = state.accounts.find((a) => a.id === notif.accountId)
      if (!targetAccount) {
        showToast('Account no longer exists.')
        return
      }
      if (notif.workspaceId && notif.workspaceId !== state.activeWorkspaceId) {
        const targetWorkspace = state.workspaces.find((w) => w.id === notif.workspaceId)
        if (targetWorkspace) {
          await handleWorkspaceSwitch(targetWorkspace.id)
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
          handleSelectAccount(account.id)
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
      <header className="mobile-top-bar">
        <button
          type="button"
          className="mobile-menu-btn"
          aria-label="Open navigation drawer"
          onClick={() => setMobileSidebarOpen(true)}
        >
          <Menu size={18} />
        </button>
        <div className="mobile-top-title">
          <strong>{activeAccount ? activeAccount.name : activeWorkspace ? activeWorkspace.name : 'Social Hub'}</strong>
          {activeWorkspace && <span>{activeWorkspace.name}</span>}
        </div>
      </header>

      {mobileSidebarOpen && (
        <div
          className="mobile-drawer-backdrop"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside className={`sidebar ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
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
                <span className="workspace-name">{activeWorkspace ? activeWorkspace.name : 'No Workspaces'}</span>
                <span className="workspace-badge">{workspaceAccounts.length}</span>
              </div>
              <ChevronDown size={13} className={`chevron ${workspaceMenuOpen ? 'rotate' : ''}`} />
            </button>

            {workspaceMenuOpen && (
              <div className="workspace-menu" role="menu">
                <div className="workspace-menu-header">
                  <span>WORKSPACES</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {firebaseUser && (
                      <button
                        className="workspace-add-mini"
                        title="Refresh Workspaces from Cloud"
                        onClick={handleManualRefresh}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
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
                </div>

                <div className="workspace-items-list">
                  {state.workspaces.length === 0 ? (
                    <div className="workspace-menu-empty" style={{ padding: '14px 12px', textAlign: 'center', fontSize: '11px', color: 'var(--muted)' }}>
                      No workspaces created yet
                    </div>
                  ) : (
                    state.workspaces.map((ws) => {
                    const count = state.accounts.filter((a) => a.workspaceId === ws.id).length
                    const isActive = ws.id === currentWorkspaceId
                    const isWsOwner = !ws.ownerId || !firebaseUser || ws.ownerId === firebaseUser.uid
                    return (
                      <div
                        key={ws.id}
                        className={`workspace-menu-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          void handleWorkspaceSwitch(ws.id)
                        }}
                      >
                        <span className="ws-item-title">{ws.name}</span>
                        {!isWsOwner && <span className="ws-shared-pill">Shared</span>}
                        <span className="ws-item-count">{count}</span>
                        {isWsOwner && (
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
                        )}
                      </div>
                    )
                  })
                )}
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

        <section className="account-section" aria-label="Workspace apps">
          <div className="section-heading">
            <span>{activeWorkspace ? `${activeWorkspace.name.toUpperCase()} APPS` : 'YOUR APPS'}</span>
            {hasWorkspaces && (
              <div className="section-heading-actions">
                {activeWorkspace && isActiveWorkspaceOwner && firebaseUser && (
                  <button
                    type="button"
                    className="section-icon-btn"
                    onClick={() => setDialog({ kind: 'collaborators', workspace: activeWorkspace })}
                    title="Manage Collaborators"
                    aria-label="Manage Collaborators"
                  >
                    <UserPlus size={13} />
                  </button>
                )}
                <div className="account-sort-container">
                  <button
                    type="button"
                    className={`account-sort-trigger ${sortMenuOpen ? 'open' : ''}`}
                    onClick={() => setSortMenuOpen((open) => !open)}
                    title={`Sort apps (${accountSortBy === 'lastUsed' ? 'Last Used' : 'Name'})`}
                    aria-label="Sort apps"
                    aria-haspopup="menu"
                    aria-expanded={sortMenuOpen}
                  >
                    <ArrowUpDown size={12} />
                  </button>
                {sortMenuOpen && (
                  <div className="account-sort-menu" role="menu" aria-label="App sorting options">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={accountSortBy === 'name'}
                      className={accountSortBy === 'name' ? 'selected' : ''}
                      onClick={() => {
                        void setPreference('accountSortBy', 'name')
                        setSortMenuOpen(false)
                      }}
                    >
                      <span>Name</span>
                      {accountSortBy === 'name' && <Check size={12} />}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={accountSortBy === 'lastUsed'}
                      className={accountSortBy === 'lastUsed' ? 'selected' : ''}
                      onClick={() => {
                        void setPreference('accountSortBy', 'lastUsed')
                        setSortMenuOpen(false)
                      }}
                    >
                      <span>Last Used</span>
                      {accountSortBy === 'lastUsed' && <Check size={12} />}
                    </button>
                  </div>
                )}
                </div>
              </div>
            )}
          </div>

          <nav className="account-list">
            {!hasWorkspaces ? (
              <div className="workspace-empty-state">
                <p>No workspace created yet</p>
                <button
                  className="add-account-empty"
                  onClick={() => {
                    setWorkspaceMenuOpen(false)
                    setDialog({ kind: 'add-workspace' })
                  }}
                >
                  <Plus size={13} /> Create Workspace
                </button>
              </div>
            ) : workspaceAccounts.length === 0 ? (
              <div className="workspace-empty-state">
                <p>{isActiveWorkspaceOwner ? 'No apps in this workspace' : 'No apps shared in this workspace'}</p>
                {isActiveWorkspaceOwner && (
                  <button className="add-account-empty" onClick={() => void addAccount()}>
                    <Plus size={13} /> Add an app
                  </button>
                )}
              </div>
            ) : (
              workspaceAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  active={account.id === state.activeAccountId}
                  onSelect={() => handleSelectAccount(account.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ id: account.id, x: Math.min(event.clientX, window.innerWidth - 230), y: event.clientY })
                  }}
                />
              ))
            )}
          </nav>

          {hasWorkspaces && workspaceAccounts.length > 0 && isActiveWorkspaceOwner && (
            <button className="add-account" onClick={() => void addAccount()}>
              <span className="add-icon"><Plus size={16} /></span>
              <span>Add an app</span>
              <kbd>⌘ N</kbd>
            </button>
          )}
        </section>

        <section className="privacy-card">
          <div className="privacy-icon"><ShieldCheck size={17} /></div>
          <div>
            <strong>Private by design</strong>
            <p>Each app has its own secure browser session.</p>
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
            onClick={() => {
              setPasswordsOpen(false)
              setNotificationsOpen((open) => !open)
            }}
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
            className={`sidebar-nav-item passwords-nav-btn ${passwordsOpen ? 'active' : ''}`}
            onClick={() => {
              setNotificationsOpen(false)
              setPasswordsOpen((open) => !open)
            }}
            aria-haspopup="dialog"
            aria-expanded={passwordsOpen}
          >
            <span className="nav-item-left">
              <KeyRound size={15} />
              <span>Passwords</span>
            </span>
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

      {hasWorkspaces && activeAccount && activeNavState?.hasTemporaryView && !notificationsOpen && !passwordsOpen && (
        <div className="browser-nav-bar" role="toolbar" aria-label="Account navigation controls">
          <div className="browser-nav-actions">
            <button
              type="button"
              className="browser-nav-btn"
              onClick={() => void window.socialHub.navBack(activeAccount.id)}
              disabled={!activeNavState?.canGoBack}
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className="browser-nav-btn"
              onClick={() => void window.socialHub.navForward(activeAccount.id)}
              disabled={!activeNavState?.canGoForward}
              title="Forward"
              aria-label="Forward"
            >
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              className="browser-nav-btn"
              onClick={() => {
                if (activeNavState?.isLoading) {
                  void window.socialHub.navStop(activeAccount.id)
                } else {
                  void window.socialHub.reloadAccount(activeAccount.id)
                }
              }}
              title={activeNavState?.isLoading ? 'Stop loading' : 'Refresh'}
              aria-label={activeNavState?.isLoading ? 'Stop loading' : 'Refresh'}
            >
              {activeNavState?.isLoading ? <X size={14} /> : <RefreshCw size={13} />}
            </button>
          </div>
          <div className="browser-nav-url" title={activeNavUrl}>
            <span>{activeNavUrl}</span>
          </div>
          <div className="browser-nav-right">
            <button
              type="button"
              className={`browser-nav-copy-btn ${copiedLinkAccountId === activeAccount.id ? 'copied' : ''}`}
              onClick={() => void handleCopyAccountLink(activeAccount.id)}
              title={copiedLinkAccountId === activeAccount.id ? 'Copied!' : 'Copy current link'}
              aria-label="Copy current link"
            >
              {copiedLinkAccountId === activeAccount.id ? (
                <>
                  <Check size={13} />
                  <span className="browser-nav-copied-label">Copied</span>
                </>
              ) : (
                <Link size={14} />
              )}
            </button>
          </div>
        </div>
      )}

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

      {isAndroid && hasWorkspaces && !notificationsOpen && !passwordsOpen && (
        <section className="android-account-placeholder" aria-label="Android Account Browser Placeholder">
          <div className="android-placeholder-card">
            <div className="android-placeholder-badge">Android Phase 1 Foundation</div>
            <h2>{activeAccount ? activeAccount.name : activeWorkspace?.name || 'Workspace Ready'}</h2>
            {activeAccount ? (
              <>
                <p className="android-placeholder-meta">
                  {resolvePlatformName(activeAccount.appId, activeAccount.url)} • {activeAccount.url}
                </p>
                <p className="android-placeholder-note">
                  Embedded account browser sessions (Electron WebContentsView / persist:account-*) require a dedicated native Android WebView implementation (planned for Phase 2).
                </p>
              </>
            ) : (
              <p className="android-placeholder-note">
                Select or add an account from the navigation drawer. Workspaces and Firestore collaboration are active; native Android account WebView sessions will be added in Phase 2.
              </p>
            )}
          </div>
        </section>
      )}

      {!hasWorkspaces && !notificationsOpen && !passwordsOpen && (
        <div className="workspace-hero-empty" role="region" aria-label="No workspaces created">
          <div className="workspace-hero-card">
            <div className="workspace-hero-icon">
              <Layers size={32} />
            </div>
            <h2>No Workspaces Yet</h2>
            <p>
              Workspaces keep your social, messaging, and work accounts neatly organized with isolated browser sessions. Create your first workspace to get started.
            </p>
            <button
              className="workspace-hero-btn"
              onClick={() => {
                setWorkspaceMenuOpen(false)
                setDialog({ kind: 'add-workspace' })
              }}
            >
              <Plus size={16} />
              <span>Create Workspace</span>
            </button>
          </div>
        </div>
      )}

      {passwordsOpen && (
        <PasswordManager
          user={firebaseUser}
          workspaces={state.workspaces}
          onClose={() => setPasswordsOpen(false)}
          showToast={showToast}
        />
      )}

      {menu && (
        <AccountContextMenu
          account={state.accounts.find((account) => account.id === menu.id)}
          x={menu.x}
          y={menu.y}
          isWorkspaceOwner={isActiveWorkspaceOwner}
          onEdit={(account) => {
            setMenu(null)
            setDialog({ kind: 'edit', account })
          }}
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
          firebaseUser={firebaseUser}
          showToast={showToast}
          onCollaborationChanged={() => {
            if (firebaseUser) void syncFirebaseData(firebaseUser)
          }}
          onClose={() => setDialog(null)}
          onSubmitAccount={(name, appId, url, workspaceId) => void submitAccount(name, appId, url, workspaceId)}
          onSubmitEditAccount={(accountId, name, url) => void submitEditAccount(accountId, name, url)}
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
              const target = dialog.account
              void invoke(async () => {
                await window.socialHub.removeAccount(target.id)
                if (firebaseUser) {
                  void syncAccountRemoval(firebaseUser, target.workspaceId, target.id)
                }
              }, 'App removed.')
              setDialog(null)
            } else if (dialog.kind === 'confirm-cache') {
              void invoke(() => window.socialHub.clearCache(dialog.account.id), 'Cache cleared.')
              setDialog(null)
            } else if (dialog.kind === 'delete-workspace') {
              void submitDeleteWorkspace(dialog.workspace.id)
            }
          }}
          onConfirmLogout={(logoutConnectedApps) => {
            setDialog(null)
            void handleLogout(logoutConnectedApps)
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
  firebaseUser,
  showToast,
  onCollaborationChanged,
  onClose,
  onSubmitAccount,
  onSubmitEditAccount,
  onSubmitAddWorkspace,
  onSubmitRenameWorkspace,
  onSubmitPermissions,
  onSubmitGlobalPermissions,
  onResetGlobalPermissions,
  onConfirm,
  onConfirmLogout
}: {
  dialog: Exclude<EditorDialog, null>
  workspaces: Workspace[]
  accounts: Account[]
  activeWorkspaceId: string | null
  globalDefaults: AccountPermissions
  firebaseUser: FirebaseUser | null
  showToast: (message: string) => void
  onCollaborationChanged: () => void
  onClose: () => void
  onSubmitAccount: (name: string, appId?: string, url?: string, workspaceId?: string) => void
  onSubmitEditAccount: (accountId: string, name: string, url: string) => void
  onSubmitAddWorkspace: (name: string) => void
  onSubmitRenameWorkspace: (id: string, name: string) => void
  onSubmitPermissions: (permissions: AccountPermissions) => Promise<void>
  onSubmitGlobalPermissions: (permissions: AccountPermissions) => Promise<void>
  onResetGlobalPermissions: () => Promise<AccountPermissions>
  onConfirm: () => void
  onConfirmLogout: (logoutConnectedApps: boolean) => void
}) {
  const [appMode, setAppMode] = useState<'app' | 'custom'>('app')
  const [logoutConnectedApps, setLogoutConnectedApps] = useState(false)

  useEffect(() => {
    if (dialog.kind === 'confirm-logout') {
      setLogoutConnectedApps(false)
    }
  }, [dialog.kind])

  if (dialog.kind === 'collaborators') {
    return (
      <CollaboratorsModal
        workspace={dialog.workspace}
        firebaseUser={firebaseUser}
        showToast={showToast}
        onCollaborationChanged={onCollaborationChanged}
        onClose={onClose}
      />
    )
  }

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

  if (dialog.kind === 'edit') {
    return (
      <div className="dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <form className="hub-dialog" onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const name = formData.get('account-name')
          const url = formData.get('website-url')
          if (typeof name !== 'string' || !name.trim()) return
          if (typeof url !== 'string' || !url.trim()) return
          onSubmitEditAccount(dialog.account.id, name.trim(), url.trim())
        }}>
          <h2>Edit app</h2>
          <p>Update the name or website URL for this app.</p>

          <label htmlFor="edit-account-name">App name</label>
          <input
            id="edit-account-name"
            name="account-name"
            maxLength={40}
            required
            autoFocus
            defaultValue={dialog.account.name}
            placeholder="e.g. Personal"
          />

          <label htmlFor="edit-website-url">Website URL</label>
          <input
            id="edit-website-url"
            name="website-url"
            type="url"
            required
            defaultValue={dialog.account.url}
            placeholder="https://example.com"
          />

          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="dialog-primary">Save changes</button>
          </div>
        </form>
      </div>
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
          <h2>{rename ? 'Rename app' : 'Add an app'}</h2>
          <p>{rename ? 'Choose a name for this app.' : 'Choose an app or add any secure website. Each app gets its own login session.'}</p>
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
          <label htmlFor="account-name">App name</label>
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
          <p>{isRename ? 'Choose a new name for this workspace.' : 'Create a new workspace to group your apps.'}</p>
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

    if (accountCount > 0) {
      return (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}>
          <section className="hub-dialog" role="alertdialog" aria-modal="true">
            <h2>Cannot delete workspace</h2>
            <p>
              “{dialog.workspace.name}” contains {accountCount} app{accountCount === 1 ? '' : 's'}. You must remove or move all apps before this workspace can be deleted.
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
        <section className="hub-dialog" role="alertdialog" aria-modal="true" aria-labelledby="logout-dialog-title">
          <h2 id="logout-dialog-title">Log out of Social HUB?</h2>
          <p>
            You will stop receiving notifications and incoming-call alerts from your connected apps.
          </p>
          <label className="logout-checkbox-row">
            <input
              type="checkbox"
              checked={logoutConnectedApps}
              onChange={(event) => setLogoutConnectedApps(event.target.checked)}
            />
            <span>Also log out of all connected apps</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="dialog-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="dialog-danger" onClick={() => onConfirmLogout(logoutConnectedApps)}>
              Log Out
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
        <h2>{remove ? 'Remove app?' : 'Clear app cache?'}</h2>
        <p>
          {remove
            ? `“${dialog.account.name}” and its saved site session data will be permanently deleted.`
            : `Cached files for “${dialog.account.name}” will be deleted. Your login data will be kept.`}
        </p>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className={remove ? 'dialog-danger' : 'dialog-primary'} onClick={onConfirm}>
            {remove ? 'Remove app' : 'Clear cache'}
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
  isWorkspaceOwner,
  onEdit,
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
  isWorkspaceOwner: boolean
  onEdit: (account: Account) => void
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
      {isWorkspaceOwner && <button onClick={() => onEdit(account)}><Pencil size={14} />Edit app</button>}
      {isWorkspaceOwner && <button onClick={() => onRename(account)}>Rename app</button>}
      <button onClick={() => onMute(account)}>{account.muted ? <Volume2 size={14} /> : <VolumeX size={14} />}{account.muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={() => onReload(account)}><RefreshCw size={14} />Reload</button>
      <button onClick={() => onClearCache(account)}>Clear cache</button>
      <button onClick={() => onPermissions(account)}><Shield size={14} />Permissions</button>
      {isWorkspaceOwner && (
        <>
          <hr />
          <button className="danger" onClick={() => onRemove(account)}><Trash2 size={14} />Remove account</button>
        </>
      )}
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

function CollaboratorsModal({
  workspace,
  firebaseUser,
  showToast,
  onCollaborationChanged,
  onClose
}: {
  workspace: Workspace
  firebaseUser: FirebaseUser | null
  showToast: (message: string) => void
  onCollaborationChanged: () => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState<WorkspaceCollaborationDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [emailInput, setEmailInput] = useState('')
  const [confirmRemoveUid, setConfirmRemoveUid] = useState<string | null>(null)

  const loadDetails = useCallback(async () => {
    if (!firebaseUser) {
      setError('You must be signed in to manage collaborators.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await fetchWorkspaceCollaborationDetails(firebaseUser, workspace.id)
      setDetails(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load collaborators.')
    } finally {
      setLoading(false)
    }
  }, [firebaseUser, workspace.id])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  const isOwner = Boolean(firebaseUser && details && details.ownerId === firebaseUser.uid)

  const handleAddCollaboratorSubmit = async () => {
    if (busy || !firebaseUser) return
    setError(null)
    setSuccess(null)

    const trimmed = emailInput.trim()
    if (!isValidCollaboratorEmail(trimmed)) {
      setError('Please enter a valid email address.')
      return
    }

    setBusy(true)
    try {
      const found = await findRegisteredUserByEmail(trimmed)
      if (!found) {
        setError('No registered Social HUB user found with this email address.')
        return
      }
      if (details && found.user_id === details.ownerId) {
        setError('This user is the owner of this workspace.')
        return
      }
      if (details && details.rawUserIds.includes(found.user_id)) {
        setError('This user is already a collaborator in this workspace.')
        return
      }

      const res = await addWorkspaceCollaborator(firebaseUser, workspace.id, found.user_id)
      if (!res.added) {
        setError(res.message)
        return
      }
      setEmailInput('')
      setSuccess('Collaborator added successfully.')
      showToast(`${found.user_name || found.user_email} added as collaborator.`)
      await loadDetails()
      onCollaborationChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while updating workspace collaborators.')
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmRemove = async (collaborator: WorkspaceCollaboratorProfile) => {
    if (busy || !firebaseUser) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await removeWorkspaceCollaborator(firebaseUser, workspace.id, collaborator.user_id)
      if (!res.removed) {
        setError(res.message)
        return
      }
      setConfirmRemoveUid(null)
      setSuccess(res.message)
      showToast(`${collaborator.user_name || collaborator.user_email} removed from workspace.`)
      await loadDetails()
      onCollaborationChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove collaborator.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section className="hub-dialog collab-dialog" role="dialog" aria-modal="true" aria-label="Workspace collaborators">
        <h2>Collaborators — {workspace.name}</h2>
        <p>Manage who can access this workspace and its apps.</p>

        {error && <div className="collab-feedback error" role="alert">{error}</div>}
        {success && <div className="collab-feedback success" role="status">{success}</div>}

        {loading ? (
          <div className="collab-loading">
            <Loader2 size={15} className="spin-icon" />
            <span>Loading workspace members...</span>
          </div>
        ) : (
          <>
            {/* Section A – Workspace Owner */}
            <div className="collab-section">
              <div className="collab-section-title">
                <span>Workspace Owner</span>
              </div>
              {details?.owner ? (
                <div className="collab-row owner-row">
                  <div className="collab-user-info">
                    <div className="collab-avatar">
                      {details.owner.user_dp_link ? (
                        <img src={details.owner.user_dp_link} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        <UserIcon size={14} />
                      )}
                    </div>
                    <div className="collab-user-text">
                      <span className="collab-user-name">{details.owner.user_name}</span>
                      <span className="collab-user-email">{details.owner.user_email || details.ownerId}</span>
                    </div>
                  </div>
                  <span className="collab-owner-badge">OWNER</span>
                </div>
              ) : (
                <div className="collab-empty">Owner profile unavailable.</div>
              )}
            </div>

            {/* Section B – Existing Collaborators */}
            <div className="collab-section">
              <div className="collab-section-title">
                <span>Collaborators ({details?.collaborators.length ?? 0})</span>
              </div>
              {!details || details.collaborators.length === 0 ? (
                <div className="collab-empty">No collaborators added yet.</div>
              ) : (
                <div className="collab-list" role="list">
                  {details.collaborators.map((collab) => {
                    const isConfirming = confirmRemoveUid === collab.user_id
                    return (
                      <div key={collab.user_id} className="collab-row" role="listitem">
                        <div className="collab-user-info">
                          <div className="collab-avatar">
                            {collab.user_dp_link ? (
                              <img src={collab.user_dp_link} alt="" referrerPolicy="no-referrer" />
                            ) : (
                              <UserIcon size={14} />
                            )}
                          </div>
                          <div className="collab-user-text">
                            <span className="collab-user-name">{collab.user_name}</span>
                            <span className="collab-user-email">{collab.user_email || collab.user_id}</span>
                          </div>
                        </div>
                        {isOwner && (
                          isConfirming ? (
                            <div className="collab-confirm-actions">
                              <button
                                type="button"
                                className="collab-mini-btn"
                                disabled={busy}
                                onClick={() => setConfirmRemoveUid(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="collab-mini-btn danger"
                                disabled={busy}
                                onClick={() => void handleConfirmRemove(collab)}
                              >
                                {busy ? 'Removing...' : 'Confirm'}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="collab-remove-btn"
                              disabled={busy}
                              onClick={() => {
                                setError(null)
                                setSuccess(null)
                                setConfirmRemoveUid(collab.user_id)
                              }}
                            >
                              Remove
                            </button>
                          )
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Add Collaborator Flow (Owner Only) */}
            {isOwner && (
              <div className="collab-section">
                <div className="collab-add-box">
                  <label htmlFor="collab-email-input">Add collaborator by email</label>
                  <div className="collab-input-row">
                    <input
                      id="collab-email-input"
                      type="email"
                      value={emailInput}
                      disabled={busy}
                      autoFocus
                      placeholder="colleague@example.com"
                      onChange={(e) => {
                        setEmailInput(e.target.value)
                        if (error) setError(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleAddCollaboratorSubmit()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="collab-add-btn"
                      disabled={busy || !emailInput.trim()}
                      onClick={() => void handleAddCollaboratorSubmit()}
                    >
                      {busy ? <Loader2 size={13} className="spin-icon" /> : <UserPlus size={13} />}
                      <span>{busy ? 'Adding...' : 'Add'}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  )
}
