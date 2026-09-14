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
  quit: () => ipcRenderer.send('app:quit'),
});
