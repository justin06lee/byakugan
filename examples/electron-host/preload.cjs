const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byakugan', {
  onUpdate: (cb) => ipcRenderer.on('byakugan', (_e, payload) => cb(payload)),
});
