export type PermissionState = 'allow' | 'block'

export interface AccountPermissions {
  camera: PermissionState
  microphone: PermissionState
  notifications: PermissionState
  screenShare: PermissionState
  clipboard: PermissionState
  geolocation: PermissionState
  downloads: PermissionState
}

export const DEFAULT_ACCOUNT_PERMISSIONS: AccountPermissions = {
  camera: 'allow',
  microphone: 'allow',
  notifications: 'allow',
  screenShare: 'allow',
  clipboard: 'allow',
  geolocation: 'block',
  downloads: 'allow'
}

export interface Workspace {
  id: string
  name: string
  createdAt: string
}

export interface NewWorkspace {
  name: string
}

export interface Account {
  id: string
  workspaceId: string
  name: string
  color: string
  muted: boolean
  createdAt: string
  appId: string
  url: string
  unread: number
  permissions: AccountPermissions
}

export interface NewAccount {
  name: string
  appId: string
  url?: string
  workspaceId?: string
  permissions?: Partial<AccountPermissions>
}

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Preferences {
  doNotDisturb: boolean
  minimizeToTray: boolean
  launchAtStartup: boolean
  theme: ThemeMode
}

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface DownloadUpdate {
  accountId: string
  filename: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  path?: string
}

export interface HubState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  accounts: Account[]
  activeAccountId: string | null
  preferences: Preferences
  globalDefaultPermissions: AccountPermissions
}
