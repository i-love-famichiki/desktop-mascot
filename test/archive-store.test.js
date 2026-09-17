'use strict';

// 会話の保管庫と、昔の会話を探す処理のテスト。Gemini は呼ばない。
// 実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveStore, searchConversations, parseDay } = require('../archive-store');
const { HistoryStore } = require('../history-store');

// 「今」は 2026-09-15 12:00（ローカル時刻）とする
const NOW = new Date(2026, 8, 15, 12, 0).getTime();
const at = (year, month, day, hour = 10, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-archive-'));
}

function say(role, content, time) {
  return { role, content, at: time };
}

test('月ごとのファイルに分けて保管し、同じ発言は1つにまとめる', async () => {
  const dir = path.join(tempDir(), 'archive');
  const archive = new ArchiveStore(dir);
  await archive.add([say('user', '8月の話', at(2026, 8, 31, 23, 59)), say('user', '9月の話', at(2026, 9, 1, 0, 0))]);
  await archive.add([say('user', '9月の話', at(2026, 9, 1, 0, 0)), say('assistant', '9月の返事', at(2026, 9, 1, 0, 1))]);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08.json', '2026-09.json']);
  const all = await archive.readRange();
  assert.deepEqual(all.map((m) => m.content), ['8月の話', '9月の話', '9月の返事']);
  const september = await archive.readRange({ from: at(2026, 9, 1, 0, 0) });
  assert.deepEqual(september.map((m) => m.content), ['9月の話', '9月の返事']);
});

test('壊れた月のファイルには書かずに失敗する（中身を上書きして消さない）', async () => {
  const dir = path.join(tempDir(), 'archive');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '2026-09.json'), '{ こわれている');
  const archive = new ArchiveStore(dir);
  await assert.rejects(archive.add([say('user', '話', at(2026, 9, 1))]));
  assert.equal(fs.readFileSync(path.join(dir, '2026-09.json'), 'utf8'), '{ こわれている');
  // 探すときは壊れた月を飛ばす
  assert.deepEqual(await archive.readRange(), []);
});

test('フォルダを移すと、元の保管庫は残したまま新しい方へ混ぜて写す', async () => {
  const from = path.join(tempDir(), 'archive');
  const to = path.join(tempDir(), 'archive');
  await new ArchiveStore(to).add([say('user', 'ほかの PC の話', at(2026, 9, 2))]);
  const archive = new ArchiveStore(from);
  await archive.add([say('user', 'この PC の話', at(2026, 9, 1))]);

  await archive.moveTo(to);
  assert.deepEqual((await archive.readRange()).map((m) => m.content), ['この PC の話', 'ほかの PC の話']);
  assert.equal(fs.existsSync(path.join(from, '2026-09.json')), true);
});

test('要約した日の会話は、履歴から消す前に保管庫へ入る', async () => {
  const file = path.join(tempDir(), 'history.json');
  const store = new HistoryStore(file);
  store.messages = [say('user', '転職の相談', at(2026, 9, 1)), say('user', '今日の話', at(2026, 9, 15))];
  await store.compact(async () => '転職の相談をした', NOW);

  assert.deepEqual(store.messages.map((m) => m.content), ['今日の話']);
  const archived = await store.archive.readRange();
  assert.deepEqual(archived.map((m) => m.content), ['転職の相談']);
});

test('保管庫に書けなかった日は、要約せず詳しい履歴を残す', async () => {
  const dir = tempDir();
  const store = new HistoryStore(path.join(dir, 'history.json'));
  // archive という名前のファイルを置いて、フォルダを作れなくする
  fs.writeFileSync(path.join(dir, 'archive'), '');
  store.messages = [say('user', '転職の相談', at(2026, 9, 1))];
  const result = await store.compact(async () => '転職の相談をした', NOW);

  assert.deepEqual(result, { summarizedDays: [], failedDay: '2026-09-01' });
  assert.deepEqual(store.messages.map((m) => m.content), ['転職の相談']);
  assert.deepEqual(store.summaries, []);
});

test('リセットしても、話した中身は保管庫に残る', async () => {
  const store = new HistoryStore(path.join(tempDir(), 'history.json'));
  await store.append(say('user', '消したくない話', at(2026, 9, 15)));
  await store.clear();

  assert.deepEqual(store.messages, []);
  assert.deepEqual((await store.archive.readRange()).map((m) => m.content), ['消したくない話']);
});

test('ほかの PC でリセットされて消える発言も、保管庫に残る', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'history.json');
  const other = new HistoryStore(file);
  const mine = new HistoryStore(file);
  // この PC だけが持っている（まだファイルに書いていない）発言
  mine.messages = [say('user', 'この PC だけの話', at(2026, 9, 15, 9))];
  await other.clear();

  await mine.sync();
  await mine.archive.saving;
  assert.deepEqual(mine.messages, []);
  assert.deepEqual((await mine.archive.readRange()).map((m) => m.content), ['この PC だけの話']);
});

test('言葉で探すと、当たった発言を前後の発言と一緒に返す', () => {
  const messages = [
    say('user', 'おはよう', at(2025, 9, 20, 9)),
    say('assistant', 'おはよう！', at(2025, 9, 20, 9, 1)),
    say('user', '転職するか迷ってる', at(2025, 9, 20, 21)),
    say('assistant', '今の仕事のどこがつらいの？', at(2025, 9, 20, 21, 1)),
    say('user', 'カレーの作り方', at(2026, 9, 1)),
  ];
  const result = searchConversations({ messages }, { keywords: ['転職'] });
  assert.equal(result.total, 1);
  assert.deepEqual(result.hits[0].map((m) => m.content), ['おはよう！', '転職するか迷ってる', '今の仕事のどこがつらいの？']);
});

test('多くの言葉に当たったものほど先。全角・半角や大文字・小文字は区別しない', () => {
  const messages = [
    say('user', 'ELECTRON の話', at(2026, 9, 1)),
    say('user', 'ｅｌｅｃｔｒｏｎで exe を作る話', at(2026, 8, 1)),
  ];
  const result = searchConversations({ messages }, { keywords: ['electron', 'EXE'] });
  assert.deepEqual(result.hits.map((hit) => hit.map((m) => m.content)), [
    ['ｅｌｅｃｔｒｏｎで exe を作る話'],
    ['ELECTRON の話'],
  ]);
});

test('期間で絞れる。要約も探す', () => {
  const messages = [say('user', '転職の話', at(2025, 9, 20)), say('user', '転職の話ふたたび', at(2026, 9, 1))];
  const summaries = [{ date: '2025-09-05', summary: '転職について相談された' }];
  const result = searchConversations(
    { messages, summaries },
    { keywords: ['転職'], from: parseDay('2025-09'), to: parseDay('2025-09', true) },
  );
  assert.deepEqual(result.hits.flat().map((m) => m.content), ['転職の話']);
  assert.deepEqual(result.summaries, summaries);
});

test('日付の読み取り: 日まで・月まで・読めないもの', () => {
  assert.equal(parseDay('2025-09-20'), at(2025, 9, 20, 0, 0));
  assert.equal(parseDay('2025-09-20', true), at(2025, 9, 21, 0, 0) - 1);
  assert.equal(parseDay('2025-09'), at(2025, 9, 1, 0, 0));
  assert.equal(parseDay('2025-12', true), at(2026, 1, 1, 0, 0) - 1);
  assert.equal(parseDay('去年'), undefined);
  assert.equal(parseDay(undefined), undefined);
});
