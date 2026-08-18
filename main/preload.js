'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tether', {
  bootstrap: () => ipcRenderer.invoke('tether:bootstrap'),
  notify: (title, body) => ipcRenderer.send('tether:notify', { title, body }),
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
