'use strict';

// API キーの保存のテスト。safeStorage は、中身を逆さまにするだけの偽物で置き換える。
// 実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApiKeyStore, SAVED_SOURCE, DEFAULT_SOURCE } = require('../api-key');

const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...s].reverse().join('')),
  decryptString: (b) => [...b.toString()].reverse().join(''),
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-key-'));
  return path.join(dir, 'gemini-key.json');
}

test('初期値は環境変数 GEMINI_API_KEY', () => {
  assert.equal(DEFAULT_SOURCE, 'env:GEMINI_API_KEY');
  const store = new ApiKeyStore({ file: tempFile(), env: { GEMINI_API_KEY: ' paid-1234 ' }, safeStorage: fakeSafeStorage() });
  store.load();
  assert.equal(store.get(DEFAULT_SOURCE), 'paid-1234');
  assert.equal(store.hint(DEFAULT_SOURCE), '…1234');
});

test('候補に出す環境変数は、名前に GEMINI が付くものだけ。名前を入れれば、ほかの名前も使える', () => {
  const env = { KABU_API: 'secret', GEMINI_API_FREE: 'free-key', GEMINI_API_KEY: 'paid-key', GEMINI_EMPTY: ' ', PATH: 'x' };
  const store = new ApiKeyStore({ file: tempFile(), env, safeStorage: fakeSafeStorage() });
  assert.deepEqual(store.envNames(), ['GEMINI_API_KEY', 'GEMINI_API_FREE']);
  assert.equal(store.get('env:GEMINI_API_FREE'), 'free-key');
  assert.equal(store.get('env:KABU_API'), 'secret');
  assert.equal(ApiKeyStore.envName('env:GEMINI_API_FREE'), 'GEMINI_API_FREE');
  assert.equal(ApiKeyStore.envName('env:A B'), '');
  assert.equal(store.get('env:NOT_SET_GEMINI'), '');
  assert.equal(store.get('何か変な値'), '');
  assert.equal(store.get('env:A B'), '');
});

test('設定画面で入れたキーは、暗号化して保存され、読み直せる', () => {
  const file = tempFile();
  const store = new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage() });
  store.save('  saved-key-5678\n');
  assert.equal(store.get(SAVED_SOURCE), 'saved-key-5678');
  // ファイルには平文で残らない
  assert.ok(!fs.readFileSync(file, 'utf8').includes('saved-key-5678'));

  const reloaded = new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage() });
  reloaded.load();
  assert.equal(reloaded.get(SAVED_SOURCE), 'saved-key-5678');
});

test('消すとファイルも消え、入れたキーは空になる', () => {
  const file = tempFile();
  const store = new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage() });
  store.save('saved-key');
  store.clear();
  assert.equal(store.get(SAVED_SOURCE), '');
  assert.equal(fs.existsSync(file), false);
});

test('空のキーは保存しない。暗号化できない PC では平文で置かずに失敗する', () => {
  const file = tempFile();
  assert.throws(() => new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage() }).save('  '));
  assert.throws(() => new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage(false) }).save('key'));
  assert.equal(fs.existsSync(file), false);
});

test('壊れたファイルや解けないキーは、入れていない扱いにする', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ 壊れている');
  const store = new ApiKeyStore({ file, env: {}, safeStorage: fakeSafeStorage() });
  store.load();
  assert.equal(store.get(SAVED_SOURCE), '');

  fs.writeFileSync(file, JSON.stringify({ key: 'abc' }));
  const failing = { ...fakeSafeStorage(), decryptString: () => { throw new Error('解けない'); } };
  const other = new ApiKeyStore({ file, env: {}, safeStorage: failing });
  other.load();
  assert.equal(other.get(SAVED_SOURCE), '');
});
