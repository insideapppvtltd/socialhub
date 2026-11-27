import { Capacitor } from '@capacitor/core'
import { Preferences as CapacitorPreferences } from '@capacitor/preferences'
import type { SocialHubAPI } from '../../preload/index'
import {
  DEFAULT_ACCOUNT_PERMISSIONS,
  type Account,
  type HubState,
  type Preferences,
  type Workspace
} from '../../main/types'
import { CUSTOM_APP_ID, getCatalogApp } from '../../shared/apps'

const ANDROID_STATE_KEY = 'socialhub_android_state_v1'

interface StoredAndroidState {
  currentUserUid: string | null
  workspaces: Workspace[]
  workspaceOwners: Record<string, string>
  activeUserWorkspaceMap: Record<string, string>
  accounts: Account[]
  activeAccountId: string | null
  preferences: Preferences
}

const DEFAULT_PREFERENCES: Preferences = {
  doNotDisturb: false,
  minimizeToTray: true,
  launchAtStartup: false,
  theme: 'system',
  accountSortBy: 'name'
}

const ACCOUNT_COLORS = ['#189259', '#0e7490', '#6d28d9', '#be185d', '#b45309', '#1d4ed8']

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __electronSocialHub?: boolean }).__electronSocialHub)
}

export function isAndroidRuntime(): boolean {
  if (typeof window === 'undefined') return false
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return true
  return !isElectronRuntime() && /android/i.test(navigator.userAgent || '')
}

function createDefaultStoredState(): StoredAndroidState {
  return {
    currentUserUid: null,
    workspaces: [],
    workspaceOwners: {},
    activeUserWorkspaceMap: {},
    accounts: [],
    activeAccountId: null,
    preferences: { ...DEFAULT_PREFERENCES }
  }
}

function unsupportedAndroidError(feature: string): Error {
  return new Error(`${feature} is not supported on Android yet (pending Phase 2 native implementation).`)
}

