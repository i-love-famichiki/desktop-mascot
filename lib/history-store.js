'use strict';

// 会話履歴をファイル（JSON）に保存し、古い会話は要約に置き換える。
// Electron に依存しないので、node だけでテストできる（test/history-store.test.js）。
//
// ファイルの中身:
//   {
//     "version": 1,
//     "messages":  [{ "role": "user" | "assistant", "content": "...", "at": 1757900000000 }],
//     "summaries": [{ "date": "2026-09-01", "summary": "...", "createdAt": 1757900000000 }],
//     "clearedAt": 1757900000000   // 最後に「会話をリセット」した時刻（無ければ 0）
//   }
//
// ほかの PC と同じファイルを使って会話を共有できる（Google ドライブなどのフォルダに置く）。
// 保存のたびにファイルの中身と混ぜてから書くので、ほかの PC で足された発言を消さない。
//
// 要約に置き換えた日の会話や、リセットで消した会話は、消す前に同じフォルダの archive/ に
// 残す（archive-store.js）。保管庫に書けなかったときは、履歴から消さない。

const fs = require('fs');
const path = require('path');
const { ArchiveStore, dateKey } = require('./archive-store');

// 今日を含めた直近2日分（今日と昨日）は詳しいまま残し、それより前は1日1〜2文の要約にする。
// 7日ぶん残していたときは、5〜6日前の会話だけで毎回の入力の枠を食いつぶしていた
// （実測: 9/16 の1日で1,973字。昨日は169字）。詳しい中身が要るときは search_history で探せる
const RETAIN_DAYS = 2;
// システムプロンプトに入れる要約の上限。毎回送るので短めにしておく。
// 1日ぶんは 70〜80 字ほどなので、1000 字でおよそ 2 週間ぶん。それより前は search_history で探す
const PROMPT_SUMMARIES_MAX = 30;
const PROMPT_SUMMARIES_MAX_CHARS = 1000;
// 昨日の詳しい会話も、新しいものから合計この文字数まで返事に使う。
// 1回の発言が長すぎると枠を使い切ってしまうので、1発言ごとにも短く切る。
// 毎回まるごと送るので、ここが入力の値段をいちばん左右する（実測: 4000 字で1回あたり
// 約 7,450 トークン、うち過去ログが約半分。2000 字にすると約 5,750 トークンに下がる）
const PAST_DAYS_MAX_CHARS = 2000;
const PAST_MESSAGE_MAX_CHARS = 300;

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

/** ファイルの中身（JSON を読んだもの）から、使える部分だけを取り出す */
function normalize(data) {
  return {
    messages: (Array.isArray(data?.messages) ? data.messages : []).filter(isMessage),
    summaries: (Array.isArray(data?.summaries) ? data.summaries : []).filter(isSummary),
    clearedAt: Number.isFinite(data?.clearedAt) ? data.clearedAt : 0,
  };
}

/**
 * 2 つの履歴（この PC の分と、ファイルにあったほかの PC の分）を混ぜる。
 * - 同じ発言（時刻・話し手・中身が同じ）は 1 つにまとめる
 * - どちらかでリセットしていたら、その時刻より前の発言と要約は消す
 * - 同じ日の要約が 2 つあれば新しい方を残し、要約済みの日の発言は消す
 * 先に渡した方（この PC の分）の発言はそのままのオブジェクトで残る。
 */
function mergeHistory(local, remote) {
  const clearedAt = Math.max(local.clearedAt, remote.clearedAt);

  const byDate = new Map();
  for (const summary of [...remote.summaries, ...local.summaries]) {
    const current = byDate.get(summary.date);
    if (!current || (summary.createdAt ?? 0) >= (current.createdAt ?? 0)) byDate.set(summary.date, summary);
  }
  const summaries = [...byDate.values()]
    .filter((summary) => clearedAt === 0 || (summary.createdAt ?? 0) >= clearedAt)
    .sort((a, b) => a.date.localeCompare(b.date));
  const summarizedDays = new Set(summaries.map((summary) => summary.date));

  const byKey = new Map();
  for (const message of [...local.messages, ...remote.messages]) {
    const key = `${message.at}|${message.role}|${message.content}`;
    if (!byKey.has(key)) byKey.set(key, message);
  }
  const messages = [...byKey.values()]
    .filter((message) => message.at >= clearedAt && !summarizedDays.has(dateKey(message.at)))
    .sort((a, b) => a.at - b.at);

  return { messages, summaries, clearedAt };
}

/** 履歴ファイルと同じフォルダにある保管庫 */
const archiveDirFor = (filePath) => path.join(path.dirname(filePath), 'archive');

class HistoryStore {
  /** @param {string} filePath 保存先の JSON ファイル */
  constructor(filePath) {
    this.filePath = filePath;
    this.archive = new ArchiveStore(archiveDirFor(filePath));
    /** @type {{ role: 'user' | 'assistant', content: string, at: number }[]} */
    this.messages = [];
    /** @type {{ date: string, summary: string, createdAt: number }[]} */
    this.summaries = [];
    // 最後にリセットした時刻。ほかの PC の古い発言を混ぜて生き返らせないために使う
    this.clearedAt = 0;
    // 書き込みが重ならないよう、保存は1つずつ順番に行う
    this.saving = Promise.resolve();
    // ファイルはあるのに読めなかったときは、空の履歴で上書きしないよう保存を止める
    this.saveDisabled = false;
    // 昔の会話として残さない発言か（設定の「昔の会話を覚える」を切っている間の発言。main/state.js が決める）。
    // こうした発言は保管庫に入れず、日付が変わったら要約もせずに捨てる
    this.isEphemeral = () => false;
  }

