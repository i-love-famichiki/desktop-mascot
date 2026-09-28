'use strict';

// 使ったトークンの記録のテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TokenLog, addUsage, normalizeLog, monthUsage, TOKEN_LOG_KEEP_DAYS, UNKNOWN_MODEL } = require('../lib/token-log');

const usage = (prompt, output, thoughts) => ({ promptTokenCount: prompt, candidatesTokenCount: output, thoughtsTokenCount: thoughts });

test('日ごと・モデルごとに分けて足していく', () => {
  let log = normalizeLog(null);
  log = addUsage(log, { date: '2026-09-21', model: 'lite', usage: usage(1600, 100, 0), searched: false });
  log = addUsage(log, { date: '2026-09-21', model: 'lite', usage: usage(1700, 80), searched: true });
  log = addUsage(log, { date: '2026-09-21', model: 'flash', usage: usage(2000, 90, 300), searched: false });
  log = addUsage(log, { date: '2026-09-22', model: 'lite', usage: {}, searched: false });

  assert.deepEqual(log.days['2026-09-21'].lite, { requests: 2, prompt: 3300, output: 180, thoughts: 0, searches: 1 });
  assert.deepEqual(log.days['2026-09-21'].flash, { requests: 1, prompt: 2000, output: 90, thoughts: 300, searches: 0 });
  assert.deepEqual(log.days['2026-09-22'].lite, { requests: 1, prompt: 0, output: 0, thoughts: 0, searches: 0 });
});

test('元の記録は書きかえない', () => {
  const log = normalizeLog(null);
  addUsage(log, { date: '2026-09-21', model: 'lite', usage: usage(1, 1), searched: false });
  assert.deepEqual(log.days, {});
});

test('古い日は、決まった日数を超えたら消す', () => {
  let log = normalizeLog(null);
  const start = new Date(2025, 0, 1);
  for (let i = 0; i < TOKEN_LOG_KEEP_DAYS + 5; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    log = addUsage(log, { date, model: 'lite', usage: usage(1, 1), searched: false });
  }
  const dates = Object.keys(log.days);
  assert.equal(dates.length, TOKEN_LOG_KEEP_DAYS);
  assert.equal(dates.includes('2025-01-01'), false);
});

test('前の形（今日の合計だけ）の記録は、モデル不明として残す', () => {
  const log = normalizeLog({ date: '2026-09-15', requests: 4, prompt: 100, output: 20, thoughts: 0, searches: 1 });
  assert.deepEqual(log.days['2026-09-15'][UNKNOWN_MODEL], { requests: 4, prompt: 100, output: 20, thoughts: 0, searches: 1 });
});

test('ファイルに書いて、立ち上げ直しても数え続ける。壊れたファイルは0から', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-log-'));
  const file = path.join(dir, 'sub', 'token-log.json');
  try {
    new TokenLog(file).record({ date: '2026-09-22', model: 'lite', usage: usage(10, 2), searched: false });
    const total = new TokenLog(file).record({ date: '2026-09-22', model: 'lite', usage: usage(5, 1), searched: false });
    assert.deepEqual(total, { requests: 2, prompt: 15, output: 3, thoughts: 0, searches: 0 });

    fs.writeFileSync(file, '{ こわれた', 'utf8');
    const fresh = new TokenLog(file).record({ date: '2026-09-22', model: 'lite', usage: usage(7, 1), searched: false });
    assert.equal(fresh.requests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('月の合計: その月の日だけを足し、モデルごとの値段で料金の目安を出す', () => {
  const log = {
    days: {
      '2026-08-31': { 'gemini-3.5-flash-lite': { requests: 9, prompt: 9e6, output: 0, thoughts: 0, searches: 0 } },
      '2026-09-01': { 'gemini-3.5-flash-lite': { requests: 2, prompt: 1e6, output: 1e6, thoughts: 0, searches: 1 } },
      '2026-09-02': { 'gemini-3.5-flash': { requests: 1, prompt: 1e6, output: 0, thoughts: 1e6, searches: 0 } },
    },
  };
  const total = monthUsage(log, '2026-09');
  assert.equal(total.requests, 3);
  assert.equal(total.searches, 1);
  // lite: 0.54 + 4.5、flash: 1.5 + 考えた分 9（出力の値段）
  assert.equal(Math.round(total.usd * 100) / 100, 15.54);
  assert.equal(total.yen, Math.round(total.usd * 150));
});

test('月の合計: 検索は月5000回まで無料。知らないモデルは軽い方の値段で数える', () => {
  const log = { days: { '2026-09-01': { [UNKNOWN_MODEL]: { requests: 6000, prompt: 1e6, output: 0, thoughts: 0, searches: 6000 } } } };
  const total = monthUsage(log, '2026-09');
  assert.equal(Math.round(total.usd * 100) / 100, Math.round((0.54 + 14) * 100) / 100);
  assert.deepEqual(monthUsage(log, '2026-10'), { requests: 0, prompt: 0, output: 0, thoughts: 0, searches: 0, usd: 0, yen: 0 });
});
