import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('socialHubNotification', {
  clicked: () => ipcRenderer.send('social:notification-click')
})
