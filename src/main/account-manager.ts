import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp } from '../shared/apps'
import type { Account, Preferences, WindowBounds, Workspace } from './types'

export type StoredAccount = Omit<Account, 'unread'>

export const DEFAULT_WORKSPACE_ID = 'workspace-default-personal'
export const DEFAULT_WORKSPACE_NAME = 'Personal'

interface StoreData {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  accounts: StoredAccount[]
  activeAccountId: string | null
  preferences: Preferences
  windowBounds: WindowBounds
}

const colors = ['#25a66a', '#4a82d8', '#a16bd3', '#e08a35', '#d75d72', '#248e9a']

const store = new Store<StoreData>({
  name: 'social-hub',
  defaults: {
    workspaces: [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: DEFAULT_WORKSPACE_NAME,
        createdAt: new Date().toISOString()
      }
    ],
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    accounts: [],
    activeAccountId: null,
    preferences: {
      doNotDisturb: false,
      minimizeToTray: true,
      launchAtStartup: false
    },
    windowBounds: { width: 1180, height: 780 }
  }
})

export class AccountManager {
  constructor() {
    this.migrate()
  }

  private migrate(): void {
    let workspaces = store.get('workspaces') as Workspace[] | undefined
    if (!workspaces || !Array.isArray(workspaces) || workspaces.length === 0) {
      const defaultWorkspace: Workspace = {
        id: DEFAULT_WORKSPACE_ID,
        name: DEFAULT_WORKSPACE_NAME,
        createdAt: new Date().toISOString()
      }
      workspaces = [defaultWorkspace]
      store.set('workspaces', workspaces)
      store.set('activeWorkspaceId', defaultWorkspace.id)
    }

    const fallbackWorkspaceId = workspaces[0].id
    const currentActiveWorkspaceId = store.get('activeWorkspaceId')
    if (!currentActiveWorkspaceId || !workspaces.some((w) => w.id === currentActiveWorkspaceId)) {
      store.set('activeWorkspaceId', fallbackWorkspaceId)
    }

    const rawAccounts = store.get('accounts') as StoredAccount[] | undefined
    if (rawAccounts && Array.isArray(rawAccounts) && rawAccounts.length > 0) {
      let modified = false
      const migratedAccounts = rawAccounts.map((account) => {
        let updated = account
        if (!updated.workspaceId) {
          updated = { ...updated, workspaceId: fallbackWorkspaceId }
          modified = true
        }
        if (!updated.appId || !updated.url) {
          const legacyApp = APP_CATALOG[0]
          updated = { ...updated, appId: legacyApp.id, url: legacyApp.url }
          modified = true
        }
        return updated
      })
      if (modified) {
        store.set('accounts', migratedAccounts)
      }
    }
  }

  // --- Workspaces CRUD ---

  listWorkspaces(): Workspace[] {
    const workspaces = store.get('workspaces')
    if (!workspaces || workspaces.length === 0) {
      return [
        {
          id: DEFAULT_WORKSPACE_ID,
          name: DEFAULT_WORKSPACE_NAME,
          createdAt: new Date().toISOString()
        }
      ]
    }
    return workspaces
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((workspace) => workspace.id === id)
  }

  addWorkspace(name: string): Workspace {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Workspace name cannot be empty.')
    const existing = this.listWorkspaces().find(
      (w) => w.name.toLowerCase() === cleanName.toLowerCase()
    )
    if (existing) throw new Error(`A workspace named "${cleanName}" already exists.`)

    const workspace: Workspace = {
      id: randomUUID(),
      name: cleanName,
      createdAt: new Date().toISOString()
    }
    const updated = [...this.listWorkspaces(), workspace]
    store.set('workspaces', updated)
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
    store.set(
      'workspaces',
      this.listWorkspaces().map((w) => (w.id === id ? updated : w))
    )
    return updated
  }

