'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// レンダラーに渡すのはこの関数だけ。APIキーも会話履歴もメイン側に閉じ込める。
contextBridge.exposeInMainWorld('mascot', {
  send: (text) => ipcRenderer.invoke('chat:send', text),
  onDelta: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  fitHeight: (height) => ipcRenderer.send('window:fit-height', height),
  setClickThrough: (enabled) => ipcRenderer.send('window:click-through', enabled),
  onHidden: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:hidden', listener);
    return () => ipcRenderer.removeListener('window:hidden', listener);
  },
  showMenu: () => ipcRenderer.send('menu:show'),
  openLink: (url) => ipcRenderer.send('link:open', url),
  getHistory: () => ipcRenderer.invoke('chat:history'),
  onShowHistory: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('history:show', listener);
    return () => ipcRenderer.removeListener('history:show', listener);
  },
});
