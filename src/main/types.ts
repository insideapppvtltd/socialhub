export interface Account {
  id: string
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
  accounts: Account[]
  activeAccountId: string | null
  preferences: Preferences
}
