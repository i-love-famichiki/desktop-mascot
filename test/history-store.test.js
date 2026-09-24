'use strict';

// 履歴の保存と要約のテスト。Gemini は呼ばず、要約は偽物の関数で置き換える。
// 日時は compact(summarize, now) の now で固定するので、PC の日付を変えなくてよい。
// 実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, retentionCutoff } = require('../history-store');

// 「今」は 2026-09-15 12:00（ローカル時刻）とする。
// 直近7日 = 9/9〜9/15 は残し、9/8 以前を要約する
const NOW = new Date(2026, 8, 15, 12, 0).getTime();
const at = (month, day, hour = 10, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-history-'));
  return path.join(dir, 'history.json');
}

function say(role, content, time) {
  return { role, content, at: time };
}

test('境目: 9/13 23:59 までは要約に回し、9/14 0:00（昨日）からは詳しいまま残す', async () => {
  assert.equal(retentionCutoff(NOW), at(9, 14, 0, 0));

  const store = new HistoryStore(tempFile());
  store.messages = [
    say('user', '13日の夜の話', at(9, 13, 23, 59)),
    say('user', '14日の朝の話', at(9, 14, 0, 0)),
  ];
  const calls = [];
  await store.compact(async (date, messages) => {
    calls.push([date, messages.map((m) => m.content)]);
    return '13日のまとめ';
  }, NOW);

  assert.deepEqual(calls, [['2026-09-13', ['13日の夜の話']]]);
  assert.deepEqual(store.messages.map((m) => m.content), ['14日の朝の話']);
  assert.deepEqual(store.summaries.map((s) => [s.date, s.summary]), [['2026-09-13', '13日のまとめ']]);
});

test('古い会話は日ごとに要約され、ファイルに保存されて読み直せる', async () => {
  const file = tempFile();
  const store = new HistoryStore(file);
  store.messages = [
    say('user', '猫の名前はミケ', at(9, 1)),
    say('assistant', 'かわいい名前だね', at(9, 1, 10, 1)),
    say('user', '歯医者に行く', at(9, 5)),
    say('user', '今日の話', at(9, 15)),
  ];

  const result = await store.compact(async (date, messages) => `${date} は ${messages.length} 件`, NOW);

  assert.deepEqual(result, { summarizedDays: ['2026-09-01', '2026-09-05'], failedDay: null });
  const reloaded = new HistoryStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.messages.map((m) => m.content), ['今日の話']);
  assert.deepEqual(reloaded.summaries.map((s) => [s.date, s.summary]), [
    ['2026-09-01', '2026-09-01 は 2 件'],
    ['2026-09-05', '2026-09-05 は 1 件'],
  ]);
});

test('要約に失敗した日は詳しいまま残し、そこで止める（次回の起動でやり直す）', async () => {
  const store = new HistoryStore(tempFile());
  store.messages = [
    say('user', '1日の話', at(9, 1)),
    say('user', '2日の話', at(9, 2)),
    say('user', '3日の話', at(9, 3)),
  ];
  const called = [];
  const result = await store.compact(async (date) => {
    called.push(date);
    if (date === '2026-09-02') throw new Error('429');
    return 'まとめ';
  }, NOW);

  assert.deepEqual(result, { summarizedDays: ['2026-09-01'], failedDay: '2026-09-02' });
  assert.deepEqual(called, ['2026-09-01', '2026-09-02'], '失敗したあとの日は呼ばない');
  assert.deepEqual(store.messages.map((m) => m.content), ['2日の話', '3日の話']);

  // 次の起動では続きから要約される
  const retry = await store.compact(async () => 'やり直しのまとめ', NOW);
  assert.deepEqual(retry.summarizedDays, ['2026-09-02', '2026-09-03']);
  assert.equal(store.messages.length, 0);
});

test('空の要約は失敗扱いにして、詳しい会話を消さない', async () => {
  const store = new HistoryStore(tempFile());
  store.messages = [say('user', '1日の話', at(9, 1))];
  const result = await store.compact(async () => '   ', NOW);
  assert.equal(result.failedDay, '2026-09-01');
  assert.equal(store.messages.length, 1);
  assert.equal(store.summaries.length, 0);
});

test('要約を待っている間に話しかけられても、その発言は消えない', async () => {
  const store = new HistoryStore(tempFile());
  store.messages = [say('user', '古い話', at(9, 1))];
  await store.compact(async () => {
    await store.append(say('user', '要約中に話しかけた', at(9, 15, 12, 1)));
    return 'まとめ';
  }, NOW);
  assert.deepEqual(store.messages.map((m) => m.content), ['要約中に話しかけた']);
});

test('要約するものが無ければ Gemini（要約の関数）を呼ばない', async () => {
  const store = new HistoryStore(tempFile());
  store.messages = [say('user', '今日の話', at(9, 15))];
  let called = false;
  const result = await store.compact(async () => { called = true; return 'x'; }, NOW);
  assert.equal(called, false);
  assert.deepEqual(result, { summarizedDays: [], failedDay: null });
});

test('ファイルが無ければ空で始まる', () => {
  const store = new HistoryStore(tempFile());
  store.load();
  assert.deepEqual([store.messages, store.summaries], [[], []]);
});

test('先頭に BOM が付いた履歴ファイルも読める', () => {
  const file = tempFile();
  fs.writeFileSync(file, '﻿' + JSON.stringify({ messages: [say('user', 'こんにちは', at(9, 15))], summaries: [] }), 'utf8');
  const store = new HistoryStore(file);
  store.load();
  assert.deepEqual(store.messages.map((m) => m.content), ['こんにちは']);
});

