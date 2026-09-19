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
  setCalendarEnabled: (enabled) => ipcRenderer.invoke('settings:set-calendar-enabled', enabled),
  // トレイなどほかの所で設定が変わったときも、表示を合わせる
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
