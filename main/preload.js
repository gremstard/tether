'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tether', {
  bootstrap: () => ipcRenderer.invoke('tether:bootstrap'),
  notify: (title, body, peerUid) =>
    ipcRenderer.send('tether:notify', { title, body, peerUid }),
  onOpenThread: (handler) =>
    ipcRenderer.on('tether:open-thread', (_event, peerUid) => handler(peerUid)),
  loginItem: {
    get: () => ipcRenderer.invoke('tether:login-item:get'),
    set: (enabled) => ipcRenderer.invoke('tether:login-item:set', enabled),
  },
  log: (line) => ipcRenderer.send('tether:log', line),
  invite: {
    encode: (config) => ipcRenderer.invoke('tether:invite:encode', config),
    decode: (code) => ipcRenderer.invoke('tether:invite:decode', code),
  },
  store: {
    load: (pairId) => ipcRenderer.invoke('tether:store:load', pairId),
    append: (pairId, record) => ipcRenderer.invoke('tether:store:append', pairId, record),
    clear: (pairId) => ipcRenderer.invoke('tether:store:clear', pairId),
  },
});
