import { contextBridge, ipcRenderer } from 'electron'
import type { Account, AccountPermissions, DownloadUpdate, HubNotificationItem, HubState, NewAccount, Preferences, Workspace } from '../main/types'

export interface SocialHubAPI {
  getState(): Promise<HubState>
  getGoogleAuthToken(): Promise<string>
  addAccount(account: NewAccount): Promise<Account>
  activateAccount(id: string): Promise<void>
  renameAccount(id: string, name: string): Promise<Account>
  setMuted(id: string, muted: boolean): Promise<Account>
  setAccountPermissions(id: string, permissions: Partial<AccountPermissions>): Promise<Account>
  getGlobalDefaultPermissions(): Promise<AccountPermissions>
  updateGlobalDefaultPermissions(permissions: Partial<AccountPermissions>): Promise<AccountPermissions>
  resetGlobalDefaultPermissions(): Promise<AccountPermissions>
  reloadAccount(id: string): Promise<void>
  clearCache(id: string): Promise<void>
  removeAccount(id: string): Promise<void>
  updatePreferences(preferences: Partial<Preferences>): Promise<Preferences>
  setSidebarOverlay(active: boolean): void
  onState(callback: (state: HubState) => void): () => void
  onDownload(callback: (update: DownloadUpdate) => void): () => void
  onAddAccountShortcut(callback: () => void): () => void
  addWorkspace(name: string): Promise<Workspace>
  renameWorkspace(id: string, name: string): Promise<Workspace>
  deleteWorkspace(id: string): Promise<void>
  activateWorkspace(id: string): Promise<void>
  getNotifications(): Promise<HubNotificationItem[]>
  markNotificationRead(id: string): Promise<void>
  markAllNotificationsRead(): Promise<void>
  removeNotification(id: string): Promise<void>
  clearNotifications(): Promise<void>
  onNotifications(callback: (notifications: HubNotificationItem[]) => void): () => void
}

const api: SocialHubAPI = {
  getState: () => ipcRenderer.invoke('hub:get-state'),
  getGoogleAuthToken: () => ipcRenderer.invoke('hub:google-auth-token'),
  addAccount: (account) => ipcRenderer.invoke('hub:add-account', account),
  activateAccount: (id) => ipcRenderer.invoke('hub:activate-account', id),
  renameAccount: (id, name) => ipcRenderer.invoke('hub:rename-account', id, name),
  setMuted: (id, muted) => ipcRenderer.invoke('hub:set-muted', id, muted),
  setAccountPermissions: (id, permissions) => ipcRenderer.invoke('hub:set-account-permissions', id, permissions),
  getGlobalDefaultPermissions: () => ipcRenderer.invoke('hub:get-global-default-permissions'),
  updateGlobalDefaultPermissions: (permissions) => ipcRenderer.invoke('hub:update-global-default-permissions', permissions),
  resetGlobalDefaultPermissions: () => ipcRenderer.invoke('hub:reset-global-default-permissions'),
  reloadAccount: (id) => ipcRenderer.invoke('hub:reload-account', id),
  clearCache: (id) => ipcRenderer.invoke('hub:clear-cache', id),
  removeAccount: (id) => ipcRenderer.invoke('hub:remove-account', id),
  updatePreferences: (preferences) => ipcRenderer.invoke('hub:update-preferences', preferences),
  setSidebarOverlay: (active) => ipcRenderer.send('hub:set-sidebar-overlay', active),
  onState: (callback) => subscribe('hub:state', callback),
  onDownload: (callback) => subscribe('hub:download', callback),
  onAddAccountShortcut: (callback) => subscribe('hub:add-account-shortcut', callback),
  addWorkspace: (name) => ipcRenderer.invoke('hub:add-workspace', name),
  renameWorkspace: (id, name) => ipcRenderer.invoke('hub:rename-workspace', id, name),
  deleteWorkspace: (id) => ipcRenderer.invoke('hub:delete-workspace', id),
  activateWorkspace: (id) => ipcRenderer.invoke('hub:activate-workspace', id),
  getNotifications: () => ipcRenderer.invoke('hub:get-notifications'),
  markNotificationRead: (id) => ipcRenderer.invoke('hub:mark-notification-read', id),
  markAllNotificationsRead: () => ipcRenderer.invoke('hub:mark-all-notifications-read'),
  removeNotification: (id) => ipcRenderer.invoke('hub:remove-notification', id),
  clearNotifications: () => ipcRenderer.invoke('hub:clear-notifications'),
  onNotifications: (callback) => subscribe('hub:notifications', callback)
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('socialHub', api)
