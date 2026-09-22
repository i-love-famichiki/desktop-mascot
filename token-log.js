'use strict';

// Gemini に話しかけるたびに、使ったトークンを日ごと・モデルごとに数えておく。
// 返事といっしょに届く usageMetadata の数を書くだけなので、記録のためにトークンは使わない。
// 請求の画面には「どのモデルにいくら」までしか出ないので、何回・何トークンかはこちらで数える。
// Electron に依存しないので、node だけでテストできる（test/token-log.test.js）。
//
// ファイル（token-log.json）の形:
//   { "version": 1, "days": { "2026-09-22": { "gemini-3.5-flash-lite": { "requests": 3, ... } } } }

const fs = require('fs');
const path = require('path');

// 残しておく日数。これより古い日は書き込むときに消す
const TOKEN_LOG_KEEP_DAYS = 400;

// 1版の token-log.json は「今日の合計」だけだった。どのモデルかは分からないので、この名前で残す
const UNKNOWN_MODEL = '（モデル不明）';

function emptyCounts() {
  return { requests: 0, prompt: 0, output: 0, thoughts: 0, searches: 0 };
}

/** 読んだ中身を今の形にそろえる。読めないもの・古い形も、捨てずにできるだけ残す */
function normalizeLog(raw) {
  const log = { version: 1, days: {} };
  if (!raw || typeof raw !== 'object') return log;
  if (raw.days && typeof raw.days === 'object') {
    log.days = raw.days;
  } else if (typeof raw.date === 'string') {
    const counts = emptyCounts();
    for (const key of Object.keys(counts)) counts[key] = Number(raw[key]) || 0;
    log.days[raw.date] = { [UNKNOWN_MODEL]: counts };
  }
  return log;
}

/**
 * 1回ぶんを足した記録を返す（元の log は変えない）
 * @param {{ days: object }} log
 * @param {{ date: string, model: string, usage: object, searched: boolean }} entry
 */
function addUsage(log, { date, model, usage, searched }) {
  const days = { ...log.days };
  const day = { ...days[date] };
  const counts = { ...emptyCounts(), ...day[model] };
  counts.requests += 1;
  counts.prompt += usage.promptTokenCount ?? 0;
  counts.output += usage.candidatesTokenCount ?? 0;
  // 「考えた分」は画面には出ないが、出力として課金される
  counts.thoughts += usage.thoughtsTokenCount ?? 0;
  // Google 検索が走った回は、トークンとは別に1回いくらで課金されることがある
  counts.searches += searched ? 1 : 0;
  day[model] = counts;
  days[date] = day;

  // 日付の文字列（2026-09-22）は、並べるとそのまま古い順になる
  const keep = Object.keys(days).sort().slice(-TOKEN_LOG_KEEP_DAYS);
  return { version: 1, days: Object.fromEntries(keep.map((key) => [key, days[key]])) };
}

class TokenLog {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
  }

  load() {
    try {
      return normalizeLog(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return normalizeLog(null);
    }
  }

  /**
   * 1回ぶんを書き足し、その日のそのモデルの合計を返す。書けなくても会話は止めない
   * @param {{ date: string, model: string, usage: object, searched: boolean }} entry
   */
  record(entry) {
    const log = addUsage(this.load(), entry);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(log, null, 2), 'utf8');
    } catch (err) {
      console.warn('[tokens] 記録できませんでした:', err.message);
    }
    return log.days[entry.date][entry.model];
  }
}

module.exports = { TokenLog, addUsage, normalizeLog, TOKEN_LOG_KEEP_DAYS, UNKNOWN_MODEL };
