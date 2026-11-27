import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp, resolvePlatformName } from '../shared/apps'
import type { Account, AccountPermissions, HubNotificationItem, Preferences, WindowBounds, Workspace } from './types'
import { DEFAULT_ACCOUNT_PERMISSIONS } from './types'

export type StoredAccount = Omit<Account, 'unread'>

export const DEFAULT_WORKSPACE_ID = 'workspace-default-personal'
export const DEFAULT_WORKSPACE_NAME = 'Personal'

export const PERMISSION_KEYS: ReadonlyArray<keyof AccountPermissions> = [
  'camera',
  'microphone',
  'notifications',
  'screenShare',
  'clipboard',
  'geolocation',
  'downloads'
] as const

export function sanitizePermissions(raw?: Partial<AccountPermissions> | null): AccountPermissions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_ACCOUNT_PERMISSIONS }
  }
  const result: AccountPermissions = { ...DEFAULT_ACCOUNT_PERMISSIONS }
  for (const key of PERMISSION_KEYS) {
    const val = raw[key]
    if (val === 'allow' || val === 'block') {
      result[key] = val
    }
  }
  return result
}

export const MAX_NOTIFICATIONS = 100
export const MAX_NOTIFICATION_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

export function pruneNotifications(items: HubNotificationItem[]): HubNotificationItem[] {
  const cutoff = Date.now() - MAX_NOTIFICATION_AGE_MS
  const valid = items.filter(
    (n) =>
      n &&
      typeof n === 'object' &&
      typeof n.id === 'string' &&
      typeof n.timestamp === 'number' &&
      n.timestamp >= cutoff
  )

  if (valid.length <= MAX_NOTIFICATIONS) {
    return valid.sort((a, b) => b.timestamp - a.timestamp)
  }

  // Preferentially retain unread notifications
  const unread = valid.filter((n) => !n.read)
  const read = valid.filter((n) => n.read)

  // Sort oldest first
  read.sort((a, b) => a.timestamp - b.timestamp)
  unread.sort((a, b) => a.timestamp - b.timestamp)

  const excess = valid.length - MAX_NOTIFICATIONS
  let kept: HubNotificationItem[]
  if (read.length >= excess) {
    const keepRead = read.slice(excess)
    kept = [...keepRead, ...unread]
  } else {
    const remainingToDrop = excess - read.length
    const keepUnread = unread.slice(remainingToDrop)
    kept = keepUnread
  }

  return kept.sort((a, b) => b.timestamp - a.timestamp)
}

interface StoreData {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  accounts: StoredAccount[]
  activeAccountId: string | null
  preferences: Preferences
  windowBounds: WindowBounds
  globalDefaultPermissions: AccountPermissions
  notifications: HubNotificationItem[]
  workspaceOwners?: Record<string, string>
  activeUserWorkspaceMap?: Record<string, string>
}

const colors = ['#25a66a', '#4a82d8', '#a16bd3', '#e08a35', '#d75d72', '#248e9a']

const store = new Store<StoreData>({
  name: 'social-hub',
  defaults: {
    workspaces: [],
    activeWorkspaceId: null,
    accounts: [],
    activeAccountId: null,
    preferences: {
      doNotDisturb: false,
      minimizeToTray: true,
      launchAtStartup: false,
      theme: 'system',
      accountSortBy: 'name'
    },
    windowBounds: { width: 1180, height: 780 },
    globalDefaultPermissions: DEFAULT_ACCOUNT_PERMISSIONS,
    notifications: [],
    workspaceOwners: {},
    activeUserWorkspaceMap: {}
  }
})

export class AccountManager {
  private currentUserUid: string | null = null

  constructor() {
    this.migrate()
  }

  setCurrentUser(uid: string | null): void {
    this.currentUserUid = uid
  }

  getCurrentUser(): string | null {
    return this.currentUserUid
  }

  getWorkspaceOwner(workspaceId: string): string | undefined {
    const owners = store.get('workspaceOwners') || {}
    return owners[workspaceId]
  }

  setWorkspaceOwner(workspaceId: string, ownerUid: string): void {
    const owners = store.get('workspaceOwners') || {}
    owners[workspaceId] = ownerUid
    store.set('workspaceOwners', owners)

    const all = (store.get('workspaces') as Workspace[]) || []
    const updated = all.map((w) => (w.id === workspaceId ? { ...w, ownerId: ownerUid } : w))
    store.set('workspaces', updated)
  }

