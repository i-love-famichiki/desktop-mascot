'use strict';

// アプリの設定を JSON ファイルに保存する（終了しても覚えておく）。
// Electron に依存しないので、node だけでテストできる（test/settings.test.js）。
//
// ファイルの中身:
//   { "openAtLogin": true, "historyFolder": "", "lastShareParent": "",
//     "calendarMode": "off", "calendarRefreshMinutes": 15,
//     "notifySound": "chime", "replySound": "pop", "soundVolume": "medium",
//     "notifySoundFile": "", "replySoundFile": "", "mascotLook": "pixel-fine",
//     "tonePresetIndex": 0, "tonePresets": [ { "name": "...", "axes": { ... } }, ... ] }

const fs = require('fs');
const path = require('path');
const { isSoundId, isVolumeId } = require('./sounds');
const { DEFAULT_TONE_PRESETS, normalizeTonePresets, normalizeTonePresetIndex } = require('./tone');

// カレンダー連携の使い方。予定の通知（10分前・朝のまとめ）はアプリの中で文章を作るので Gemini を通さないが、
// 会話で予定を読み書きするには、道具の説明を毎回 Gemini に送ることになる（実測 約1,040トークン／回）。
// 通知だけほしい人がその分を払わずに済むよう、3つに分けてある
const CALENDAR_MODES = Object.freeze([
  { id: 'off', name: '使わない' },
  { id: 'notify', name: '予定の通知だけ受け取る' },
  { id: 'full', name: '会話でも予定を読み書きする' },
]);

// カレンダーの予定を読み直す間隔（分）として選べる値。短いほど早く気づくが、その分 Google への問い合わせが増える
const CALENDAR_REFRESH_CHOICES = Object.freeze([5, 15, 30, 60]);

// 返事を作る AI モデル。thinking は「モデルが内部で考えた分」で、出力として課金される。
// lite は考えないので、切る指定（thinkingBudget）を送ると 400 になる。実測:
//   flash-lite …「1+1は？」で 考えた分 0 / thinkingBudget を送ると 400
//   flash      …「1+1は？」で 考えた分 53 / thinkingBudget: 0 で 0 になる
const GEMINI_MODELS = Object.freeze([
  { id: 'gemini-3.5-flash-lite', name: '軽い（flash-lite）', thinking: false },
  { id: 'gemini-3.5-flash', name: 'かしこい（flash）', thinking: true },
]);

// 豆の見た目。index.html にこの名前の絵（data-look）が置いてある
const MASCOT_LOOKS = Object.freeze([
  { id: 'smooth', name: 'なめらか（前の豆）' },
  { id: 'pixel-coarse', name: '8ビット・あらい' },
  { id: 'pixel-normal', name: '8ビット・ふつう' },
  { id: 'pixel-fine', name: '8ビット・こまかい' },
]);

const DEFAULT_SETTINGS = Object.freeze({
  // Windows にサインインしたとき自動で立ち上げる
  openAtLogin: true,
  // ほかの PC と会話を共有するフォルダ（Google ドライブの中など）。空なら共有しない
  historyFolder: '',
  // 共有フォルダを選ぶダイアログを次に開く場所（共有をやめても覚えておく）
  lastShareParent: '',
  // Google カレンダー連携の使い方（CALENDAR_MODES の名前。ログイン情報は別のファイル。google-auth.js）
  calendarMode: 'off',
  // 予定を読み直す間隔（分）。ほかの所で予定を足したり動かしたりしても、この間隔で気づく
  calendarRefreshMinutes: 15,
  // お知らせ（タイマー・リマインダー・カレンダー）の音。sounds.js の名前か 'none' / 'custom'
  notifySound: 'chime',
  // 返事が出たときの音
  replySound: 'pop',
  // 音の大きさ（small / medium / large）
  soundVolume: 'medium',
  // 「自分の音」を選んだときの、コピーしたファイルの場所
  notifySoundFile: '',
  replySoundFile: '',
  // 豆の見た目（MASCOT_LOOKS の名前）
  mascotLook: 'pixel-fine',
  // 返事を作る AI モデル（GEMINI_MODELS の名前）
  geminiModel: 'gemini-3.5-flash-lite',
  // 口調のプリセット（5個）と、最後に使っていたものの番号。中身は tone.js
  tonePresetIndex: 0,
  tonePresets: DEFAULT_TONE_PRESETS,
  // 最後に口調を変えた時刻。それより前の返事の口調を、まめにまねさせないために使う
  toneChangedAt: 0,
});

/** 設定を読む。ファイルが無い・壊れている・知らない値は初期値で補う */
function loadSettings(filePath) {
  let data = {};
  try {
    // メモ帳や PowerShell で保存すると先頭に BOM が付くことがあるので外して読む
    data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[settings] 設定ファイルが読めないので初期値を使います:', err.message);
  }

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof data?.[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = data[key];
  }
  // 前のかたち（calendarEnabled: true/false）で保存された設定も、そのまま使えるようにする
  if (typeof data?.calendarMode !== 'string' && typeof data?.calendarEnabled === 'boolean') {
    settings.calendarMode = data.calendarEnabled ? 'full' : 'off';
  }
  if (!CALENDAR_MODES.some((mode) => mode.id === settings.calendarMode)) settings.calendarMode = DEFAULT_SETTINGS.calendarMode;

  // 手で書き換えられていても、選べる値のどれかにする
  if (!CALENDAR_REFRESH_CHOICES.includes(settings.calendarRefreshMinutes)) {
    settings.calendarRefreshMinutes = DEFAULT_SETTINGS.calendarRefreshMinutes;
  }
  for (const key of ['notifySound', 'replySound']) {
    if (!isSoundId(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
  }
  if (!isVolumeId(settings.soundVolume)) settings.soundVolume = DEFAULT_SETTINGS.soundVolume;
  if (!MASCOT_LOOKS.some((look) => look.id === settings.mascotLook)) settings.mascotLook = DEFAULT_SETTINGS.mascotLook;
  if (!GEMINI_MODELS.some((model) => model.id === settings.geminiModel)) settings.geminiModel = DEFAULT_SETTINGS.geminiModel;
  // 口調は入れ子になっているので、中のつまみの値まで tone.js に整えてもらう
  settings.tonePresets = normalizeTonePresets(data?.tonePresets);
  settings.tonePresetIndex = normalizeTonePresetIndex(settings.tonePresetIndex);
  return settings;
}

/** 設定を保存する。書きかけで壊れないよう、別名に書いてから置き換える */
function saveSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { DEFAULT_SETTINGS, CALENDAR_MODES, CALENDAR_REFRESH_CHOICES, MASCOT_LOOKS, GEMINI_MODELS, loadSettings, saveSettings };