  deleteWorkspace(id: string): void {
    const target = this.getWorkspace(id)
    if (!target) throw new Error('Workspace not found.')
    if (this.listWorkspaces().length <= 1) {
      throw new Error('Cannot delete the only remaining workspace.')
    }

    const accountsInWorkspace = this.list().filter((acc) => acc.workspaceId === id)
    if (accountsInWorkspace.length > 0) {
      throw new Error(
        `Cannot delete workspace "${target.name}" because it contains ${accountsInWorkspace.length} account${
          accountsInWorkspace.length === 1 ? '' : 's'
        }. Remove all accounts in this workspace first.`
      )
    }

    if (this.activeWorkspaceId() === id) {
      const remaining = this.listWorkspaces().filter((w) => w.id !== id)
      this.setActiveWorkspace(remaining[0].id)
    }

    store.set(
      'workspaces',
      this.listWorkspaces().filter((w) => w.id !== id)
    )
  }

  activeWorkspaceId(): string {
    const active = store.get('activeWorkspaceId')
    if (active && this.getWorkspace(active)) return active
    const fallback = this.listWorkspaces()[0]?.id ?? DEFAULT_WORKSPACE_ID
    store.set('activeWorkspaceId', fallback)
    return fallback
  }

  setActiveWorkspace(id: string): void {
    if (!this.getWorkspace(id)) throw new Error('Workspace not found.')
    store.set('activeWorkspaceId', id)
  }

  // --- Accounts CRUD ---

  list(): StoredAccount[] {
    const defaultWorkspaceId = this.activeWorkspaceId()
    return store.get('accounts').map((account) => {
      let fixed = account
      if (!fixed.workspaceId) {
        fixed = { ...fixed, workspaceId: defaultWorkspaceId }
      }
      if (!fixed.appId || !fixed.url) {
        const legacyApp = APP_CATALOG[0]
        fixed = { ...fixed, appId: legacyApp.id, url: legacyApp.url }
      }
      return fixed
    })
  }

  get(id: string): StoredAccount | undefined {
    return this.list().find((account) => account.id === id)
  }

  add(name: string, appId: string, url: string, workspaceId?: string): StoredAccount {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Account name cannot be empty.')
    if (appId !== CUSTOM_APP_ID && !getCatalogApp(appId)) throw new Error('Unknown app.')

    const targetWorkspaceId = workspaceId ?? this.activeWorkspaceId()
    if (!this.getWorkspace(targetWorkspaceId)) {
      throw new Error('Selected workspace does not exist.')
    }

    const accounts = this.list()
    const account: StoredAccount = {
      id: randomUUID(),
      workspaceId: targetWorkspaceId,
      name: cleanName,
      color: colors[accounts.length % colors.length],
      muted: false,
      createdAt: new Date().toISOString(),
      appId,
      url
    }
    store.set('accounts', [...accounts, account])
    store.set('activeAccountId', account.id)
    return account
  }

  rename(id: string, name: string): StoredAccount {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Account name cannot be empty.')
    return this.update(id, { name: cleanName })
  }

  setMuted(id: string, muted: boolean): StoredAccount {
    return this.update(id, { muted })
  }

  remove(id: string): void {
    const target = this.get(id)
    if (!target) throw new Error('Account not found.')
    const remaining = this.list().filter((account) => account.id !== id)
    store.set('accounts', remaining)
    if (store.get('activeAccountId') === id) {
      const nextInSameWorkspace = remaining.find((a) => a.workspaceId === target.workspaceId)
      store.set('activeAccountId', nextInSameWorkspace?.id ?? null)
    }
  }

  setActive(id: string): void {
    if (id && !this.get(id)) throw new Error('Account not found.')
    store.set('activeAccountId', id || null)
  }

  activeId(): string | null {
    return store.get('activeAccountId')
  }

  preferences(): Preferences {
    return store.get('preferences')
  }

  updatePreferences(partial: Partial<Preferences>): Preferences {
    const next = { ...this.preferences(), ...partial }
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
    store.set(
      'accounts',
      this.list().map((account) => (account.id === id ? updated : account))
    )
    return updated
  }
}
