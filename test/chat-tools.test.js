'use strict';

// 道具の説明を渡すかどうかの判定のテスト。実行:  npm test
//
// 拾いすぎ（false → true）は、今まで通りに戻るだけで損はしない。
// 拾い漏れ（true → false）は、その回に道具が使えなくなるので、こちらを厚く見る。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolGroups } = require('../chat-tools');

const at = (text, state) => toolGroups(text, state);

test('ただの雑談では、どの道具も渡さない（ここでトークンが浮く）', () => {
  for (const text of ['こんばんは', 'ありがとう', 'おなかすいた', 'そうなんだ', '豆って何色？']) {
    assert.deepEqual(at(text, { calendarInChat: true }), { timer: false, history: false, calendar: false, pastDays: false }, text);
  }
});

test('タイマーやリマインダーを頼む言い方は、取りこぼさない', () => {
  const texts = [
    '3分後に教えて',
    '10分たったら知らせて',
    'タイマーセットして',
    '明日の9時に歯医者ってリマインドして',
    '1時間後に起こして',
    'さっきのタイマー、キャンセルして',
    '洗濯物のこと忘れないようにしたい',
    '5分で',
  ];
  for (const text of texts) assert.equal(at(text).timer, true, text);
});

test('昔の会話を聞かれたときは、探す道具を渡す', () => {
  for (const text of ['前に話した転職の話って何だっけ', '去年の夏、何してたっけ', 'あのとき言ってたお店どこ', '覚えてる？']) {
    assert.equal(at(text).history, true, text);
  }
});

test('カレンダーは、会話で使う設定のときだけ渡す', () => {
  const text = '明日の予定は？';
  assert.equal(at(text, { calendarInChat: true }).calendar, true);
  // 「通知だけ」や「使わない」のときは、言葉が合っても渡さない
  assert.equal(at(text, { calendarInChat: false }).calendar, false);
  assert.equal(at(text).calendar, false);

  for (const t of ['金曜15時に歯医者を入れて', '今週の会議いつ', 'カレンダー見せて', '土曜って空いてる？']) {
    assert.equal(at(t, { calendarInChat: true }).calendar, true, t);
  }
});

test('数字だけのメモ書き（全角でも）で頼まれても、カレンダーを渡す', () => {
  for (const t of ['１００１歓迎会１９００', '1001歓迎会1900', '９３０会議１０００', '10/1 19:00 飲み会', '3日に病院']) {
    assert.equal(at(t, { calendarInChat: true }).calendar, true, t);
  }
});

test('ひとつ前が予定の話なら、「入ってないよ」のような続きにもカレンダーを渡す', () => {
  assert.equal(at('入ってないよ', { calendarInChat: true, previousText: '９３０会議１０００' }).calendar, true);
  assert.equal(at('ほんと？', { calendarInChat: true, previousText: '明日の予定は？' }).calendar, true);
  // 前が雑談なら渡さない
  assert.equal(at('ほんと？', { calendarInChat: true, previousText: 'おなかすいた' }).calendar, false);
});

test('タイマーが登録されているときは、言葉が無くても渡す（取り消しや問い合わせに答えるため）', () => {
  assert.equal(at('こんばんは', { hasReminders: true }).timer, true);
  assert.equal(at('こんばんは', { hasReminders: false }).timer, false);
});

test('空や数字でない入力でも落ちない', () => {
  for (const bad of ['', null, undefined, 123]) {
    assert.deepEqual(at(bad), { timer: false, history: false, calendar: false, pastDays: false });
  }
});

test('昨日より前の会話は、昔の話が出たときだけ渡す（ふだんの雑談で約700トークン浮く）', () => {
  for (const t of ['昨日話したキーボード、届いたよ', 'この前の本なんだっけ', 'こないだの続きだけど', 'あれからどうなったと思う？', '前に言ってたお店']) {
    assert.equal(at(t).pastDays, true, t);
  }
  for (const t of ['おはよう', '円周率ってなんで無限？', '新しいキーボード買った！']) {
    assert.equal(at(t).pastDays, false, t);
  }
});

test('ひとつ前が昔の話なら、「それそれ」のような続きにも昨日より前の会話を渡す', () => {
  assert.equal(at('それそれ！', { previousText: '昨日の映画の話' }).pastDays, true);
  assert.equal(at('それそれ！', { previousText: 'おなかすいた' }).pastDays, false);
});
