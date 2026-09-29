'use strict';

// メインプロセスのあちこちで使うもの（設定、保存先、窓）を1か所に置く。
// ほかのファイルは state.settings や state.win を、使うときにその都度読む（値を手元に写さない）

const { app, net, shell, safeStorage } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const { HistoryStore } = require('../lib/history-store');
const { ReminderStore } = require('../lib/reminder-store');
const { loadSettings, saveSettings } = require('../lib/settings');
const { TokenLog } = require('../lib/token-log');
const { ApiKeyStore } = require('../lib/api-key');
const { GoogleAuth } = require('../lib/google-auth');
const { Calendar } = require('../lib/calendar');

// アプリのファイル（index.html や preload.js）が置いてある所
const ROOT = path.join(__dirname, '..');

// 会話履歴と設定の保存先。exe ではアプリのフォルダに書き込めないことがあるので
// アプリ用の保存場所に置く。開発中（npm start）は今まで通りプロジェクトの data/ に置く
const dataDir = app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data');

// 設定（自動起動の ON/OFF など）。テストのときは MASCOT_SETTINGS_FILE で差し替えられる
const settingsFile = process.env.MASCOT_SETTINGS_FILE
  ? path.resolve(process.env.MASCOT_SETTINGS_FILE)
  : path.join(dataDir, 'settings.json');

const state = {
  ROOT,
  dataDir,
  settingsFile,
  settings: loadSettings(settingsFile),
  /** マスコットの窓 @type {import('electron').BrowserWindow | null} */
  win: null,
  /** 設定ウィンドウ。1つだけ開く（開いていないときは null） @type {import('electron').BrowserWindow | null} */
  settingsWin: null,
  // 'settings-changed'（設定が変わった）、'window-visibility'（豆を出した・隠した）、'window-loaded'（豆の画面を読み終えた）
  events: new EventEmitter(),
};

/** 今の設定をファイルに書く */
state.saveSettings = () => saveSettings(settingsFile, state.settings);

/** 設定の一部を差し替えて保存する */
state.updateSettings = (next) => {
  state.settings = { ...state.settings, ...next };
  state.saveSettings();
};

/** 設定が変わったら、トレイのメニューと設定ウィンドウの表示を合わせる */
state.settingsChanged = () => state.events.emit('settings-changed');

/** 会話履歴のファイルの場所。共有中は共有フォルダ、そうでなければこの PC の中 */
state.historyFilePath = () => {
  if (process.env.MASCOT_HISTORY_FILE) return path.resolve(process.env.MASCOT_HISTORY_FILE);
  return path.join(state.settings.historyFolder || dataDir, 'history.json');
};

// 会話履歴はメインプロセスだけが持ち、history.json に保存する（終了しても消えない）。
// テストのときは環境変数 MASCOT_HISTORY_FILE で保存先を差し替えられる。
state.store = new HistoryStore(state.historyFilePath());
// 「昔の会話を覚える」を切った後の発言は、保管庫に入れず、日付が変わったら捨てる
state.store.isEphemeral = (message) => !state.settings.keepPast && message.at >= state.settings.keepPastOffAt;

// リマインダーの保存先。ほかの PC と一緒に知らせないよう、共有中でもこの PC の中に置く。
// テストのときは MASCOT_REMINDER_FILE で差し替えられる
state.reminders = new ReminderStore(
  process.env.MASCOT_REMINDER_FILE
    ? path.resolve(process.env.MASCOT_REMINDER_FILE)
    : path.join(dataDir, 'reminders.json'),
);

// Google へのログインとカレンダー。ログイン情報はほかの PC と分けたいので、共有中でもこの PC の中に置く。
// テストのときは MASCOT_GOOGLE_DIR で置き場所を差し替えられる
const googleDir = process.env.MASCOT_GOOGLE_DIR ? path.resolve(process.env.MASCOT_GOOGLE_DIR) : dataDir;

// 「自分の音」に選ばれたファイルのコピーを置く所（お知らせ用と返事用で分ける）
state.soundsDir = path.join(dataDir, 'sounds');
state.googleAuth = new GoogleAuth({
  clientFile: path.join(googleDir, 'google-client.json'),
  tokenFile: path.join(googleDir, 'google-token.json'),
  fetch: (...args) => net.fetch(...args),
  openExternal: (url) => shell.openExternal(url),
  safeStorage,
});
// Gemini の API キー。設定画面で入れたキーは、この PC の中に暗号化して置く（共有フォルダには置かない）。
// テストのときは MASCOT_API_KEY_FILE で差し替えられる
state.apiKeys = new ApiKeyStore({
  file: process.env.MASCOT_API_KEY_FILE ? path.resolve(process.env.MASCOT_API_KEY_FILE) : path.join(dataDir, 'gemini-key.json'),
  env: process.env,
  safeStorage,
});
state.calendar = new Calendar({ auth: state.googleAuth, fetch: (...args) => net.fetch(...args) });
// 朝のまとめを最後に言った日。PC ごとに覚えておく
state.calendarStateFile = path.join(googleDir, 'calendar-state.json');

// 使ったトークンの記録。この PC の中に置く（共有フォルダには置かない）。
// テストのときは MASCOT_TOKEN_LOG_FILE で差し替えられる
state.tokenLog = new TokenLog(
  process.env.MASCOT_TOKEN_LOG_FILE
    ? path.resolve(process.env.MASCOT_TOKEN_LOG_FILE)
    : path.join(dataDir, 'token-log.json'),
);

module.exports = state;
