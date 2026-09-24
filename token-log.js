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

// 料金の目安（100 万トークンあたりのドル）。2026-09-22 に請求の画面と照らし合わせた値。
// 「考えた分」は出力として課金される。知らないモデル（1版の記録など）は軽い方の値で数える
const MODEL_PRICES = Object.freeze({
  'gemini-3.5-flash-lite': { input: 0.54, output: 4.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
});
const FALLBACK_PRICE = MODEL_PRICES['gemini-3.5-flash-lite'];
// Google 検索は月 5000 回まで無料、そのあと 1000 回で 14 ドル
const SEARCH_FREE_PER_MONTH = 5000;
const SEARCH_USD_PER_1000 = 14;
// 円に直すときの目安。為替で変わるので、画面では「約」を付けて出す
const YEN_PER_USD = 150;

/**
 * ある月（2026-09 の形）の合計と、料金の目安を返す。無料枠のキーならお金はかからない
 * @param {{ days: object }} log
 * @param {string} month
 */
function monthUsage(log, month) {
  const total = { ...emptyCounts(), usd: 0 };
  for (const [date, models] of Object.entries(log.days)) {
    if (!date.startsWith(`${month}-`)) continue;
    for (const [model, raw] of Object.entries(models ?? {})) {
      const counts = { ...emptyCounts(), ...raw };
      for (const key of Object.keys(emptyCounts())) total[key] += Number(counts[key]) || 0;
      const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
      total.usd += ((Number(counts.prompt) || 0) * price.input + ((Number(counts.output) || 0) + (Number(counts.thoughts) || 0)) * price.output) / 1e6;
    }
  }
  total.usd += (Math.max(0, total.searches - SEARCH_FREE_PER_MONTH) * SEARCH_USD_PER_1000) / 1000;
  total.yen = Math.round(total.usd * YEN_PER_USD);
  return total;
}

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

module.exports = { TokenLog, addUsage, normalizeLog, monthUsage, TOKEN_LOG_KEEP_DAYS, UNKNOWN_MODEL, YEN_PER_USD, SEARCH_FREE_PER_MONTH };
