'use strict';

// 自動起動（Windows にサインインしたとき立ち上がる）

const { app, ipcMain } = require('electron');
const state = require('./state');
const { settingsState, fromSettingsWindow } = require('./settings-panel');

// 自動起動で起動されたときに付く目印
const AUTOSTART_ARG = '--autostart';
// 自動起動のときは、ほかの常駐アプリと重ならないよう少し待ってから表示する
const AUTOSTART_DELAY_MS = 15 * 1000;
// レジストリ（HKCU\...\CurrentVersion\Run）に書く名前
const LOGIN_ITEM_NAME = 'DesktopMascot';

function setOpenAtLogin(enabled) {
  state.updateSettings({ openAtLogin: enabled });
  applyOpenAtLogin();
  state.settingsChanged();
}

/**
 * 設定に合わせて、Windows の自動起動の登録（レジストリの Run）を書く／消す。
 * 起動のたびに呼び、フォルダを移したときなどもここで登録し直す。
 */
function applyOpenAtLogin() {
  // 開発中（npm start）に登録すると、インストールした exe の登録を electron.exe で
  // 上書きしてしまうので、登録は exe のときだけ行う
  if (!app.isPackaged) {
    console.log('[startup] 開発中なので自動起動の登録は変えません');
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: state.settings.openAtLogin,
    name: LOGIN_ITEM_NAME,
    path: process.execPath,
    args: [AUTOSTART_ARG],
  });
}

ipcMain.handle('settings:set-open-at-login', (event, enabled) => {
  if (fromSettingsWindow(event)) setOpenAtLogin(Boolean(enabled));
  return settingsState();
});

module.exports = { applyOpenAtLogin, AUTOSTART_ARG, AUTOSTART_DELAY_MS };
