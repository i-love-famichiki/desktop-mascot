'use strict';

// 会話履歴をファイル（JSON）に保存し、古い会話は要約に置き換える。
// Electron に依存しないので、node だけでテストできる（test/history-store.test.js）。
//
// ファイルの中身:
//   {
//     "version": 1,
//     "messages":  [{ "role": "user" | "assistant", "content": "...", "at": 1757900000000 }],
//     "summaries": [{ "date": "2026-09-01", "summary": "...", "createdAt": 1757900000000 }]
//   }

const fs = require('fs');
const path = require('path');

// 今日を含めた直近7日分（例: 今日が 9/15 なら 9/9〜9/15）は詳しいまま残す
const RETAIN_DAYS = 7;
// システムプロンプトに入れる要約の上限。毎回送るので短めにしておく
const PROMPT_SUMMARIES_MAX = 30;
const PROMPT_SUMMARIES_MAX_CHARS = 2000;

/** ローカル時刻での日付（YYYY-MM-DD） */
function dateKey(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** これより前（の日）の会話を要約に回す、という境目の時刻 */
function retentionCutoff(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (RETAIN_DAYS - 1));
  return d.getTime();
}

function isMessage(value) {
  return (
    value &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    Number.isFinite(value.at)
  );
}

function isSummary(value) {
  return value && typeof value.date === 'string' && typeof value.summary === 'string';
}

class HistoryStore {
  /** @param {string} filePath 保存先の JSON ファイル */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {{ role: 'user' | 'assistant', content: string, at: number }[]} */
    this.messages = [];
    /** @type {{ date: string, summary: string, createdAt: number }[]} */
    this.summaries = [];
    // 書き込みが重ならないよう、保存は1つずつ順番に行う
    this.saving = Promise.resolve();
    // ファイルはあるのに読めなかったときは、空の履歴で上書きしないよう保存を止める
    this.saveDisabled = false;
  }

  /** ファイルから読み込む。無ければ空で始める。壊れていたら退避して空で始める */
  load() {
    let raw;
    try {
      // メモ帳や PowerShell で保存すると先頭に BOM が付くことがあるので外して読む
      raw = fs.readFileSync(this.filePath, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this.saveDisabled = true;
      console.error('[history] 履歴ファイルを読めなかったので、今回は保存しません:', err.message);
      return;
    }

    try {
      const data = JSON.parse(raw);
      this.messages = (Array.isArray(data.messages) ? data.messages : []).filter(isMessage);
      this.summaries = (Array.isArray(data.summaries) ? data.summaries : []).filter(isSummary);
    } catch (err) {
      // 黙って上書きすると中身が失われるので、別名で残しておく
      const backup = `${this.filePath}.broken-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      console.error(`[history] 履歴ファイルが読めなかったので ${backup} に退避しました:`, err.message);
      this.messages = [];
      this.summaries = [];
    }
  }

  /** 発言を足して保存する */
  append(...messages) {
    this.messages.push(...messages);
    return this.save();
  }

  /** 履歴も要約もすべて消して保存する */
  clear() {
    this.messages = [];
    this.summaries = [];
    return this.save();
  }

  save() {
    if (this.saveDisabled) return Promise.resolve();
    const json = JSON.stringify(
      { version: 1, messages: this.messages, summaries: this.summaries },
      null,
      2,
    );
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      // 書きかけで終了してもファイルが壊れないよう、別名に書いてから置き換える
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, json, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    };
    const saved = this.saving.then(write);
    this.saving = saved.catch((err) => console.error('[history] 保存に失敗しました:', err.message));
    return saved;
  }

  /**
   * 7日より前の会話を、日ごとに要約して置き換える。起動時に1回だけ呼ぶ想定。
   * 要約に失敗した日は詳しいまま残し、次回の起動でやり直す。
   * 1日失敗したら（キー無し・回数制限など、続けても失敗しやすいので）そこでやめる。
   * @param {(date: string, messages: HistoryStore['messages']) => Promise<string>} summarize
   * @param {number} [now] テスト用に日時を差し替えられる
   * @returns {Promise<{ summarizedDays: string[], failedDay: string | null }>}
   */
  async compact(summarize, now = Date.now()) {
    const cutoff = retentionCutoff(now);
    const byDay = new Map();
    for (const message of this.messages) {
      if (message.at >= cutoff) continue;
      const key = dateKey(message.at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(message);
    }

    const summarizedDays = [];
    for (const [date, dayMessages] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      let summary;
      try {
        summary = (await summarize(date, dayMessages)).trim();
        if (!summary) throw new Error('要約が空でした');
      } catch (err) {
        console.error(`[history] ${date} の要約に失敗しました（詳しい履歴は残します）:`, err.message);
        return { summarizedDays, failedDay: date };
      }

      // 要約を待っている間に新しい発言が足されていても消さないよう、この日の発言だけを外す
      const done = new Set(dayMessages);
      this.messages = this.messages.filter((message) => !done.has(message));
      this.summaries.push({ date, summary, createdAt: now });
      this.summaries.sort((a, b) => a.date.localeCompare(b.date));
      await this.save();
      summarizedDays.push(date);
    }
    return { summarizedDays, failedDay: null };
  }

  /** システムプロンプトに入れる、要約の短い一覧（新しいものから上限まで）。無ければ空文字 */
  summariesForPrompt() {
    const lines = [];
    let chars = 0;
    for (const { date, summary } of [...this.summaries].reverse()) {
      const line = `- ${date}: ${summary}`;
      if (lines.length >= PROMPT_SUMMARIES_MAX || chars + line.length > PROMPT_SUMMARIES_MAX_CHARS) break;
      lines.unshift(line);
      chars += line.length;
    }
    return lines.join('\n');
  }
}

module.exports = { HistoryStore, dateKey, retentionCutoff, RETAIN_DAYS };