export function createAndroidHubBridge(): SocialHubAPI {
  let memState: StoredAndroidState = createDefaultStoredState()
  let loaded = false
  const stateListeners = new Set<(state: HubState) => void>()

  const loadState = async (): Promise<StoredAndroidState> => {
    if (loaded) return memState
    try {
      const { value } = await CapacitorPreferences.get({ key: ANDROID_STATE_KEY })
      if (value) {
        const parsed = JSON.parse(value) as Partial<StoredAndroidState>
        memState = {
          ...createDefaultStoredState(),
          ...parsed,
          preferences: {
            ...DEFAULT_PREFERENCES,
            ...(parsed.preferences || {})
          }
        }
      }
    } catch (err) {
      console.warn('[ANDROID][STORAGE] Could not load preferences:', err)
    }
    loaded = true
    return memState
  }

  const saveState = async (): Promise<void> => {
    try {
      await CapacitorPreferences.set({
        key: ANDROID_STATE_KEY,
        value: JSON.stringify(memState)
      })
    } catch (err) {
      console.warn('[ANDROID][STORAGE] Could not persist preferences:', err)
    }
  }

  const listUserWorkspaces = (): Workspace[] => {
    const uid = memState.currentUserUid
    if (!uid) return []
    return memState.workspaces.filter(
      (w) =>
        w.ownerId === uid ||
        memState.workspaceOwners[w.id] === uid ||
        (Array.isArray(w.memberIds) && w.memberIds.includes(uid))
    )
  }

  const getActiveWorkspaceId = (): string | null => {
    const uid = memState.currentUserUid
    if (!uid) return null
    const userWs = listUserWorkspaces()
    const mapped = memState.activeUserWorkspaceMap[uid]
    if (mapped && userWs.some((w) => w.id === mapped)) return mapped
    const fallback = userWs[0]?.id ?? null
    if (fallback) {
      memState.activeUserWorkspaceMap[uid] = fallback
    }
    return fallback
  }

  const toHubState = (): HubState => {
    const userWs = listUserWorkspaces()
    const allowedWsIds = new Set(userWs.map((w) => w.id))
    const accounts = memState.accounts.filter((a) => allowedWsIds.has(a.workspaceId))
    const activeWorkspaceId = getActiveWorkspaceId()
    const activeAccountId =
      memState.activeAccountId && accounts.some((a) => a.id === memState.activeAccountId)
        ? memState.activeAccountId
        : null
    return {
      workspaces: userWs,
      activeWorkspaceId,
      accounts,
      activeAccountId,
      preferences: { ...memState.preferences },
      globalDefaultPermissions: { ...DEFAULT_ACCOUNT_PERMISSIONS }
    }
  }

  const emitState = () => {
    const next = toHubState()
    for (const listener of stateListeners) {
      try {
        listener(next)
      } catch {
        // ignore listener error
      }
    }
  }

  return {
    async setCurrentUser(uid) {
      await loadState()
      memState.currentUserUid = uid ? uid.trim() : null
      await saveState()
      const state = toHubState()
      emitState()
      return state
    },

    async claimWorkspaces(uid, workspaceIds) {
      await loadState()
      for (const wsId of workspaceIds) {
        memState.workspaceOwners[wsId] = uid
        const idx = memState.workspaces.findIndex((w) => w.id === wsId)
        if (idx >= 0 && !memState.workspaces[idx].ownerId) {
          memState.workspaces[idx] = { ...memState.workspaces[idx], ownerId: uid }
        }
      }
      await saveState()
      emitState()
      return true
    },

    async reconcileRemoteWorkspaces(remoteWorkspaces) {
      await loadState()
      const uid = memState.currentUserUid
      if (!uid) return { added: [], removed: [], updated: [] }
      const list = remoteWorkspaces as Array<{
        ws_id: string
        ws_name: string
        ws_owner_id: string
        ws_users_ids?: string[]
      }>
      const added: string[] = []
      const removed: string[] = []
      const updated: string[] = []
      const remoteMap = new Map(list.filter((r) => r.ws_id).map((r) => [r.ws_id, r]))
      const modified = [...memState.workspaces]

      for (const rw of remoteMap.values()) {
        const remoteOwner = (rw.ws_owner_id || uid).trim()
        memState.workspaceOwners[rw.ws_id] = remoteOwner
        const remoteMembers = Array.isArray(rw.ws_users_ids)
          ? rw.ws_users_ids.map((id) => String(id).trim()).filter(Boolean)
          : [remoteOwner]
        const idx = modified.findIndex((w) => w.id === rw.ws_id)
        if (idx >= 0) {
          const existing = modified[idx]
          const cleanName = (rw.ws_name || '').trim().slice(0, 40)
          const nextName = cleanName || existing.name
          const membersChanged = JSON.stringify(existing.memberIds || []) !== JSON.stringify(remoteMembers)
          const ownerChanged = existing.ownerId !== remoteOwner
          if (nextName !== existing.name || membersChanged || ownerChanged) {
            modified[idx] = {
              ...existing,
              name: nextName,
              ownerId: remoteOwner,
              memberIds: remoteMembers,
              syncedToCloud: true
            }
            updated.push(rw.ws_id)
          }
        } else {
          modified.push({
            id: rw.ws_id,
            name: (rw.ws_name || '').trim().slice(0, 40) || 'Workspace',
            createdAt: new Date().toISOString(),
            ownerId: remoteOwner,
            memberIds: remoteMembers,
            syncedToCloud: true
          })
          added.push(rw.ws_id)
        }
      }

      const toKeep: Workspace[] = []
      for (const lw of modified) {
        const isUserWs =
          lw.ownerId === uid ||
          memState.workspaceOwners[lw.id] === uid ||
          (Array.isArray(lw.memberIds) && lw.memberIds.includes(uid))
        if (isUserWs && !remoteMap.has(lw.id)) {
          removed.push(lw.id)
          delete memState.workspaceOwners[lw.id]
        } else {
          toKeep.push(lw)
        }
      }
      memState.workspaces = toKeep
      if (removed.length > 0) {
        const removedSet = new Set(removed)
        memState.accounts = memState.accounts.filter((a) => !removedSet.has(a.workspaceId))
      }
      await saveState()
      emitState()
      return { added, removed, updated }
    },

    async reconcileRemoteAccounts(workspaceId, remoteAccounts) {
      await loadState()
      const list = remoteAccounts as Array<{ ws_app_id: string; ws_app_name: string; ws_app_link: string }>
      const added: string[] = []
      const removed: string[] = []
      const updated: string[] = []
      const remoteMap = new Map(list.filter((a) => a.ws_app_id).map((a) => [a.ws_app_id, a]))
      const nextAccounts: Account[] = []

      for (const localAcc of memState.accounts) {
        if (localAcc.workspaceId !== workspaceId) {
          nextAccounts.push(localAcc)
          continue
        }
        const remote = remoteMap.get(localAcc.id)
        if (remote) {
          const nextName = remote.ws_app_name?.trim() || localAcc.name
          const nextUrl = remote.ws_app_link?.trim() || localAcc.url
          if (nextName !== localAcc.name || nextUrl !== localAcc.url || !localAcc.syncedToCloud) {
            nextAccounts.push({ ...localAcc, name: nextName, url: nextUrl, syncedToCloud: true })
            if (nextName !== localAcc.name || nextUrl !== localAcc.url) updated.push(localAcc.id)
          } else {
            nextAccounts.push(localAcc)
          }
        } else if (localAcc.syncedToCloud) {
          removed.push(localAcc.id)
        } else {
          nextAccounts.push(localAcc)
        }
      }

      for (const remote of remoteMap.values()) {
        if (!nextAccounts.some((a) => a.id === remote.ws_app_id && a.workspaceId === workspaceId)) {
          const appId = CUSTOM_APP_ID
          nextAccounts.push({
            id: remote.ws_app_id,
            workspaceId,
            name: remote.ws_app_name?.trim() || 'App',
            appId,
            url: remote.ws_app_link?.trim() || 'https://google.com',
            color: ACCOUNT_COLORS[nextAccounts.length % ACCOUNT_COLORS.length],
            muted: false,
            createdAt: new Date().toISOString(),
            unread: 0,
            permissions: { ...DEFAULT_ACCOUNT_PERMISSIONS },
            syncedToCloud: true
          })
          added.push(remote.ws_app_id)
        }
      }

      memState.accounts = nextAccounts
      await saveState()
      if (added.length || removed.length || updated.length) emitState()
      return { added, removed, updated }
    },

    async markAccountSynced(accountId) {
      await loadState()
      const idx = memState.accounts.findIndex((a) => a.id === accountId)
      if (idx < 0) return false
      memState.accounts[idx] = { ...memState.accounts[idx], syncedToCloud: true }
      await saveState()
      return true
    },

    async markWorkspaceSynced(workspaceId) {
      await loadState()
      const idx = memState.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx < 0) return false
      memState.workspaces[idx] = { ...memState.workspaces[idx], syncedToCloud: true }
      await saveState()
      return true
    },

    async getState() {
      await loadState()
      return toHubState()
    },

    async getGoogleAuthToken() {
      throw new Error(
        'Google Sign-In on Android requires native Capacitor Google Auth (pending Phase 2). Please use Anonymous Sign-In for Android Phase 1 testing.'
      )
    },

    async cancelGoogleAuth() {
      throw unsupportedAndroidError('Google Sign-In cancellation')
    },

    async addAccount(input) {
      await loadState()
      const targetWs = input.workspaceId ?? getActiveWorkspaceId()
      if (!targetWs) throw new Error('Selected workspace does not exist.')
      const catalog = input.appId !== CUSTOM_APP_ID ? getCatalogApp(input.appId) : undefined
      const url = input.url || catalog?.url || 'https://google.com'
      const account: Account = {
        id: randomId(),
        workspaceId: targetWs,
        name: input.name.trim().slice(0, 40),
        appId: input.appId,
        url,
        color: ACCOUNT_COLORS[memState.accounts.length % ACCOUNT_COLORS.length],
        muted: false,
        createdAt: new Date().toISOString(),
        unread: 0,
        permissions: { ...DEFAULT_ACCOUNT_PERMISSIONS },
        syncedToCloud: false
      }
      memState.accounts.push(account)
      memState.activeAccountId = account.id
      await saveState()
      emitState()
      return account
    },

    async activateAccount(id) {
      await loadState()
      memState.activeAccountId = id || null
      if (id) {
        const idx = memState.accounts.findIndex((a) => a.id === id)
        if (idx >= 0) {
          memState.accounts[idx] = { ...memState.accounts[idx], lastUsedAt: Date.now() }
        }
      }
      await saveState()
      emitState()
    },

    async renameAccount(id, name) {
      await loadState()
      const idx = memState.accounts.findIndex((a) => a.id === id)
      if (idx < 0) throw new Error('Account not found.')
      const updated = { ...memState.accounts[idx], name: name.trim().slice(0, 40) }
      memState.accounts[idx] = updated
      await saveState()
      emitState()
      return updated
    },

    async updateAccount(id, updates) {
      await loadState()
      const idx = memState.accounts.findIndex((a) => a.id === id)
      if (idx < 0) throw new Error('Account not found.')
      const current = memState.accounts[idx]
      const nextUrl = updates.url ? updates.url.trim() : current.url
      const updated: Account = {
        ...current,
        name: updates.name ? updates.name.trim().slice(0, 40) : current.name,
        url: nextUrl
      }
      memState.accounts[idx] = updated
      await saveState()
      emitState()
      return updated
    },

    async setMuted() {
      throw unsupportedAndroidError('Account muting')
    },

    async setAccountPermissions() {
      throw unsupportedAndroidError('Account permissions')
    },

    async getGlobalDefaultPermissions() {
      return { ...DEFAULT_ACCOUNT_PERMISSIONS }
    },

    async updateGlobalDefaultPermissions() {
      throw unsupportedAndroidError('Global default permissions')
    },

    async resetGlobalDefaultPermissions() {
      throw unsupportedAndroidError('Global default permissions')
    },

    async reloadAccount() {
      throw unsupportedAndroidError('Account WebView reload')
    },

    async navBack() {
      throw unsupportedAndroidError('External browser navigation')
    },

    async navForward() {
      throw unsupportedAndroidError('External browser navigation')
    },

    async navStop() {
      throw unsupportedAndroidError('External browser navigation')
    },

    async navCopyUrl() {
      throw unsupportedAndroidError('Account URL copy')
    },

    async getNavState() {
      return null
    },

    onNavState() {
      return () => {}
    },

    async clearCache() {
      throw unsupportedAndroidError('Account cache clearing')
    },

    async removeAccount(id) {
      await loadState()
      memState.accounts = memState.accounts.filter((a) => a.id !== id)
      if (memState.activeAccountId === id) memState.activeAccountId = null
      await saveState()
      emitState()
    },

    async updatePreferences(partial) {
      await loadState()
      memState.preferences = { ...memState.preferences, ...partial }
      await saveState()
      emitState()
      return { ...memState.preferences }
    },

    setSidebarOverlay() {
      // No-op on Android (no Electron WebContentsView overlay)
    },

    onState(callback) {
      stateListeners.add(callback)
      return () => {
        stateListeners.delete(callback)
      }
    },

    onDownload() {
      return () => {}
    },

    onAddAccountShortcut() {
      return () => {}
    },

    async addWorkspace(name) {
      await loadState()
      const uid = memState.currentUserUid
      if (!uid) throw new Error('No user logged in.')
      const ws: Workspace = {
        id: randomId(),
        name: name.trim().slice(0, 40),
        createdAt: new Date().toISOString(),
        ownerId: uid,
        memberIds: [uid],
        syncedToCloud: false
      }
      memState.workspaces.push(ws)
      memState.workspaceOwners[ws.id] = uid
      memState.activeUserWorkspaceMap[uid] = ws.id
      await saveState()
      emitState()
      return ws
    },

    async renameWorkspace(id, name) {
      await loadState()
      const idx = memState.workspaces.findIndex((w) => w.id === id)
      if (idx < 0) throw new Error('Workspace not found.')
      const updated = { ...memState.workspaces[idx], name: name.trim().slice(0, 40) }
      memState.workspaces[idx] = updated
      await saveState()
      emitState()
      return updated
    },

    async deleteWorkspace(id) {
      await loadState()
      memState.workspaces = memState.workspaces.filter((w) => w.id !== id)
      memState.accounts = memState.accounts.filter((a) => a.workspaceId !== id)
      delete memState.workspaceOwners[id]
      await saveState()
      emitState()
    },

    async activateWorkspace(id) {
      await loadState()
      const uid = memState.currentUserUid
      if (!uid) throw new Error('No user logged in.')
      memState.activeUserWorkspaceMap[uid] = id
      memState.activeAccountId = null
      await saveState()
      emitState()
    },

    async getNotifications() {
      return []
    },

    async markNotificationRead() {},
    async markAllNotificationsRead() {},
    async removeNotification() {},
    async clearNotifications() {},

    onNotifications() {
      return () => {}
    },

    async getActiveCallStatus() {
      return { hasActiveCall: false, count: 0 }
    },

    onActiveCallStatus() {
      return () => {}
    },

    async listCredentials() {
      return []
    },

    async revealPassword() {
      throw unsupportedAndroidError('Android Keystore-backed password reveal')
    },

    async copyPassword() {
      throw unsupportedAndroidError('Android Keystore-backed password copy')
    },

    async updateCredential() {
      throw unsupportedAndroidError('Android Keystore-backed credential editing')
    },

    async deleteCredential() {
      throw unsupportedAndroidError('Android Keystore-backed credential deletion')
    },

    onPasswordsUpdated() {
      return () => {}
    },

    async getCloudPasswordStatus() {
      return { unlocked: false, configured: false }
    },

    async setupCloudPassword() {
      throw unsupportedAndroidError('Android Keystore-backed cloud password setup')
    },

    async unlockCloudPassword() {
      throw unsupportedAndroidError('Android Keystore-backed cloud password unlock')
    },

    async lockCloudPassword() {
      return true
    },

    async syncWorkspaceCredentialsWithCloud() {
      // Do not store plaintext passwords in Capacitor Preferences; Keystore storage is Phase 2.
      return { mergedRecords: [], localUpdated: false, remoteUpdated: false }
    },

    async encryptCredentialForCloud() {
      return null
    }
  }
}

export function initializePlatformBridge(): void {
  if (typeof window === 'undefined') return
  const win = window as unknown as {
    socialHub?: SocialHubAPI
    __electronSocialHub?: boolean
  }
  if (win.socialHub) {
    win.__electronSocialHub = true
    return
  }
  win.__electronSocialHub = false
  win.socialHub = createAndroidHubBridge()
}
