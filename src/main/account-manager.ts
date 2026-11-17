import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { APP_CATALOG, CUSTOM_APP_ID, getCatalogApp } from '../shared/apps'
import type { Account, Preferences, WindowBounds } from './types'

export type StoredAccount = Omit<Account, 'unread'>

interface StoreData {
  accounts: StoredAccount[]
  activeAccountId: string | null
  preferences: Preferences
  windowBounds: WindowBounds
}

const colors = ['#25a66a', '#4a82d8', '#a16bd3', '#e08a35', '#d75d72', '#248e9a']

const store = new Store<StoreData>({
  name: 'social-hub',
  defaults: {
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
  list(): StoredAccount[] {
    return store.get('accounts').map((account) => {
      if (account.appId && account.url) return account
      const legacyApp = APP_CATALOG[0]
      return { ...account, appId: legacyApp.id, url: legacyApp.url }
    })
  }

  get(id: string): StoredAccount | undefined {
    return this.list().find((account) => account.id === id)
  }

  add(name: string, appId: string, url: string): StoredAccount {
    const cleanName = name.trim().slice(0, 40)
    if (!cleanName) throw new Error('Account name cannot be empty.')
    if (appId !== CUSTOM_APP_ID && !getCatalogApp(appId)) throw new Error('Unknown app.')
    const accounts = this.list()
    const account: StoredAccount = {
      id: randomUUID(),
      name: cleanName,
      color: colors[accounts.length % colors.length],
      muted: false,
      createdAt: new Date().toISOString(),
      appId,
      url
    }
    store.set('accounts', [...accounts, account])
    if (!store.get('activeAccountId')) store.set('activeAccountId', account.id)
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
    if (!this.get(id)) throw new Error('Account not found.')
    store.set('accounts', this.list().filter((account) => account.id !== id))
    if (store.get('activeAccountId') === id) {
      store.set('activeAccountId', this.list()[0]?.id ?? null)
    }
  }

  setActive(id: string): void {
    if (!this.get(id)) throw new Error('Account not found.')
    store.set('activeAccountId', id)
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
