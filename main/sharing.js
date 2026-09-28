'use strict';

// ほかの PC と会話を共有する
// 会話の履歴を Google ドライブなどのフォルダに置き、ほかの PC のマスコットと同じファイルを使う。
// 同期はドライブのアプリに任せ、こちらは保存のたびに混ぜることと、変化を見に行くことだけをする。

const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const state = require('./state');
const { dialogParent, showDialog } = require('./dialogs');
const { settingsState, fromSettingsWindow } = require('./settings-panel');

// 共有フォルダの中に作る、このアプリ用のフォルダの名前
const SHARE_SUBFOLDER = 'Desktop Mascot';
// 共有中、ほかの PC で書き足されていないかファイルを見に行く間隔
const SHARE_WATCH_INTERVAL_MS = 5 * 1000;

/**
 * 共有フォルダを最初に開く場所。
 * 前に選んだ場所があればそこから、無ければ Google ドライブか OneDrive があればそこから
 */
function defaultShareParent() {
  const candidates = [
    state.settings.lastShareParent,
    'G:\\マイドライブ',
    'G:\\My Drive',
    process.env.OneDrive,
    app.getPath('documents'),
  ];
  return candidates.find((dir) => dir && fs.existsSync(dir));
}

async function chooseShareFolder() {
  const options = {
    title: '会話を共有するフォルダを選ぶ',
    message: 'Google ドライブなど、ほかの PC と同期しているフォルダを選んでください',
    buttonLabel: 'このフォルダで共有',
    defaultPath: defaultShareParent(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const owner = dialogParent();
  const { canceled, filePaths } = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (canceled || !filePaths[0]) return;

  // 選んだフォルダの中に専用のフォルダを作る。専用のフォルダそのものを選んだときはそのまま使う
  const picked = filePaths[0];
  const folder = path.basename(picked) === SHARE_SUBFOLDER ? picked : path.join(picked, SHARE_SUBFOLDER);

  // 次に選ぶときも同じ場所から探せるよう覚えておく（共有をやめても消さない）
  const parent = path.basename(picked) === SHARE_SUBFOLDER ? path.dirname(picked) : picked;
  state.updateSettings({ lastShareParent: parent });

  try {
    await switchHistoryFolder(folder);
  } catch (err) {
    await showDialog({
      type: 'error',
      title: '会話を共有できませんでした',
      message: 'そのフォルダに会話を保存できませんでした。',
      detail: `${err.message}\n\nドライブのアプリが動いているか確かめてから、もう一度選んでください。`,
    });
    return;
  }
  await showDialog({
    type: 'info',
    title: '会話の共有を始めました',
    message: `会話を「${folder}」に保存します。`,
    detail: 'ほかの PC でも、右クリックメニューの「設定を開く…」→「ほかの PC と会話を共有」から、同じフォルダを選んでください。',
  });
}

async function stopSharing() {
  await switchHistoryFolder('');
  await showDialog({
    type: 'info',
    title: '会話の共有をやめました',
    message: 'これからの会話は、この PC の中だけに保存します。',
    detail: 'これまでの会話はこの PC にも残しています。共有フォルダの中身は消していません。',
  });
}

/** 履歴の保存先を移し、設定に残す。移した先にあった会話とは混ぜる */
async function switchHistoryFolder(folder) {
  const previous = state.settings.historyFolder;
  // 移し終わるまでは保存しない（失敗したら元に戻すため）
  state.settings = { ...state.settings, historyFolder: folder };
  try {
    await state.store.moveTo(state.historyFilePath());
  } catch (err) {
    // 保存できなかったら元の場所に戻す
    state.settings = { ...state.settings, historyFolder: previous };
    await state.store.moveTo(state.historyFilePath()).catch(() => {});
    throw err;
  }
  state.saveSettings();
  watchSharedHistory();
  state.settingsChanged();
}

let watchedFile = null;

/** 共有中は、ほかの PC が書き足していないかファイルを見に行き、変わっていたら取り込む */
function watchSharedHistory() {
  if (watchedFile) fs.unwatchFile(watchedFile);
  watchedFile = null;
  if (!state.settings.historyFolder || process.env.MASCOT_HISTORY_FILE) return;

  watchedFile = state.store.filePath;
  // ドライブが後からつながったとき（サインイン直後など）も、ファイルが現れた時点で気づける
  fs.watchFile(watchedFile, { interval: SHARE_WATCH_INTERVAL_MS }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    state.store.sync().then((changed) => {
      if (changed) console.log('[history] ほかの PC の会話を取り込みました');
    }).catch(() => {});
  });
}

ipcMain.handle('settings:choose-share-folder', async (event) => {
  if (fromSettingsWindow(event)) await chooseShareFolder();
  return settingsState();
});

ipcMain.handle('settings:stop-sharing', async (event) => {
  if (fromSettingsWindow(event) && state.settings.historyFolder) await stopSharing();
  return settingsState();
});

module.exports = { watchSharedHistory };
