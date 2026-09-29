'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 設定ウィンドウに渡すのはこの関数だけ。設定の保存はメイン側で行う
contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('settings:set-open-at-login', enabled),
  chooseShareFolder: () => ipcRenderer.invoke('settings:choose-share-folder'),
  stopSharing: () => ipcRenderer.invoke('settings:stop-sharing'),
  chooseCalendarClient: () => ipcRenderer.invoke('settings:calendar-choose-client'),
  signInCalendar: () => ipcRenderer.invoke('settings:calendar-sign-in'),
  signOutCalendar: () => ipcRenderer.invoke('settings:calendar-sign-out'),
  setCalendarMode: (mode) => ipcRenderer.invoke('settings:set-calendar-mode', mode),
  setCalendarRefreshMinutes: (minutes) => ipcRenderer.invoke('settings:set-calendar-refresh', minutes),
  setMascotLook: (id) => ipcRenderer.invoke('settings:set-mascot-look', id),
  setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
  setApiKeySource: (id) => ipcRenderer.invoke('settings:set-api-key-source', id),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save-api-key', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  setKeepPast: (enabled) => ipcRenderer.invoke('settings:set-keep-past', enabled),
  setWebSearch: (enabled) => ipcRenderer.invoke('settings:set-web-search', enabled),
  setSound: (slot, id) => ipcRenderer.invoke('settings:set-sound', slot, id),
  setSoundVolume: (id) => ipcRenderer.invoke('settings:set-sound-volume', id),
  chooseSoundFile: (slot) => ipcRenderer.invoke('settings:choose-sound-file', slot),
  // 試し聞き用。豆の窓と同じものを鳴らす
  getSounds: () => ipcRenderer.invoke('sound:get'),
  // トレイなどほかの所で設定が変わったときも、表示を合わせる
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
