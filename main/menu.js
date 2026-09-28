'use strict';

// タスクトレイと、右クリックのメニュー（履歴・リセット・設定・このアプリについて）

const { app, ipcMain, Menu, Tray } = require('electron');
const path = require('path');
const state = require('./state');
const { showMascot, toggleMascot } = require('./mascot-window');
const { showDialog } = require('./dialogs');
const { openSettingsWindow } = require('./settings-panel');
const { currentModel } = require('./gemini');

/** @type {Tray | null} */
let tray = null;

function createTray() {
  // アイコンは後で差し替える。空でもトレイには載る。
  tray = new Tray(path.join(state.ROOT, 'assets', 'tray.png'));
  tray.setToolTip('Desktop Mascot（クリックで表示／非表示）');
  tray.setContextMenu(buildMenu());
  // 左クリックで隠す／表示を切り替える（右クリックはメニュー）
  tray.on('click', toggleMascot);
}

/** トレイのメニューは作った時点の表示を持っているので、状態が変わったら作り直す */
function refreshTrayMenu() {
  tray?.setContextMenu(buildMenu());
}

state.events.on('window-visibility', refreshTrayMenu);
state.events.on('settings-changed', refreshTrayMenu);

/** トレイと、マスコットの右クリックで共通のメニュー */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.win?.isVisible() ? 'マスコットを隠す' : 'マスコットを表示', click: toggleMascot },
    { type: 'separator' },
    {
      label: '会話の履歴を見る',
      click: () => {
        if (!state.win) return;
        showMascot();
        state.win.webContents.send('history:show');
      },
    },
    { label: '会話をリセット', click: confirmReset },
    { type: 'separator' },
    // 自動起動や会話の共有などの設定は、設定ウィンドウにまとめている
    { label: '設定を開く…', click: openSettingsWindow },
    { type: 'separator' },
    { label: 'このアプリについて', click: showAbout },
    { label: '終了', click: () => app.quit() },
  ]);
}

ipcMain.on('menu:show', () => {
  if (state.win) buildMenu().popup({ window: state.win });
});

// ---------------------------------------------------------------------------
// このアプリについて（バージョン情報）
// ---------------------------------------------------------------------------
async function showAbout() {
  await showDialog({
    type: 'none',
    icon: path.join(state.ROOT, 'build', 'icon.png'),
    title: 'このアプリについて',
    message: `Desktop Mascot  バージョン ${app.getVersion()}`,
    detail: [
      'デスクトップに住む枝豆のマスコット',
      '',
      `AI のモデル: ${currentModel().id}`,
      `会話の保存先: ${state.store.filePath}`,
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    ].join('\n'),
    buttons: ['閉じる'],
  });
}

// 履歴はファイルに残るようになったので、消す前に確認する
async function confirmReset() {
  const options = {
    type: 'warning',
    buttons: ['消す', 'やめる'],
    defaultId: 1,
    cancelId: 1,
    title: '会話をリセット',
    message: '会話の履歴と、古い会話の要約をすべて消します。',
    detail: state.settings.keepPast
      ? 'マスコットは今までの話を覚えていない状態に戻ります。話した中身は保管庫に残るので、「前にこんな話したっけ？」と聞けば探せます。'
      : 'マスコットは今までの話を覚えていない状態に戻ります。「昔の会話を覚える」を切っているので、切った後に話した中身は保管庫にも残しません。',
  };
  // 自動起動の待ち時間中はまだウィンドウが無いので、トレイから押されたら単独で出す
  const { response } = await showDialog(options);
  if (response !== 0) return;
  try {
    await state.store.clear();
  } catch (err) {
    await showDialog({
      type: 'error',
      title: '会話をリセットできませんでした',
      message: '会話を保管庫に残せなかったので、リセットしませんでした。',
      detail: `${err.message}\n\n共有中なら、ドライブのアプリが動いているか確かめてから、もう一度試してください。`,
    });
  }
}

module.exports = { createTray };
