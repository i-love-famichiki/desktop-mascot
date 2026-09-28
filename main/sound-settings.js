'use strict';

// 音（お知らせの音と、返事が出たときの音）
// 内蔵の音はレンダラーがその場で作る。「自分の音」は、選ばれたファイルをアプリの中に
// コピーしておき、その中身をレンダラーへ渡して鳴らす（sounds.js / sound-player.js）

const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const state = require('./state');
const { showDialog } = require('./dialogs');
const { settingsState, fromSettingsWindow } = require('./settings-panel');
const { soundChoices, SOUND_VOLUMES, AUDIO_EXTENSIONS, SoundError, importSoundFile, playable, volumeById } = require('../sounds');

const SOUND_SLOTS = { notify: 'お知らせの音', reply: '返事の音' };

/** レンダラーに渡す、今鳴らすもの */
function soundState() {
  const { settings } = state;
  return {
    notify: playable(settings.notifySound, settings.notifySoundFile),
    reply: playable(settings.replySound, settings.replySoundFile),
    volume: volumeById(settings.soundVolume),
  };
}

function saveSoundSettings(next) {
  state.updateSettings(next);
  // 次に鳴らすときから新しい音になるよう、豆の窓にも伝える
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send('sound:changed');
  state.settingsChanged();
}

// 豆の窓と設定の窓（試し聞き）の両方が使う
ipcMain.handle('sound:get', () => soundState());

ipcMain.handle('settings:set-sound', (event, slot, id) => {
  if (fromSettingsWindow(event) && SOUND_SLOTS[slot] && soundChoices().some((choice) => choice.id === id)) {
    saveSoundSettings({ [`${slot}Sound`]: id });
  }
  return settingsState();
});

ipcMain.handle('settings:set-sound-volume', (event, id) => {
  if (fromSettingsWindow(event) && SOUND_VOLUMES.some((volume) => volume.id === id)) saveSoundSettings({ soundVolume: id });
  return settingsState();
});

// 「自分の音」に使うファイルを選ぶ
ipcMain.handle('settings:choose-sound-file', async (event, slot) => {
  if (!fromSettingsWindow(event) || !SOUND_SLOTS[slot]) return settingsState();
  const { canceled, filePaths } = await dialog.showOpenDialog(state.settingsWin, {
    title: `${SOUND_SLOTS[slot]}に使うファイルを選ぶ`,
    buttonLabel: 'この音を使う',
    defaultPath: app.getPath('music'),
    filters: [{ name: '音のファイル', extensions: AUDIO_EXTENSIONS.map((ext) => ext.slice(1)) }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return settingsState();
  try {
    // 選ばれたらそのまま「自分の音」に切り替える
    saveSoundSettings({ [`${slot}SoundFile`]: importSoundFile(path.join(state.soundsDir, slot), filePaths[0]), [`${slot}Sound`]: 'custom' });
  } catch (err) {
    if (!(err instanceof SoundError)) throw err;
    await showDialog({ type: 'error', title: '音を使えませんでした', message: 'この音のファイルは使えませんでした。', detail: err.message });
  }
  return settingsState();
});