  claimWorkspaces(ownerUid: string, workspaceIds: string[]): void {
    if (!ownerUid || !Array.isArray(workspaceIds)) return
    const owners = store.get('workspaceOwners') || {}
    for (const wsId of workspaceIds) {
      owners[wsId] = ownerUid
    }
    store.set('workspaceOwners', owners)

    const all = (store.get('workspaces') as Workspace[]) || []
    const updated = all.map((w) => (workspaceIds.includes(w.id) ? { ...w, ownerId: ownerUid } : w))
    store.set('workspaces', updated)
  }

  markWorkspaceSynced(workspaceId: string, synced = true): void {
    const all = (store.get('workspaces') as Workspace[]) || []
    const updated = all.map((w) => (w.id === workspaceId ? { ...w, syncedToCloud: synced } : w))
    store.set('workspaces', updated)
  }

  markAccountSynced(accountId: string, synced = true): void {
    const all = (store.get('accounts') as StoredAccount[]) || []
    const updated = all.map((a) => (a.id === accountId ? { ...a, syncedToCloud: synced } : a))
    store.set('accounts', updated)
  }

  getRawStoreAccounts(): StoredAccount[] {
    return (store.get('accounts') as StoredAccount[]) || []
  }

  reconcileRemoteWorkspaces(
    remoteWorkspaces: Array<{ ws_id: string; ws_name: string; ws_owner_id: string; ws_users_ids?: string[] }>
  ): { added: string[]; removed: string[]; updated: string[] } {
    if (!this.currentUserUid) return { added: [], removed: [], updated: [] }

    const added: string[] = []
    const removed: string[] = []
    const updated: string[] = []

    const allWorkspaces = (store.get('workspaces') as Workspace[]) || []
    const owners = store.get('workspaceOwners') || {}
    const remoteMap = new Map(remoteWorkspaces.map((rw) => [rw.ws_id, rw]))

    let modified = [...allWorkspaces]

    // 1. Remote workspaces: add new or update existing
    for (const rw of remoteWorkspaces) {
      if (!rw.ws_id) continue
      const remoteOwner = (rw.ws_owner_id || this.currentUserUid).trim()
      owners[rw.ws_id] = remoteOwner
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
        } else if (!existing.syncedToCloud) {
          modified[idx] = { ...existing, syncedToCloud: true }
        }
      } else {
        const cleanName = (rw.ws_name || 'Workspace').trim().slice(0, 40)
        const imported: Workspace = {
          id: rw.ws_id,
          name: cleanName,
          createdAt: new Date().toISOString(),
          ownerId: remoteOwner,
          memberIds: remoteMembers,
          syncedToCloud: true
        }
        modified.push(imported)
        added.push(rw.ws_id)
      }
    }

    // 2. Identify local workspaces deleted remotely or no longer authorized
    const toKeep: Workspace[] = []
    for (const lw of modified) {
      const isUserWs =
        lw.ownerId === this.currentUserUid ||
        owners[lw.id] === this.currentUserUid ||
        (Array.isArray(lw.memberIds) && lw.memberIds.includes(this.currentUserUid))
      if (isUserWs) {
        if (!remoteMap.has(lw.id)) {
          // Workspace does not exist in remote authorized workspaces - remove it
          removed.push(lw.id)
          delete owners[lw.id]
          this.removeNotificationsForWorkspace(lw.id)
          continue
        }
      }
      toKeep.push(lw)
    }

    store.set('workspaces', toKeep)
    store.set('workspaceOwners', owners)

    // Remove accounts belonging to removed workspaces
    if (removed.length > 0) {
      const removedSet = new Set(removed)
      const allAccounts = (store.get('accounts') as StoredAccount[]) || []
      const remainingAccounts = allAccounts.filter((a) => !removedSet.has(a.workspaceId))
      store.set('accounts', remainingAccounts)
    }

    // Ensure active workspace is valid
    const currentActive = this.activeWorkspaceId()
    const remainingUserWs = this.listWorkspaces()
    if (remainingUserWs.length === 0) {
      const map = (store.get('activeUserWorkspaceMap') as Record<string, string>) || {}
      delete map[this.currentUserUid]
      store.set('activeUserWorkspaceMap', map)
    } else if (!currentActive || removed.includes(currentActive) || !remainingUserWs.some((w) => w.id === currentActive)) {
      this.setActiveWorkspace(remainingUserWs[0].id)
    }

    return { added, removed, updated }
  }

  private migrate(): void {
    const rawWorkspaces = store.get('workspaces') as Workspace[] | undefined
    if (!rawWorkspaces || !Array.isArray(rawWorkspaces)) {
      store.set('workspaces', [])
    }

    if (!store.get('workspaceOwners')) {
      store.set('workspaceOwners', {})
    }

    if (!store.get('activeUserWorkspaceMap')) {
      store.set('activeUserWorkspaceMap', {})
    }

    const rawAccounts = store.get('accounts') as StoredAccount[] | undefined
    if (rawAccounts && Array.isArray(rawAccounts) && rawAccounts.length > 0) {
      let modified = false
      const fallbackWs = (rawWorkspaces && rawWorkspaces[0]?.id) || DEFAULT_WORKSPACE_ID
      const migratedAccounts = rawAccounts.map((account) => {
        let updated = account
        if (!updated.workspaceId) {
          updated = { ...updated, workspaceId: fallbackWs }
          modified = true
        }
        if (!updated.appId || !updated.url) {
          const legacyApp = APP_CATALOG[0]
          updated = { ...updated, appId: legacyApp.id, url: legacyApp.url }
          modified = true
        }
        const currentPerms = updated.permissions
        const sanitized = sanitizePermissions(currentPerms)
        const needsPermMigration =
          !currentPerms ||
          PERMISSION_KEYS.some((key) => !currentPerms[key] || (currentPerms[key] !== 'allow' && currentPerms[key] !== 'block'))
        if (needsPermMigration) {
          updated = { ...updated, permissions: sanitized }
          modified = true
        }
        return updated
      })
      if (modified) {
        store.set('accounts', migratedAccounts)
      }
    }

    const rawGlobalPerms = store.get('globalDefaultPermissions') as AccountPermissions | undefined
    if (!rawGlobalPerms || typeof rawGlobalPerms !== 'object') {
      store.set('globalDefaultPermissions', { ...DEFAULT_ACCOUNT_PERMISSIONS })
    } else {
      const sanitizedGlobal = sanitizePermissions(rawGlobalPerms)
      const needsGlobalMigration = PERMISSION_KEYS.some(
        (key) => rawGlobalPerms[key] !== sanitizedGlobal[key]
      )
      if (needsGlobalMigration) {
        store.set('globalDefaultPermissions', sanitizedGlobal)
      }
    }

    const rawPreferences = store.get('preferences') as Partial<Preferences> | undefined
    if (!rawPreferences || typeof rawPreferences !== 'object') {
      store.set('preferences', {
        doNotDisturb: false,
        minimizeToTray: true,
        launchAtStartup: false,
        theme: 'system'
      })
    } else {
      let modPrefs = false
      const updatedPrefs = { ...rawPreferences }
      if (updatedPrefs.theme !== 'system' && updatedPrefs.theme !== 'light' && updatedPrefs.theme !== 'dark') {
        updatedPrefs.theme = 'system'
        modPrefs = true
      }
      if (typeof updatedPrefs.doNotDisturb !== 'boolean') {
        updatedPrefs.doNotDisturb = false
        modPrefs = true
      }
      if (typeof updatedPrefs.minimizeToTray !== 'boolean') {
        updatedPrefs.minimizeToTray = true
        modPrefs = true
      }
      if (typeof updatedPrefs.launchAtStartup !== 'boolean') {
        updatedPrefs.launchAtStartup = false
        modPrefs = true
      }
      if (modPrefs) {
        store.set('preferences', updatedPrefs as Preferences)
      }
    }

    const rawNotifications = store.get('notifications') as HubNotificationItem[] | undefined
    if (!rawNotifications || !Array.isArray(rawNotifications)) {
      store.set('notifications', [])
    } else {
      const pruned = pruneNotifications(rawNotifications)
      if (pruned.length !== rawNotifications.length) {
        store.set('notifications', pruned)
      }
    }
  }

  // --- Workspaces CRUD ---

  listWorkspaces(): Workspace[] {
    const uid = this.currentUserUid
    if (!uid) return []
    const all = (store.get('workspaces') as Workspace[]) || []
    const owners = store.get('workspaceOwners') || {}
    return all.filter(
      (w) =>
        (w.ownerId && w.ownerId === uid) ||
        owners[w.id] === uid ||
        (Array.isArray(w.memberIds) && w.memberIds.includes(uid))
    )
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((workspace) => workspace.id === id)
  }

  addWorkspace(name: string, ownerUid?: string): Workspace {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Workspace name cannot be empty.')
    const targetUid = ownerUid || this.currentUserUid
    if (!targetUid) throw new Error('Cannot create workspace without an authenticated user.')

    const userWorkspaces = this.listWorkspaces()
    const existing = userWorkspaces.find(
      (w) => w.name.toLowerCase() === cleanName.toLowerCase()
    )
    if (existing) throw new Error(`A workspace named "${cleanName}" already exists.`)

    const workspace: Workspace = {
      id: randomUUID(),
      name: cleanName,
      createdAt: new Date().toISOString(),
      ownerId: targetUid,
      syncedToCloud: false
    }
    const allWorkspaces = (store.get('workspaces') as Workspace[]) || []
    store.set('workspaces', [...allWorkspaces, workspace])
    this.setWorkspaceOwner(workspace.id, targetUid)
    this.setActiveWorkspace(workspace.id)
    return workspace
  }

  renameWorkspace(id: string, name: string): Workspace {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Workspace name cannot be empty.')
    const target = this.getWorkspace(id)
    if (!target) throw new Error('Workspace not found.')

    const duplicate = this.listWorkspaces().find(
      (w) => w.id !== id && w.name.toLowerCase() === cleanName.toLowerCase()
    )
    if (duplicate) throw new Error(`A workspace named "${cleanName}" already exists.`)

    const updated: Workspace = { ...target, name: cleanName }
    const all = (store.get('workspaces') as Workspace[]) || []
    store.set(
      'workspaces',
      all.map((w) => (w.id === id ? updated : w))
    )
    return updated
  }

  deleteWorkspace(id: string): void {
    const target = this.getWorkspace(id)
    if (!target) throw new Error('Workspace not found.')

    const accountsInWorkspace = this.list().filter((acc) => acc.workspaceId === id)
    if (accountsInWorkspace.length > 0) {
      throw new Error(
        `Cannot delete workspace "${target.name}" because it contains ${accountsInWorkspace.length} account${
          accountsInWorkspace.length === 1 ? '' : 's'
        }. Remove all accounts in this workspace first.`
      )
    }

    const all = (store.get('workspaces') as Workspace[]) || []
    store.set(
      'workspaces',
      all.filter((w) => w.id !== id)
    )

    const owners = store.get('workspaceOwners') || {}
    delete owners[id]
    store.set('workspaceOwners', owners)

    if (this.activeWorkspaceId() === id) {
      const remaining = this.listWorkspaces().filter((w) => w.id !== id)
      if (remaining.length > 0) {
        this.setActiveWorkspace(remaining[0].id)
      } else if (this.currentUserUid) {
        const map = (store.get('activeUserWorkspaceMap') as Record<string, string>) || {}
        delete map[this.currentUserUid]
        store.set('activeUserWorkspaceMap', map)
      }
    }

    this.removeNotificationsForWorkspace(id)
  }

  activeWorkspaceId(): string | null {
    if (!this.currentUserUid) return null
    const map = (store.get('activeUserWorkspaceMap') as Record<string, string>) || {}
    const active = map[this.currentUserUid]
    const userWorkspaces = this.listWorkspaces()
    if (active && userWorkspaces.some((w) => w.id === active)) return active
    const fallback = userWorkspaces[0]?.id ?? null
    if (fallback) {
      map[this.currentUserUid] = fallback
      store.set('activeUserWorkspaceMap', map)
    }
    return fallback
  }

  setActiveWorkspace(id: string): void {
    if (!this.currentUserUid) throw new Error('No user logged in.')
    if (!this.getWorkspace(id)) throw new Error('Workspace not found.')
    const map = (store.get('activeUserWorkspaceMap') as Record<string, string>) || {}
    map[this.currentUserUid] = id
    store.set('activeUserWorkspaceMap', map)
  }

  // --- Accounts CRUD ---

  list(): StoredAccount[] {
    if (!this.currentUserUid) return []
    const userWorkspaces = this.listWorkspaces()
    const allowedWsIds = new Set(userWorkspaces.map((w) => w.id))
    const rawAccounts = (store.get('accounts') as StoredAccount[]) || []
    return rawAccounts
      .filter((a) => allowedWsIds.has(a.workspaceId))
      .map((account) => {
        let fixed = account
        if (!fixed.appId || !fixed.url) {
          const legacyApp = APP_CATALOG[0]
          fixed = { ...fixed, appId: legacyApp.id, url: legacyApp.url }
        }
        if (!fixed.permissions) {
          fixed = { ...fixed, permissions: sanitizePermissions(fixed.permissions) }
        }
        return fixed
      })
  }

  get(id: string): StoredAccount | undefined {
    return this.list().find((account) => account.id === id)
  }

  add(
    name: string,
    appId: string,
    url: string,
    workspaceId?: string,
    permissions?: Partial<AccountPermissions>
  ): StoredAccount {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Account name cannot be empty.')
    if (appId !== CUSTOM_APP_ID && !getCatalogApp(appId)) throw new Error('Unknown app.')

    const targetWorkspaceId = workspaceId ?? this.activeWorkspaceId()
    if (!targetWorkspaceId || !this.getWorkspace(targetWorkspaceId)) {
      throw new Error('Selected workspace does not exist.')
    }

    const accounts = this.list()
    const effectivePermissions = permissions
      ? sanitizePermissions({ ...this.getGlobalDefaultPermissions(), ...permissions })
      : { ...this.getGlobalDefaultPermissions() }

    const account: StoredAccount = {
      id: randomUUID(),
      workspaceId: targetWorkspaceId,
      name: cleanName,
      color: colors[accounts.length % colors.length],
      muted: false,
      createdAt: new Date().toISOString(),
      appId,
      url,
      permissions: effectivePermissions,
      syncedToCloud: false
    }
    const allAccounts = (store.get('accounts') as StoredAccount[]) || []
    store.set('accounts', [...allAccounts, account])
    store.set('activeAccountId', account.id)
    return account
  }

  addWithId(
    id: string,
    name: string,
    appId: string,
    url: string,
    workspaceId: string,
    options?: { syncedToCloud?: boolean }
  ): StoredAccount {
    const cleanName = (name || '').trim().slice(0, 40)
    const cleanUrl = (url || '').trim()
    const cleanAppId = appId && (appId === CUSTOM_APP_ID || getCatalogApp(appId)) ? appId : CUSTOM_APP_ID
    const allAccounts = (store.get('accounts') as StoredAccount[]) || []
    const existing = allAccounts.find((a) => a.id === id)
    if (existing) return existing

    const accountsInWs = this.list().filter((a) => a.workspaceId === workspaceId)
    const account: StoredAccount = {
      id,
      workspaceId,
      name: cleanName || 'Account',
      color: colors[accountsInWs.length % colors.length],
      muted: false,
      createdAt: new Date().toISOString(),
      appId: cleanAppId,
      url: cleanUrl || 'https://google.com',
      permissions: { ...this.getGlobalDefaultPermissions() },
      syncedToCloud: options?.syncedToCloud ?? true
    }
    store.set('accounts', [...allAccounts, account])
    return account
  }

  rename(id: string, name: string): StoredAccount {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Account name cannot be empty.')
    return this.update(id, { name: cleanName })
  }

  updateAccount(id: string, updates: { name?: string; url?: string }): StoredAccount {
    const existing = this.get(id)
    if (!existing) throw new Error('Account not found.')

    const patch: Partial<StoredAccount> = {}

    if (updates.name !== undefined) {
      const cleanName = updates.name.trim().slice(0, 40)
      if (!cleanName) throw new Error('Account name cannot be empty.')
      patch.name = cleanName
    }

    if (updates.url !== undefined) {
      const cleanUrl = updates.url.trim()
      if (!cleanUrl) throw new Error('Website URL cannot be empty.')
      try {
        const parsed = new URL(cleanUrl)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
          throw new Error('Enter a valid HTTPS website URL.')
        }
        patch.url = parsed.href
      } catch {
        throw new Error('Enter a valid HTTPS website URL.')
      }
    }

    return this.update(id, patch)
  }

  setMuted(id: string, muted: boolean): StoredAccount {
    return this.update(id, { muted })
  }

  updatePermissions(accountId: string, permissions: Partial<AccountPermissions>): StoredAccount {
    const existing = this.get(accountId)
    if (!existing) throw new Error('Account not found.')

    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('Permissions must be an object.')
    }

    const keys = Object.keys(permissions)
    for (const key of keys) {
      if (!PERMISSION_KEYS.includes(key as keyof AccountPermissions)) {
        throw new Error(`Unexpected permission key: "${key}".`)
      }
      const val = (permissions as Record<string, unknown>)[key]
      if (val !== 'allow' && val !== 'block') {
        throw new Error(`Invalid permission state for "${key}": "${String(val)}". Expected 'allow' or 'block'.`)
      }
    }

    const current = existing.permissions ?? DEFAULT_ACCOUNT_PERMISSIONS
    const merged: AccountPermissions = {
      ...current,
      ...permissions
    }
    return this.update(accountId, { permissions: merged })
  }

  resetPermissions(accountId: string): StoredAccount {
    return this.updatePermissions(accountId, this.getGlobalDefaultPermissions())
  }

  getGlobalDefaultPermissions(): AccountPermissions {
    const raw = store.get('globalDefaultPermissions')
    return sanitizePermissions(raw)
  }

  updateGlobalDefaultPermissions(permissions: Partial<AccountPermissions>): AccountPermissions {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('Permissions must be an object.')
    }

    const keys = Object.keys(permissions)
    if (keys.length === 0) {
      return this.getGlobalDefaultPermissions()
    }

    for (const key of keys) {
      if (!PERMISSION_KEYS.includes(key as keyof AccountPermissions)) {
        throw new Error(`Unexpected permission key: "${key}".`)
      }
      const val = (permissions as Record<string, unknown>)[key]
      if (val !== 'allow' && val !== 'block') {
        throw new Error(`Invalid permission state for "${key}": "${String(val)}". Expected 'allow' or 'block'.`)
      }
    }

    const current = this.getGlobalDefaultPermissions()
    const merged: AccountPermissions = {
      ...current,
      ...permissions
    }
    store.set('globalDefaultPermissions', merged)
    return merged
  }

  resetGlobalDefaultPermissions(): AccountPermissions {
    store.set('globalDefaultPermissions', { ...DEFAULT_ACCOUNT_PERMISSIONS })
    return { ...DEFAULT_ACCOUNT_PERMISSIONS }
  }

  remove(id: string): void {
    const target = this.get(id)
    if (!target) throw new Error('Account not found.')
    const allAccounts = (store.get('accounts') as StoredAccount[]) || []
    const remaining = allAccounts.filter((account) => account.id !== id)
    store.set('accounts', remaining)
    if (store.get('activeAccountId') === id) {
      const nextInSameWorkspace = this.list().find((a) => a.workspaceId === target.workspaceId && a.id !== id)
      store.set('activeAccountId', nextInSameWorkspace?.id ?? null)
    }
    this.removeNotificationsForAccount(id)
  }

  // --- Notifications Center ---

  getNotifications(): HubNotificationItem[] {
    const raw = store.get('notifications')
    if (!Array.isArray(raw)) return []
    return pruneNotifications(raw)
  }

  addNotification(
    item: Omit<HubNotificationItem, 'id' | 'timestamp' | 'read'> & {
      id?: string
      timestamp?: number
      read?: boolean
    }
  ): HubNotificationItem {
    const newItem: HubNotificationItem = {
      id: item.id || randomUUID(),
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName,
      accountId: item.accountId,
      accountName: item.accountName,
      accountAppId: item.accountAppId,
      platformName: item.platformName ?? resolvePlatformName(item.accountAppId),
      type: item.type,
      title: item.title.trim().slice(0, 100),
      body: (item.body || '').trim().slice(0, 300),
      timestamp: item.timestamp ?? Date.now(),
      read: item.read ?? false,
      tag: item.tag ? item.tag.trim().slice(0, 100) : undefined,
      callType: item.callType
    }

    const current = this.getNotifications()
    const updated = pruneNotifications([newItem, ...current])
    store.set('notifications', updated)
    return newItem
  }

  updateNotificationTitle(id: string, title: string): void {
    const current = this.getNotifications()
    const updated = current.map((n) => (n.id === id ? { ...n, title: title.trim().slice(0, 100) } : n))
    store.set('notifications', updated)
  }

  updateCallNotificationCaller(callId: string, accountId: string, callerName: string): boolean {
    const current = this.getNotifications()
    let found = false
    const updated = current.map((n) => {
      if (n.type === 'call' && n.tag === callId && n.accountId === accountId) {
        found = true
        return { ...n, title: callerName.trim().slice(0, 100) }
      }
      return n
    })
    if (found) {
      store.set('notifications', updated)
    }
    return found
  }

  markNotificationRead(id: string): void {
    const current = this.getNotifications()
    const updated = current.map((n) => (n.id === id ? { ...n, read: true } : n))
    store.set('notifications', updated)
  }

  markAllNotificationsRead(): void {
    const current = this.getNotifications()
    const updated = current.map((n) => ({ ...n, read: true }))
    store.set('notifications', updated)
  }

  removeNotification(id: string): void {
    const current = this.getNotifications()
    const updated = current.filter((n) => n.id !== id)
    store.set('notifications', updated)
  }

  clearNotifications(): void {
    store.set('notifications', [])
  }

  removeNotificationsForAccount(accountId: string): void {
    const current = this.getNotifications()
    const updated = current.filter((n) => n.accountId !== accountId)
    store.set('notifications', updated)
  }

  removeNotificationsForWorkspace(workspaceId: string): void {
    const current = this.getNotifications()
    const updated = current.filter((n) => n.workspaceId !== workspaceId)
    store.set('notifications', updated)
  }

  setActive(id: string): void {
    if (id && !this.get(id)) throw new Error('Account not found.')
    store.set('activeAccountId', id || null)
    if (id) {
      this.update(id, { lastUsedAt: Date.now() })
    }
  }

  activeId(): string | null {
    return store.get('activeAccountId')
  }

  preferences(): Preferences {
    const raw = store.get('preferences')
    const accountSortBy = raw?.accountSortBy === 'lastUsed' ? 'lastUsed' : 'name'
    if (!raw || (raw.theme !== 'system' && raw.theme !== 'light' && raw.theme !== 'dark')) {
      return {
        doNotDisturb: Boolean(raw?.doNotDisturb),
        minimizeToTray: raw?.minimizeToTray ?? true,
        launchAtStartup: Boolean(raw?.launchAtStartup),
        theme: 'system',
        accountSortBy
      }
    }
    return { ...raw, accountSortBy }
  }

  updatePreferences(partial: Partial<Preferences>): Preferences {
    if (partial.theme !== undefined) {
      if (partial.theme !== 'system' && partial.theme !== 'light' && partial.theme !== 'dark') {
        throw new Error(`Invalid theme: "${String(partial.theme)}". Expected 'system', 'light', or 'dark'.`)
      }
    }
    if (partial.accountSortBy !== undefined) {
      if (partial.accountSortBy !== 'name' && partial.accountSortBy !== 'lastUsed') {
        throw new Error(`Invalid accountSortBy: "${String(partial.accountSortBy)}". Expected 'name' or 'lastUsed'.`)
      }
    }
    const next: Preferences = { ...this.preferences(), ...partial }
    store.set('preferences', next)
    return next
  }

  bounds(): WindowBounds {
    return store.get('windowBounds')
  }

  saveBounds(bounds: WindowBounds): void {
    store.set('windowBounds', bounds)
  }

  private update(id: string, patch: Partial<StoredAccount>): StoredAccount {
    const existing = this.get(id)
    if (!existing) throw new Error('Account not found.')
    const updated = { ...existing, ...patch }
    const allAccounts = (store.get('accounts') as StoredAccount[]) || []
    store.set(
      'accounts',
      allAccounts.map((account) => (account.id === id ? updated : account))
    )
    return updated
  }
}
