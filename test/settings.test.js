'use strict';

// 設定ファイルの読み書きのテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, CALENDAR_REFRESH_CHOICES, MASCOT_LOOKS, loadSettings, saveSettings } = require('../settings');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-settings-'));
  return path.join(dir, 'settings.json');
}

test('ファイルが無ければ初期値（自動起動は ON）', () => {
  assert.deepEqual(loadSettings(tempFile()), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarEnabled: false, calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'pixel-fine' });
  assert.equal(DEFAULT_SETTINGS.openAtLogin, true);
});

test('保存した設定を読み直せる（OFF にしたら OFF のまま）', () => {
  const file = tempFile();
  saveSettings(file, {
    openAtLogin: false,
    historyFolder: 'G:\\マイドライブ\\Desktop Mascot',
    lastShareParent: 'G:\\マイドライブ',
    calendarEnabled: true,
    calendarRefreshMinutes: 30,
    notifySound: 'bell',
    replySound: 'none',
    soundVolume: 'large',
    notifySoundFile: '',
    replySoundFile: '',
    mascotLook: 'smooth',
  });
  assert.deepEqual(loadSettings(file), {
    openAtLogin: false,
    historyFolder: 'G:\\マイドライブ\\Desktop Mascot',
    lastShareParent: 'G:\\マイドライブ',
    calendarEnabled: true,
    calendarRefreshMinutes: 30,
    notifySound: 'bell',
    replySound: 'none',
    soundVolume: 'large',
    notifySoundFile: '',
    replySoundFile: '',
    mascotLook: 'smooth',
  });
});

test('先頭に BOM が付いたファイルも読める（メモ帳や PowerShell で保存した場合）', () => {
  const file = tempFile();
  fs.writeFileSync(file, '﻿{ "openAtLogin": false }', 'utf8');
  assert.deepEqual(loadSettings(file), { openAtLogin: false, historyFolder: '', lastShareParent: '', calendarEnabled: false, calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'pixel-fine' });
});

test('壊れたファイル・型の違う値は初期値で補う', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ こわれている');
  assert.deepEqual(loadSettings(file), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarEnabled: false, calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'pixel-fine' });

  fs.writeFileSync(file, JSON.stringify({ openAtLogin: 'no', historyFolder: 3, unknown: 1 }));
  assert.deepEqual(loadSettings(file), { openAtLogin: true, historyFolder: '', lastShareParent: '', calendarEnabled: false, calendarRefreshMinutes: 15, notifySound: 'chime', replySound: 'pop', soundVolume: 'medium', notifySoundFile: '', replySoundFile: '', mascotLook: 'pixel-fine' });
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

  fs.writeFileSync(file, JSON.stringify({ mascotLook: 'smooth' }));
  assert.equal(loadSettings(file).mascotLook, 'smooth');

  for (const bad of ['', 'ドット', 'SMOOTH', 8, null]) {
    fs.writeFileSync(file, JSON.stringify({ mascotLook: bad }));
    assert.equal(loadSettings(file).mascotLook, 'pixel-fine');
  }
});
