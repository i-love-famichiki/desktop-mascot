'use strict';

// 設定ファイルの読み書きのテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, CALENDAR_MODES, CALENDAR_REFRESH_CHOICES, MASCOT_LOOKS, GEMINI_MODELS, loadSettings, saveSettings } = require('../lib/settings');
// 下の比べる値に毎回書くと長いので、AI まわりの初期値はまとめておく
const aiDefaults = () => ({
  geminiModel: 'gemini-3.5-flash-lite',
  apiKeySource: 'env:GEMINI_API_KEY',
  keepPast: true,
  keepPastOffAt: 0,
  webSearch: true,
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-settings-'));
  return path.join(dir, 'settings.json');
}

test('ファイルが無ければ初期値（自動起動は ON）', () => {
  assert.deepEqual(loadSettings(tempFile()), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarMode: 'off', calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'smooth', ...aiDefaults() });
  assert.equal(DEFAULT_SETTINGS.openAtLogin, true);
});

test('保存した設定を読み直せる（OFF にしたら OFF のまま）', () => {
  const file = tempFile();
  saveSettings(file, {
    openAtLogin: false,
    historyFolder: 'G:\\マイドライブ\\Desktop Mascot',
    lastShareParent: 'G:\\マイドライブ',
    calendarMode: 'full',
    calendarRefreshMinutes: 30,
    notifySound: 'bell',
    replySound: 'none',
    soundVolume: 'large',
    notifySoundFile: '',
    replySoundFile: '',
    mascotLook: 'smooth',
    ...aiDefaults(),
  });
  assert.deepEqual(loadSettings(file), {
    openAtLogin: false,
    historyFolder: 'G:\\マイドライブ\\Desktop Mascot',
    lastShareParent: 'G:\\マイドライブ',
    calendarMode: 'full',
    calendarRefreshMinutes: 30,
    notifySound: 'bell',
    replySound: 'none',
    soundVolume: 'large',
    notifySoundFile: '',
    replySoundFile: '',
    mascotLook: 'smooth',
    ...aiDefaults(),
  });
});

test('先頭に BOM が付いたファイルも読める（メモ帳や PowerShell で保存した場合）', () => {
  const file = tempFile();
  fs.writeFileSync(file, '﻿{ "openAtLogin": false }', 'utf8');
  assert.deepEqual(loadSettings(file), { openAtLogin: false, historyFolder: '', lastShareParent: '', calendarMode: 'off', calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'smooth', ...aiDefaults() });
});

test('壊れたファイル・型の違う値は初期値で補う', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ こわれている');
  assert.deepEqual(loadSettings(file), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarMode: 'off', calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'smooth', ...aiDefaults() });

  fs.writeFileSync(file, JSON.stringify({ openAtLogin: 'no', historyFolder: 3, unknown: 1 }));
  assert.deepEqual(loadSettings(file), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarMode: 'off', calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'smooth', ...aiDefaults() });
});

test('予定を読み直す間隔は、選べる値以外なら初期値（15分）にする', () => {
  const file = tempFile();
  assert.deepEqual([...CALENDAR_REFRESH_CHOICES], [5, 15, 30, 60]);

  fs.writeFileSync(file, JSON.stringify({ calendarRefreshMinutes: 5 }));
  assert.equal(loadSettings(file).calendarRefreshMinutes, 5);

  // 0 や、選択肢に無い数、数でない値は 15 分に戻す
  for (const bad of [0, -5, 7, 1440, '30', null]) {
    fs.writeFileSync(file, JSON.stringify({ calendarRefreshMinutes: bad }));
    assert.equal(loadSettings(file).calendarRefreshMinutes, 15);
  }
});

test('豆の見た目は、index.html にある絵の名前だけ', () => {
  const file = tempFile();
  assert.deepEqual(MASCOT_LOOKS.map((look) => look.id), ['smooth', 'pixel-coarse', 'pixel-normal', 'pixel-fine']);

  fs.writeFileSync(file, JSON.stringify({ mascotLook: 'pixel-fine' }));
  assert.equal(loadSettings(file).mascotLook, 'pixel-fine');

  for (const bad of ['', 'ドット', 'SMOOTH', 8, null]) {
    fs.writeFileSync(file, JSON.stringify({ mascotLook: bad }));
    assert.equal(loadSettings(file).mascotLook, 'smooth');
  }
});

