'use strict';

// 設定ウィンドウ（settings-window.html）を開くことと、そこに見せる今の設定。
// 自動起動や会話の共有などの設定を1つの窓にまとめる。項目を足すときは
// settings-window.html に行を足し、読み書きの ipc を足す（その機能のファイルか、ここに）

const { app, BrowserWindow, ipcMain, screen, net } = require('electron');
const path = require('path');
const state = require('./state');
const { currentModel } = require('./gemini');
const { CALENDAR_MODES, CALENDAR_REFRESH_CHOICES, MASCOT_LOOKS, GEMINI_MODELS } = require('../settings');
const { TONE_AXES, TONE_NG_ITEMS, TONE_NAME_MAX_CHARS, PLAIN_TONE_PRESET_INDEX, toneSteps } = require('../tone');
const { soundChoices, SOUND_VOLUMES } = require('../sounds');
const { monthUsage, SEARCH_FREE_PER_MONTH } = require('../token-log');
const { ApiKeyStore, SAVED_SOURCE, DEFAULT_SOURCE } = require('../api-key');
const { localDateKey } = require('../calendar');

function openSettingsWindow() {
  // もう開いていたら、新しく開かずに手前に出す
  if (state.settingsWin) {
    const win = state.settingsWin;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  // 項目が全部見える高さ。画面が小さいときは収まる高さにして、中でスクロールさせる
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 480,
    height: Math.min(780, workArea.height - 40),
    useContentSize: true,
    minWidth: 360,
    minHeight: 300,
    title: 'Desktop Mascot の設定',
    icon: path.join(state.ROOT, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(state.ROOT, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  state.settingsWin = win;
  win.setMenu(null);
  win.loadFile('settings-window.html');
  win.once('ready-to-show', () => state.settingsWin?.show());
  win.on('closed', () => {
    state.settingsWin = null;
  });
}

/** 設定ウィンドウに見せる今の設定 */
function settingsState() {
  const { settings, googleAuth } = state;
  return {
    openAtLogin: settings.openAtLogin,
    historyFolder: settings.historyFolder,
    // 開発中（npm start）は Windows の自動起動の登録を変えないので、画面でそう伝える
    isPackaged: app.isPackaged,
    calendar: {
      mode: settings.calendarMode,
      modeChoices: CALENDAR_MODES.map(({ id, name }) => ({ id, name })),
      // 会話で予定を触るときだけ、毎回この分だけ入力が増える（実測値）
      chatTokens: 1040,
      hasClient: googleAuth.hasClient(),
      email: googleAuth.email,
      signingIn: Boolean(googleAuth.signingIn),
      refreshMinutes: settings.calendarRefreshMinutes,
      refreshChoices: [...CALENDAR_REFRESH_CHOICES],
    },
    look: { id: settings.mascotLook, choices: [...MASCOT_LOOKS] },
    model: { id: settings.geminiModel, choices: GEMINI_MODELS.map(({ id, name }) => ({ id, name })) },
    webSearch: settings.webSearch,
    keepPast: settings.keepPast,
    apiKey: apiKeyState(),
    usage: usageState(),
    tone: {
      index: settings.tonePresetIndex,
      presets: settings.tonePresets.map((preset) => ({ name: preset.name, axes: { ...preset.axes } })),
      // つまみの説明と、止まる所（段）は tone.js が持っている。
      // Gemini に渡す文そのもの（levels の例文や caveat）は画面に出さないので渡さない
      axes: TONE_AXES.map((axis) => ({ id: axis.id, name: axis.name, note: axis.note, steps: toneSteps(axis) })),
      // このプリセットだけは、つまみを使わない（今までの口調のまま）
      plainIndex: PLAIN_TONE_PRESET_INDEX,
      nameMaxChars: TONE_NAME_MAX_CHARS,
      // つまみをどこまで上げてもしないこと（画面に並べて見せる）
      ngItems: [...TONE_NG_ITEMS],
    },
    sound: {
      choices: soundChoices(),
      volume: settings.soundVolume,
      volumeChoices: SOUND_VOLUMES.map(({ id, name }) => ({ id, name })),
      notify: { id: settings.notifySound, fileName: soundFileName('notify') },
      reply: { id: settings.replySound, fileName: soundFileName('reply') },
    },
  };
}

/** その音のコピーがあれば、その名前（設定の画面に出す） */
function soundFileName(slot) {
  const file = state.settings[`${slot}SoundFile`];
  return file ? path.basename(file) : '';
}

/**
 * 設定画面に出す API キーの状態。キーそのものは渡さず、最後の4文字だけ見せる。
 * 環境変数から読むか、画面で貼ったキーを使うか、どちらか1つ（mode）
 */
function apiKeyState() {
  const { settings, apiKeys } = state;
  const envName = ApiKeyStore.envName(settings.apiKeySource) || ApiKeyStore.envName(DEFAULT_SOURCE);
  return {
    mode: settings.apiKeySource === SAVED_SOURCE ? 'saved' : 'env',
    envName,
    envHint: apiKeys.hint(`env:${envName}`),
    suggestions: apiKeys.envNames(),
    savedHint: apiKeys.hint(SAVED_SOURCE),
  };
}

/** 今月と今日の使った量（token-log.js） */
function usageState() {
  const log = state.tokenLog.load();
  const today = localDateKey(Date.now());
  const month = monthUsage(log, today.slice(0, 7));
  const todayRequests = Object.values(log.days[today] ?? {}).reduce((sum, counts) => sum + (Number(counts.requests) || 0), 0);
  return {
    month: `${Number(today.slice(5, 7))}月`,
    requests: month.requests,
    searches: month.searches,
    searchFree: SEARCH_FREE_PER_MONTH,
    // 送った分（prompt）と、返ってきた分（返事 output と考えた分 thoughts）
    sentTokens: month.prompt,
    replyTokens: month.output + month.thoughts,
    todayRequests,
  };
}

// 設定が変わったら、設定ウィンドウの表示を合わせる（トレイのメニューは menu.js が合わせる）
state.events.on('settings-changed', () => {
  const win = state.settingsWin;
  if (win && !win.isDestroyed()) win.webContents.send('settings:changed', settingsState());
});

// 設定ウィンドウからの呼び出しだけを受け付ける
function fromSettingsWindow(event) {
  return state.settingsWin && event.sender === state.settingsWin.webContents;
}

ipcMain.handle('settings:get', (event) => (fromSettingsWindow(event) ? settingsState() : null));

// 豆の見た目。絵は index.html に4つとも置いてあるので、名前を渡すだけでよい
ipcMain.handle('look:get', () => state.settings.mascotLook);

ipcMain.handle('settings:set-mascot-look', (event, id) => {
  if (fromSettingsWindow(event) && MASCOT_LOOKS.some((look) => look.id === id)) {
    state.updateSettings({ mascotLook: id });
    if (state.win && !state.win.isDestroyed()) state.win.webContents.send('look:changed', id);
    state.settingsChanged();
  }
  return settingsState();
});

// 返事を作るモデル。次に話しかけるときから新しいモデルになる
ipcMain.handle('settings:set-model', (event, id) => {
  if (fromSettingsWindow(event) && GEMINI_MODELS.some((model) => model.id === id)) {
    state.updateSettings({ geminiModel: id });
    state.settingsChanged();
  }
  return settingsState();
});

// 使う API キーを選ぶ。次に話しかけるときから効く
ipcMain.handle('settings:set-api-key-source', (event, id) => {
  // 環境変数は名前の形だけ見る（まだ無い名前でも選べる。画面で「見つからない」と出す）。貼ったキーは保存してあるときだけ
  const valid = id === SAVED_SOURCE ? Boolean(state.apiKeys.saved) : Boolean(ApiKeyStore.envName(id));
  if (fromSettingsWindow(event) && valid) {
    state.updateSettings({ apiKeySource: id });
    state.settingsChanged();
  }
  return settingsState();
});

// 設定画面で入れたキーを、使えるか Google に確かめてから保存する（モデルの情報を聞くだけなので料金はかからない）
ipcMain.handle('settings:save-api-key', async (event, key) => {
  if (!fromSettingsWindow(event)) return { ok: false, message: '' };
  const text = String(key ?? '').trim();
  if (!text) return { ok: false, message: 'キーが空です。' };
  let checked = true;
  try {
    const res = await net.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel().id}`, {
      headers: { 'x-goog-api-key': text },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, message: 'このキーは使えないみたいです。コピーし直して、もう一度入れてください。' };
    }
    checked = res.ok;
  } catch {
    checked = false;
  }
  try {
    state.apiKeys.save(text);
  } catch (err) {
    return { ok: false, message: `保存できませんでした: ${err.message}` };
  }
  state.updateSettings({ apiKeySource: SAVED_SOURCE });
  state.settingsChanged();
  return {
    ok: true,
    message: checked ? '保存しました。このキーを使います。' : '保存しました。ただ、つながらなくて使えるかは確かめられませんでした。',
  };
});

// 設定画面で入れたキーを消す。それを使っていたら、環境変数 GEMINI_API_KEY に戻す
ipcMain.handle('settings:clear-api-key', (event) => {
  if (fromSettingsWindow(event)) {
    state.apiKeys.clear();
    if (state.settings.apiKeySource === SAVED_SOURCE) state.settings = { ...state.settings, apiKeySource: DEFAULT_SOURCE };
    state.saveSettings();
    state.settingsChanged();
  }
  return settingsState();
});

// 昨日より前の会話を残して使うか。切る前にためた分は消さない（戻せばまた使う）
ipcMain.handle('settings:set-keep-past', (event, enabled) => {
  if (fromSettingsWindow(event) && typeof enabled === 'boolean' && enabled !== state.settings.keepPast) {
    state.updateSettings({ keepPast: enabled, keepPastOffAt: enabled ? 0 : Date.now() });
    state.settingsChanged();
  }
  return settingsState();
});

// 会話で Google 検索を使うか。次に話しかけるときから効く
ipcMain.handle('settings:set-web-search', (event, enabled) => {
  if (fromSettingsWindow(event) && typeof enabled === 'boolean') {
    state.updateSettings({ webSearch: enabled });
    state.settingsChanged();
  }
  return settingsState();
});

module.exports = { openSettingsWindow, settingsState, fromSettingsWindow };
