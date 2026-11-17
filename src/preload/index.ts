import { contextBridge, ipcRenderer } from 'electron'
import type { Account, DownloadUpdate, HubState, NewAccount, Preferences } from '../main/types'

export interface SocialHubAPI {
  getState(): Promise<HubState>
  addAccount(account: NewAccount): Promise<Account>
  activateAccount(id: string): Promise<void>
  renameAccount(id: string, name: string): Promise<Account>
  setMuted(id: string, muted: boolean): Promise<Account>
  reloadAccount(id: string): Promise<void>
  clearCache(id: string): Promise<void>
  removeAccount(id: string): Promise<void>
  updatePreferences(preferences: Partial<Preferences>): Promise<Preferences>
  setSidebarOverlay(active: boolean): void
  onState(callback: (state: HubState) => void): () => void
  onDownload(callback: (update: DownloadUpdate) => void): () => void
  onAddAccountShortcut(callback: () => void): () => void
}

const api: SocialHubAPI = {
  getState: () => ipcRenderer.invoke('hub:get-state'),
  addAccount: (account) => ipcRenderer.invoke('hub:add-account', account),
  activateAccount: (id) => ipcRenderer.invoke('hub:activate-account', id),
  renameAccount: (id, name) => ipcRenderer.invoke('hub:rename-account', id, name),
  setMuted: (id, muted) => ipcRenderer.invoke('hub:set-muted', id, muted),
  reloadAccount: (id) => ipcRenderer.invoke('hub:reload-account', id),
  clearCache: (id) => ipcRenderer.invoke('hub:clear-cache', id),
  removeAccount: (id) => ipcRenderer.invoke('hub:remove-account', id),
  updatePreferences: (preferences) => ipcRenderer.invoke('hub:update-preferences', preferences),
  setSidebarOverlay: (active) => ipcRenderer.send('hub:set-sidebar-overlay', active),
  onState: (callback) => subscribe('hub:state', callback),
  onDownload: (callback) => subscribe('hub:download', callback),
  onAddAccountShortcut: (callback) => subscribe('hub:add-account-shortcut', callback)
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('socialHub', api)
