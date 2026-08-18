'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tether', {
  bootstrap: () => ipcRenderer.invoke('tether:bootstrap'),
  notify: (title, body) => ipcRenderer.send('tether:notify', { title, body }),
  log: (line) => ipcRenderer.send('tether:log', line),
});
