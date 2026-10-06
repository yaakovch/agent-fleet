import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('hostFilePreview', {
  state: () => ipcRenderer.invoke('hostFilePreview:state'),
  action: (action: string) => ipcRenderer.invoke('hostFilePreview:action', action),
  updated: (callback: () => void) => { ipcRenderer.on('hostFilePreview:updated', callback); }
});
