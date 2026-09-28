'use strict';

// タイマーとリマインダーのテスト。日時は now で固定するので、PC の時計を待たなくてよい。
// 実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReminderStore, MAX_REMINDERS, LATE_MS } = require('../lib/reminder-store');

// 「今」は 2026-09-17 20:00（ローカル時刻）とする
const NOW = new Date(2026, 8, 17, 20, 0).getTime();
const MINUTE = 60 * 1000;

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-reminder-'));
  return path.join(dir, 'reminders.json');
}

test('タイマーは指定した秒数のあとに取り出せる', () => {
  const store = new ReminderStore(tempFile());
  const timer = store.addTimer(180, 'カップラーメンができたよ', NOW);
  assert.equal(timer.at, NOW + 3 * MINUTE);

  assert.deepEqual(store.takeDue(NOW + 3 * MINUTE - 1), []);
  const due = store.takeDue(NOW + 3 * MINUTE);
  assert.equal(due.length, 1);
  assert.equal(due[0].message, 'カップラーメンができたよ');
  assert.equal(due[0].late, false);
  // 1回知らせたら一覧から消える
  assert.deepEqual(store.takeDue(NOW + 10 * MINUTE), []);
});

test('リマインダーはタイムゾーン付きの日時で登録でき、ファイルに残る', () => {
  const file = tempFile();
  const store = new ReminderStore(file);
  const reminder = store.addReminder('2026-09-18T09:00:00+09:00', '歯医者', NOW);
  assert.equal(reminder.at, Date.parse('2026-09-18T09:00:00+09:00'));

  const reloaded = new ReminderStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.items, [reminder]);
});

test('タイマーはファイルに残さない（終了したら消える）', () => {
  const file = tempFile();
  const store = new ReminderStore(file);
  store.addReminder(NOW + 60 * MINUTE, '会議', NOW);
  store.addTimer(60, '', NOW);
  assert.equal(store.items.length, 2);

  const reloaded = new ReminderStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.items.map((item) => item.message), ['会議']);
});

test('起動していない間に過ぎたリマインダーは、次に取り出したとき late になる', () => {
  const file = tempFile();
  const store = new ReminderStore(file);
  store.addReminder(NOW + 10 * MINUTE, 'ゴミ出し', NOW);

  // 翌朝に起動した
  const nextMorning = NOW + 12 * 60 * MINUTE;
  const reloaded = new ReminderStore(file);
  reloaded.load();
  const due = reloaded.takeDue(nextMorning);
  assert.equal(due.length, 1);
  assert.equal(due[0].late, true);

  // 知らせたことはファイルにも残る（また起動しても二度は知らせない）
  const again = new ReminderStore(file);
  again.load();
  assert.deepEqual(again.takeDue(nextMorning), []);
});

test('少しだけ遅れて取り出したときは late にしない', () => {
  const store = new ReminderStore(tempFile());
  store.addTimer(60, '', NOW);
  assert.equal(store.takeDue(NOW + MINUTE + LATE_MS - 1)[0].late, false);
});

test('番号で取り消せる。無い番号は null', () => {
  const file = tempFile();
  const store = new ReminderStore(file);
  const first = store.addReminder(NOW + 60 * MINUTE, '会議', NOW);
  const second = store.addReminder(NOW + 120 * MINUTE, '電話', NOW);
  assert.notEqual(first.id, second.id);

  assert.equal(store.cancel(first.id), first);
  assert.equal(store.cancel(first.id), null);
  assert.equal(store.cancel(999), null);

  const reloaded = new ReminderStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.items.map((item) => item.message), ['電話']);
});

test('おかしな値は RangeError で断る', () => {
  const store = new ReminderStore(tempFile());
  assert.throws(() => store.addTimer(0, '', NOW), RangeError);
  assert.throws(() => store.addTimer(25 * 60 * 60, '', NOW), RangeError);
  assert.throws(() => store.addTimer(Number.NaN, '', NOW), RangeError);
  assert.throws(() => store.addReminder('あした', '歯医者', NOW), RangeError);
  assert.throws(() => store.addReminder(NOW - MINUTE, '歯医者', NOW), RangeError);
  assert.throws(() => store.addReminder(NOW + 400 * 24 * 60 * MINUTE, '歯医者', NOW), RangeError);
  assert.throws(() => store.addReminder(NOW + MINUTE, '  ', NOW), RangeError);
  assert.equal(store.items.length, 0);
});

test(`登録は ${MAX_REMINDERS} 件まで`, () => {
  const store = new ReminderStore(tempFile());
  for (let i = 0; i < MAX_REMINDERS; i++) store.addTimer(60 + i, '', NOW);
  assert.throws(() => store.addTimer(60, '', NOW), RangeError);
});

test('壊れたファイルは退避して空で始める', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ こわれている');
  const store = new ReminderStore(file);
  store.load();
  assert.deepEqual(store.items, []);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('reminders.json.broken-')), true);
});