  /**
   * 残さない発言のうち、今日より前のものを捨てる（保存はしない）。
   * @param {number} [now] テスト用に日時を差し替えられる
   * @returns {number} 捨てた数
   */
  dropStaleEphemeral(now = Date.now()) {
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.at >= startOfToday || !this.isEphemeral(message));
    return before - this.messages.length;
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
      Object.assign(this, normalize(JSON.parse(raw)));
    } catch (err) {
      // 黙って上書きすると中身が失われるので、別名で残しておく
      const backup = `${this.filePath}.broken-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      console.error(`[history] 履歴ファイルが読めなかったので ${backup} に退避しました:`, err.message);
      this.messages = [];
      this.summaries = [];
      this.clearedAt = 0;
    }
  }

  /**
   * ファイルを読んで、今の中身と混ぜる（ほかの PC で足された発言を取り込む）。
   * ファイルが無い・読めないときは何もしない。
   * @returns {Promise<boolean>} 中身が変わったら true
   */
  sync() {
    const run = async () => {
      const remote = await this.readRemote();
      if (!remote) return false;
      const fingerprint = () => `${this.messages.length}/${this.summaries.length}/${this.clearedAt}`;
      const before = fingerprint();
      this.applyMerge(remote);
      return fingerprint() !== before;
    };
    // 保存と同じ順番待ちに並べて、書いている途中のファイルを読まないようにする
    const synced = this.saving.then(run);
    this.saving = synced.catch((err) => console.error('[history] 読み込みに失敗しました:', err.message));
    return synced;
  }

  /**
   * 保存先を変える（共有フォルダに移すとき・共有をやめるとき）。
   * 移した先にすでに履歴があれば混ぜて、今の中身を書き込む。
   */
  async moveTo(filePath) {
    await this.saving.catch(() => {});
    this.filePath = filePath;
    this.saveDisabled = false;
    // 保管庫も一緒に移す（元の場所の保管庫は消さずに残す）
    await this.archive.moveTo(archiveDirFor(filePath));
    await this.save();
  }

  /** ファイルを読む。無ければ null。読めない・壊れているときは例外 */
  async readRemote() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return normalize(JSON.parse(raw.replace(/^﻿/, '')));
  }

  applyMerge(remote) {
    const merged = mergeHistory(this, remote);
    // ほかの PC でリセット・要約されて、ここで初めて消える発言も保管庫に残す
    // （要約した PC が保管庫に入れていれば、同じ発言は1つにまとまる）
    const kept = new Set(merged.messages);
    const dropped = this.messages.filter((message) => !kept.has(message) && !this.isEphemeral(message));
    if (dropped.length > 0) {
      this.archive.add(dropped).catch((err) => console.error('[history] 消える発言を保管庫に残せませんでした:', err.message));
    }
    Object.assign(this, merged);
  }

  /** 発言を足して保存する */
  append(...messages) {
    this.messages.push(...messages);
    return this.save();
  }

  /**
   * 履歴も要約もすべて消して保存する。話した中身は保管庫に残す（探せば見つかる）。
   * 保管庫に書けなかったときは、何も消さずに例外にする
   */
  async clear() {
    await this.archive.add(this.messages.filter((message) => !this.isEphemeral(message)));
    this.messages = [];
    this.summaries = [];
    this.clearedAt = Date.now();
    return this.save();
  }

  save() {
    if (this.saveDisabled) return Promise.resolve();
    const write = async () => {
      // ほかの PC が同じファイルに書いているかもしれないので、先に読んで混ぜる。
      // 読めないとき（ドライブの同期中など）は、ほかの PC の分を消さないよう書かずに失敗させる
      let remote = null;
      try {
        remote = await this.readRemote();
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.error('[history] 保存先の履歴ファイルが壊れていたので、混ぜずに上書きします:', err.message);
        } else {
          throw err;
        }
      }
      if (remote) this.applyMerge(remote);
      // ファイルにあった分（ほかの PC が書いた分も）から戻ってきても、ここで捨て直す
      this.dropStaleEphemeral();

      const json = JSON.stringify(
        { version: 1, messages: this.messages, summaries: this.summaries, clearedAt: this.clearedAt },
        null,
        2,
      );
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

      // 詳しい中身は保管庫に残す。残せなかった日は、消さずに次回の起動でやり直す
      try {
        await this.archive.add(dayMessages);
      } catch (err) {
        console.error(`[history] ${date} の会話を保管庫に残せませんでした（詳しい履歴は残します）:`, err.message);
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

  /**
   * 昨日より前（要約されていない直近7日のうち、今日より前）の詳しい会話を、
   * 新しいものから合計 PAST_DAYS_MAX_CHARS 文字まで、時刻の古い順に返す。
   * 長い発言は PAST_MESSAGE_MAX_CHARS 文字で切る。
   * @param {number} [now] テスト用に日時を差し替えられる
   */
  pastDaysMessages(now = Date.now()) {
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const picked = [];
    let chars = 0;
    for (const message of [...this.messages].reverse()) {
      if (message.at >= startOfToday) continue;
      const content =
        message.content.length > PAST_MESSAGE_MAX_CHARS
          ? `${message.content.slice(0, PAST_MESSAGE_MAX_CHARS)}…`
          : message.content;
      if (chars + content.length > PAST_DAYS_MAX_CHARS) break;
      picked.unshift({ ...message, content });
      chars += content.length;
    }
    return picked;
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

module.exports = { HistoryStore, mergeHistory, dateKey, retentionCutoff, RETAIN_DAYS };
