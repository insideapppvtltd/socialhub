import { contextBridge, ipcRenderer } from 'electron'
import type { Account, AccountPermissions, DownloadUpdate, HubNotificationItem, HubState, NewAccount, Preferences, Workspace } from '../main/types'
import type { CredentialSummary } from '../main/password-manager'
import type { UserPasswordCryptoMetadata, CloudEncryptedCredentialRecord, FirestorePasswordRecord } from '../main/cloud-crypto'

export type { CredentialSummary, UserPasswordCryptoMetadata, CloudEncryptedCredentialRecord, FirestorePasswordRecord }

export interface SocialHubAPI {
  setCurrentUser(uid: string | null, localOwners?: Record<string, string>): Promise<HubState>
  claimWorkspaces(uid: string, workspaceIds: string[]): Promise<boolean>
  getState(): Promise<HubState>
  getGoogleAuthToken(): Promise<string>
  cancelGoogleAuth(): Promise<boolean>
  addAccount(account: NewAccount): Promise<Account>
  activateAccount(id: string): Promise<void>
  renameAccount(id: string, name: string): Promise<Account>
  updateAccount(id: string, updates: { name?: string; url?: string }): Promise<Account>
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
  getActiveCallStatus(): Promise<{ hasActiveCall: boolean; count: number }>
  onActiveCallStatus(callback: (status: { hasActiveCall: boolean; count: number }) => void): () => void
  listCredentials(): Promise<CredentialSummary[]>
  revealPassword(id: string): Promise<string>
  copyPassword(id: string): Promise<boolean>
  updateCredential(payload: { id: string; username: string; password?: string }): Promise<unknown>
  deleteCredential(id: string): Promise<boolean>
  onPasswordsUpdated(callback: () => void): () => void
  getCloudPasswordStatus(): Promise<{ unlocked: boolean; configured?: boolean }>
  setupCloudPassword(masterPassword: string): Promise<{ metadata: UserPasswordCryptoMetadata }>
  unlockCloudPassword(masterPassword: string, metadata: UserPasswordCryptoMetadata): Promise<{ success: boolean }>
  lockCloudPassword(): Promise<boolean>
  syncWorkspaceCredentialsWithCloud(
    workspaceId: string,
    remoteRecords: (FirestorePasswordRecord | CloudEncryptedCredentialRecord | any)[]
  ): Promise<{ mergedRecords: FirestorePasswordRecord[]; localUpdated: boolean; remoteUpdated?: boolean }>
  encryptCredentialForCloud(credentialId: string): Promise<FirestorePasswordRecord | null>
}

const api: SocialHubAPI = {
  setCurrentUser: (uid, localOwners) => ipcRenderer.invoke('hub:set-current-user', uid, localOwners),
  claimWorkspaces: (uid, workspaceIds) => ipcRenderer.invoke('hub:claim-workspaces', uid, workspaceIds),
  getState: () => ipcRenderer.invoke('hub:get-state'),
  getGoogleAuthToken: () => ipcRenderer.invoke('hub:google-auth-token'),
  cancelGoogleAuth: () => ipcRenderer.invoke('hub:google-auth-cancel'),
  addAccount: (account) => ipcRenderer.invoke('hub:add-account', account),
  activateAccount: (id) => ipcRenderer.invoke('hub:activate-account', id),
  renameAccount: (id, name) => ipcRenderer.invoke('hub:rename-account', id, name),
  updateAccount: (id, updates) => ipcRenderer.invoke('hub:update-account', id, updates),
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
  onNotifications: (callback) => subscribe('hub:notifications', callback),
  getActiveCallStatus: () => ipcRenderer.invoke('hub:get-active-call-status'),
  onActiveCallStatus: (callback) => subscribe('hub:active-call-status', callback),
  listCredentials: () => ipcRenderer.invoke('hub:passwords-list'),
  revealPassword: (id) => ipcRenderer.invoke('hub:passwords-get-password', id),
  copyPassword: (id) => ipcRenderer.invoke('hub:passwords-copy-password', id),
  updateCredential: (payload) => ipcRenderer.invoke('hub:passwords-update', payload),
  deleteCredential: (id) => ipcRenderer.invoke('hub:passwords-delete', id),
  onPasswordsUpdated: (callback) => subscribe('hub:passwords-updated', callback),
  getCloudPasswordStatus: () => ipcRenderer.invoke('hub:passwords-cloud-status'),
  setupCloudPassword: (masterPassword) => ipcRenderer.invoke('hub:passwords-cloud-setup', masterPassword),
  unlockCloudPassword: (masterPassword, metadata) =>
    ipcRenderer.invoke('hub:passwords-cloud-unlock', { masterPassword, metadata }),
  lockCloudPassword: () => ipcRenderer.invoke('hub:passwords-cloud-lock'),
  syncWorkspaceCredentialsWithCloud: (workspaceId, remoteRecords) =>
    ipcRenderer.invoke('hub:passwords-cloud-sync-workspace', { workspaceId, remoteRecords }),
  encryptCredentialForCloud: (credentialId) =>
    ipcRenderer.invoke('hub:passwords-cloud-encrypt-single', credentialId)
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('socialHub', api)