test('壊れた JSON は別名で退避して、空で始める', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ こわれている');
  const store = new HistoryStore(file);
  store.load();
  assert.deepEqual([store.messages, store.summaries], [[], []]);
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.broken-'));
  assert.equal(backups.length, 1);
});

test('システムプロンプト用の要約は、新しいものから30件まで・日付の古い順に並ぶ', () => {
  const store = new HistoryStore(tempFile());
  // 並び順は日付の古い順（compact が並べ替えて保存している前提）
  store.summaries = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(2026, 6, 1 + i);
    return { date: d.toISOString().slice(0, 10), summary: `まとめ${i + 1}` };
  });
  const lines = store.summariesForPrompt().split('\n');
  assert.equal(lines.length, 30);
  assert.match(lines[0], /まとめ11$/);
  assert.match(lines.at(-1), /まとめ40$/);
});

test('システムプロンプト用の要約は、全体で1000文字を超えない', () => {
  const store = new HistoryStore(tempFile());
  store.summaries = Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${i + 1}`, summary: 'あ'.repeat(140) }));
  const text = store.summariesForPrompt();
  assert.ok(text.length <= 1000 + 30, `長さ ${text.length}`);
  assert.ok(text.split('\n').length < 30);
});

// ---------------------------------------------------------------------------
// ほかの PC との共有（2 つの HistoryStore が同じファイルを使う）
// ---------------------------------------------------------------------------

test('昨日より前の会話: 今日の分は含めず、時刻の古い順に並ぶ', () => {
  const store = new HistoryStore(tempFile());
  store.messages = [
    say('user', '10日の話', at(9, 10)),
    say('assistant', '10日の返事', at(9, 10, 10, 1)),
    say('user', '昨日の夜の話', at(9, 14, 23, 59)),
    say('user', '今日の話', at(9, 15, 0, 0)),
  ];
  assert.deepEqual(
    store.pastDaysMessages(NOW).map((m) => m.content),
    ['10日の話', '10日の返事', '昨日の夜の話'],
  );
});

test('昨日より前の会話: 長い発言は300文字で切り、全体は新しいものから2000文字まで', () => {
  const store = new HistoryStore(tempFile());
  store.messages = Array.from({ length: 20 }, (_, i) => say('user', `${i}`.padEnd(500, 'あ'), at(9, 14, 10, i)));
  const past = store.pastDaysMessages(NOW);
  // 301文字（300文字＋…）が6件で1806文字。7件目を足すと2000文字を超えるので入らない
  assert.equal(past.length, 6);
  assert.ok(past.every((m) => m.content.length === 301 && m.content.endsWith('…')));
  assert.ok(past[0].content.startsWith('14'));
  assert.ok(past.at(-1).content.startsWith('19'));
  // 元の履歴は切られていない
  assert.equal(store.messages[19].content.length, 500);
});

test('共有: 2 台が交互に話しても、どちらの発言も消えない', async () => {
  const file = tempFile();
  const pcA = new HistoryStore(file);
  const pcB = new HistoryStore(file);
  pcA.load();
  pcB.load();

  await pcA.append(say('user', 'A で話した', at(9, 15, 10)));
  // B はまだ A の発言を読み込んでいないまま話す
  await pcB.append(say('user', 'B で話した', at(9, 15, 11)));

  const reloaded = new HistoryStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.messages.map((m) => m.content), ['A で話した', 'B で話した']);
});

test('共有: sync でほかの PC の発言を取り込み、変わったかどうかを返す', async () => {
  const file = tempFile();
  const pcA = new HistoryStore(file);
  const pcB = new HistoryStore(file);

  await pcA.append(say('user', 'A で話した', at(9, 15, 10)));
  assert.equal(await pcB.sync(), true);
  assert.deepEqual(pcB.messages.map((m) => m.content), ['A で話した']);
  assert.equal(await pcB.sync(), false, '2 回目は変わらない');
});

test('共有: 片方でリセットしたら、もう片方の古い発言は生き返らない', async () => {
  const file = tempFile();
  const pcA = new HistoryStore(file);
  const pcB = new HistoryStore(file);
  await pcA.append(say('user', '消したい話', Date.now() - 60_000));
  await pcB.sync();

  await pcA.clear();
  // B はリセットを知らないまま、新しく話す
  await pcB.append(say('user', 'リセット後の話', Date.now() + 1000));

  const reloaded = new HistoryStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.messages.map((m) => m.content), ['リセット後の話']);
});

test('共有: 片方で要約した日の発言は、もう片方から混ぜても戻らない', async () => {
  const file = tempFile();
  const pcA = new HistoryStore(file);
  const pcB = new HistoryStore(file);
  await pcA.append(say('user', '古い話', at(9, 1)));
  await pcB.sync();

  await pcA.compact(async () => '1日のまとめ', NOW);
  await pcB.append(say('user', '今日の話', at(9, 15)));

  const reloaded = new HistoryStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.messages.map((m) => m.content), ['今日の話']);
  assert.deepEqual(reloaded.summaries.map((s) => s.summary), ['1日のまとめ']);
});

test('共有: 保存先を移すと、移した先にあった履歴と混ざる', async () => {
  const shared = tempFile();
  const other = new HistoryStore(shared);
  await other.append(say('user', 'ほかの PC の話', at(9, 15, 9)));

  const store = new HistoryStore(tempFile());
  await store.append(say('user', 'この PC の話', at(9, 15, 10)));
  await store.moveTo(shared);

  const reloaded = new HistoryStore(shared);
  reloaded.load();
  assert.deepEqual(reloaded.messages.map((m) => m.content), ['ほかの PC の話', 'この PC の話']);
});
