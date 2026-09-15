'use strict';

// 設定ファイルの読み書きのテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, loadSettings, saveSettings } = require('../settings');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-settings-'));
  return path.join(dir, 'settings.json');
}

test('ファイルが無ければ初期値（自動起動は ON）', () => {
  assert.deepEqual(loadSettings(tempFile()), { openAtLogin: true });
  assert.equal(DEFAULT_SETTINGS.openAtLogin, true);
});

test('保存した設定を読み直せる（OFF にしたら OFF のまま）', () => {
  const file = tempFile();
  saveSettings(file, { openAtLogin: false });
  assert.deepEqual(loadSettings(file), { openAtLogin: false });
});

test('先頭に BOM が付いたファイルも読める（メモ帳や PowerShell で保存した場合）', () => {
  const file = tempFile();
  fs.writeFileSync(file, '﻿{ "openAtLogin": false }', 'utf8');
  assert.deepEqual(loadSettings(file), { openAtLogin: false });
});

test('壊れたファイル・型の違う値は初期値で補う', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ こわれている');
  assert.deepEqual(loadSettings(file), { openAtLogin: true });

  fs.writeFileSync(file, JSON.stringify({ openAtLogin: 'no', unknown: 1 }));
  assert.deepEqual(loadSettings(file), { openAtLogin: true });
});
