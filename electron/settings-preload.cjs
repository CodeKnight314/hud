const { contextBridge, ipcRenderer } = require('electron');

const call = (action, value) => ipcRenderer.invoke('hud:settings', action, value);
contextBridge.exposeInMainWorld('hudSettings', Object.freeze({
  getState: () => call('state'),
  refreshConnections: () => call('connections'),
  connect: (id) => call('connect', id),
  disconnect: (id) => call('disconnect', id),
  installCommand: () => call('install-command'),
  copyConfig: () => call('copy-config'),
  checkUpdates: () => call('check-updates'),
  setCheckOnLaunch: (value) => call('check-on-launch', value),
  openRelease: () => call('open-release'),
  openTemplateDocs: (id) => call('open-template-docs', id),
  downloadUpdate: () => call('download-update'),
  quitForUpdate: () => call('quit-for-update'),
}));