// 口調のプリセットは 2026-09-29 に廃止した。前の版で保存した設定ファイルにも残っているので、読んだら捨てる
test('前の版の口調の設定が残っていても、読み込みでは捨てる', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ tonePresetIndex: 1, tonePresets: [{ name: '毒舌' }], toneChangedAt: 123 }));
  const settings = loadSettings(file);
  for (const key of ['tonePresetIndex', 'tonePresets', 'toneChangedAt']) assert.ok(!(key in settings), key);
});

test('AI モデルは、選べるものだけ（知らない名前なら軽いほうに戻す）', () => {
  const file = tempFile();
  assert.deepEqual(GEMINI_MODELS.map((model) => model.id), [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-3.1-pro-preview',
  ]);
  // 考えるのを止められない lite と Pro に、止める指定を送ると 400 になるので、止められるかを持たせてある
  assert.deepEqual(GEMINI_MODELS.map((model) => model.stopThinking), [false, true, true, true, true, false]);
  // 選ぶときに確かめるのは、高い Pro だけ
  assert.deepEqual(GEMINI_MODELS.filter((model) => model.expensive).map((model) => model.id), ['gemini-3.1-pro-preview']);
  // 画面には Google の正式な名前を出す
  for (const model of GEMINI_MODELS) assert.match(model.name, /^Gemini \d/);

  fs.writeFileSync(file, JSON.stringify({ geminiModel: 'gemini-3.5-flash' }));
  assert.equal(loadSettings(file).geminiModel, 'gemini-3.5-flash');

  for (const bad of ['', 'gpt-4', 'GEMINI-3.5-FLASH', 3, null]) {
    fs.writeFileSync(file, JSON.stringify({ geminiModel: bad }));
    assert.equal(loadSettings(file).geminiModel, 'gemini-3.5-flash-lite');
  }
});

test('API キーは、環境変数か設定画面で入れたキー。変な値なら GEMINI_API_KEY に戻す', () => {
  const file = tempFile();
  for (const good of ['saved', 'env:GEMINI_API_FREE']) {
    fs.writeFileSync(file, JSON.stringify({ apiKeySource: good }));
    assert.equal(loadSettings(file).apiKeySource, good);
  }
  for (const bad of ['', 'env:', 'env:A B', 'GEMINI_API_KEY', 3]) {
    fs.writeFileSync(file, JSON.stringify({ apiKeySource: bad }));
    assert.equal(loadSettings(file).apiKeySource, 'env:GEMINI_API_KEY');
  }
});

test('Google 検索は初期値 ON。切った設定は残り、変な値なら ON に戻す', () => {
  const file = tempFile();
  assert.equal(loadSettings(file).webSearch, true);

  saveSettings(file, { ...loadSettings(file), webSearch: false });
  assert.equal(loadSettings(file).webSearch, false);

  fs.writeFileSync(file, JSON.stringify({ webSearch: 'off' }));
  assert.equal(loadSettings(file).webSearch, true);
});

test('カレンダーは3つの使い方から選ぶ（前の ON/OFF で保存された設定も読める）', () => {
  const file = tempFile();
  assert.deepEqual(CALENDAR_MODES.map((mode) => mode.id), ['off', 'notify', 'full']);

  fs.writeFileSync(file, JSON.stringify({ calendarMode: 'notify' }));
  assert.equal(loadSettings(file).calendarMode, 'notify');

  // 前のかたち（calendarEnabled）で保存された設定は、そのままの働きになるように読み替える
  fs.writeFileSync(file, JSON.stringify({ calendarEnabled: true }));
  assert.equal(loadSettings(file).calendarMode, 'full');
  fs.writeFileSync(file, JSON.stringify({ calendarEnabled: false }));
  assert.equal(loadSettings(file).calendarMode, 'off');
  // 新しいかたちが入っていれば、そちらを使う
  fs.writeFileSync(file, JSON.stringify({ calendarEnabled: true, calendarMode: 'notify' }));
  assert.equal(loadSettings(file).calendarMode, 'notify');

  for (const bad of ['', 'ON', 'ぜんぶ', 3, null]) {
    fs.writeFileSync(file, JSON.stringify({ calendarMode: bad }));
    assert.equal(loadSettings(file).calendarMode, 'off');
  }
});
