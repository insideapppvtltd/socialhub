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
}

export interface NewAccount {
  name: string
  appId: string
  url?: string
  workspaceId?: string
}

export interface Preferences {
  doNotDisturb: boolean
  minimizeToTray: boolean
  launchAtStartup: boolean
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
}
