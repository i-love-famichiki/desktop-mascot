'use strict';

// 会話の保管庫。7日たって要約に置き換えた会話や、リセットした会話の詳しい中身をずっと残し、
// 「一年前にこんな相談しなかった？」と聞かれたときに探せるようにする。
// Electron に依存しないので、node だけでテストできる（test/archive-store.test.js）。
//
// 置き場所は会話の履歴（history.json）と同じフォルダの archive/。月ごとに1ファイル:
//   archive/2026-09.json  { "version": 1, "messages": [{ "role": "user", "content": "...", "at": 1757900000000 }] }
//
// 共有中はほかの PC も同じファイルに書くので、書く前に読んで混ぜる（同じ発言は1つにまとめる）。
// 普段の会話では Gemini に送らない。探す道具（search_history）で見つかった分だけを渡す。

const fs = require('fs');
const path = require('path');

/** ローカル時刻での日付（YYYY-MM-DD）。history-store.js からも使う */
function dateKey(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 探した結果として Gemini に返す量の上限（多すぎると料金が増える）
const SEARCH_MAX_HITS = 8;
const SEARCH_MAX_CHARS = 3000;
const SEARCH_MESSAGE_MAX_CHARS = 300;
const SEARCH_SUMMARY_MAX_HITS = 5;

const MONTH_FILE = /^(\d{4}-\d{2})\.json$/;

function isMessage(value) {
  return (
    value &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    Number.isFinite(value.at)
  );
}

const messageKey = (message) => `${message.at}|${message.role}|${message.content}`;

/** 同じ発言を1つにまとめて、時刻の順に並べる */
function mergeMessages(...lists) {
  const byKey = new Map();
  for (const message of lists.flat()) {
    if (isMessage(message) && !byKey.has(messageKey(message))) {
      byKey.set(messageKey(message), { role: message.role, content: message.content, at: message.at });
    }
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at);
}

class ArchiveStore {
  /** @param {string} dir 保管庫のフォルダ（archive/） */
  constructor(dir) {
    this.dir = dir;
    // 書き込みが重ならないよう、1つずつ順番に行う
    this.saving = Promise.resolve();
  }

  /** 月のファイルを読む。無ければ空。壊れているときは例外（上書きして消さないため） */
  async readMonth(month, dir = this.dir) {
    let raw;
    try {
      raw = await fs.promises.readFile(path.join(dir, `${month}.json`), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const data = JSON.parse(raw.replace(/^﻿/, ''));
    return (Array.isArray(data?.messages) ? data.messages : []).filter(isMessage);
  }

  async writeMonth(month, messages) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${month}.json`);
    // 書きかけで終了してもファイルが壊れないよう、別名に書いてから置き換える
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, messages }, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  /** フォルダにある月（YYYY-MM）の一覧 */
  async months(dir = this.dir) {
    try {
      return (await fs.promises.readdir(dir))
        .map((name) => MONTH_FILE.exec(name)?.[1])
        .filter(Boolean)
        .sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * 発言を保管庫に足す。すでにある発言とは混ぜる。
   * 読めない・書けないときは例外にする（呼んだ側は、保管できなかった発言を消さないこと）
   */
  add(messages) {
    const run = async () => {
      const byMonth = new Map();
      for (const message of messages.filter(isMessage)) {
        const month = dateKey(message.at).slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(message);
      }
      for (const [month, added] of byMonth) {
        const existing = await this.readMonth(month);
        const merged = mergeMessages(existing, added);
        if (merged.length !== existing.length) await this.writeMonth(month, merged);
      }
    };
    return this.queue(run);
  }

  /**
   * 保管庫のフォルダを変える（共有を始めた・やめたとき）。
   * 元のフォルダの中身は消さずに、新しいフォルダへ混ぜて写す
   */
  moveTo(dir) {
    const run = async () => {
      const from = this.dir;
      this.dir = dir;
      if (path.resolve(from) === path.resolve(dir)) return;
      for (const month of await this.months(from)) {
        const moving = await this.readMonth(month, from);
        const existing = await this.readMonth(month);
        const merged = mergeMessages(existing, moving);
        if (merged.length !== existing.length) await this.writeMonth(month, merged);
      }
    };
    return this.queue(run);
  }

  /** from〜to（ミリ秒の時刻、どちらも省略可）の月のファイルをすべて読む。壊れた月は飛ばす */
  readRange({ from = -Infinity, to = Infinity } = {}) {
    const run = async () => {
      const firstMonth = Number.isFinite(from) ? dateKey(from).slice(0, 7) : '';
      const lastMonth = Number.isFinite(to) ? dateKey(to).slice(0, 7) : '9999-99';
      const lists = [];
      for (const month of await this.months()) {
        if (month < firstMonth || month > lastMonth) continue;
        try {
          lists.push(await this.readMonth(month));
        } catch (err) {
          console.error(`[archive] ${month} の保管庫が読めませんでした:`, err.message);
        }
      }
      return mergeMessages(...lists).filter((message) => message.at >= from && message.at <= to);
    };
    // 書いている途中のファイルを読まないよう、書き込みと同じ順番待ちに並べる
    return this.queue(run);
  }

  queue(run) {
    const done = this.saving.then(run);
    this.saving = done.catch((err) => console.error('[archive] 保管庫の読み書きに失敗しました:', err.message));
    return done;
  }
}

/** 探すときの文字のそろえ方（全角・半角、大文字・小文字の違いを気にしない） */
const normalizeText = (text) => text.normalize('NFKC').toLowerCase();

/** 「2025-09-01」を、その日のはじめ（to のときは終わり）のミリ秒にする。読めなければ undefined */
function parseDay(value, endOfDay = false) {
  const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  const [, year, month, day] = match.map(Number);
  // 日を省いたとき（2025-09）は、その月のはじめ／終わり
  if (!day) {
    return endOfDay ? new Date(year, month, 1).getTime() - 1 : new Date(year, month - 1, 1).getTime();
  }
  return endOfDay ? new Date(year, month - 1, day + 1).getTime() - 1 : new Date(year, month - 1, day).getTime();
}

/**
 * 会話の中から、言葉を含む発言を探す。当たった発言は、前後の発言と一緒に返す。
 * 多くの言葉に当たったものほど先に、同じなら新しいものほど先に並べる。
 * @param {{ messages: object[], summaries?: { date: string, summary: string }[] }} source 探す会話（時刻の順）と要約
 * @param {{ keywords: string[], from?: number, to?: number }} query
 */
function searchConversations({ messages, summaries = [] }, { keywords, from = -Infinity, to = Infinity }) {
  const words = [...new Set((keywords ?? []).map((word) => normalizeText(String(word)).trim()).filter(Boolean))];
  if (words.length === 0) return { hits: [], summaries: [], total: 0 };

  const score = (text) => words.filter((word) => normalizeText(text).includes(word)).length;
  const clip = (text) => (text.length > SEARCH_MESSAGE_MAX_CHARS ? `${text.slice(0, SEARCH_MESSAGE_MAX_CHARS)}…` : text);

  const matched = messages
    .map((message, index) => ({ index, score: score(message.content), at: message.at }))
    .filter((hit) => hit.score > 0 && hit.at >= from && hit.at <= to)
    .sort((a, b) => b.score - a.score || b.at - a.at);

  const hits = [];
  const used = new Set();
  let chars = 0;
  for (const hit of matched) {
    if (hits.length >= SEARCH_MAX_HITS || used.has(hit.index)) continue;
    // 質問と返事がそろうよう、同じ日の前後1つずつを添える
    const day = dateKey(hit.at);
    const around = [hit.index - 1, hit.index, hit.index + 1].filter(
      (i) => i === hit.index || (i >= 0 && i < messages.length && !used.has(i) && dateKey(messages[i].at) === day),
    );
    const conversation = around.map((i) => ({
      at: messages[i].at,
      role: messages[i].role,
      content: clip(messages[i].content),
    }));
    const size = conversation.reduce((sum, message) => sum + message.content.length, 0);
    if (chars + size > SEARCH_MAX_CHARS) break;
    around.forEach((i) => used.add(i));
    hits.push(conversation);
    chars += size;
  }

  const fromDay = Number.isFinite(from) ? dateKey(from) : '';
  const toDay = Number.isFinite(to) ? dateKey(to) : '9999-99-99';
  const matchedSummaries = summaries
    .filter(({ date, summary }) => date >= fromDay && date <= toDay && score(summary) > 0)
    .sort((a, b) => score(b.summary) - score(a.summary) || b.date.localeCompare(a.date))
    .slice(0, SEARCH_SUMMARY_MAX_HITS);

  return { hits, summaries: matchedSummaries, total: matched.length };
}

module.exports = { ArchiveStore, searchConversations, mergeMessages, parseDay, dateKey };
