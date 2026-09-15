'use strict';

// アプリの設定を JSON ファイルに保存する（終了しても覚えておく）。
// Electron に依存しないので、node だけでテストできる（test/settings.test.js）。
//
// ファイルの中身:  { "openAtLogin": true }

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  // Windows にサインインしたとき自動で立ち上げる
  openAtLogin: true,
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
  return settings;
}

/** 設定を保存する。書きかけで壊れないよう、別名に書いてから置き換える */
function saveSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { DEFAULT_SETTINGS, loadSettings, saveSettings };
