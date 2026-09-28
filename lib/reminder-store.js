'use strict';

// タイマーとリマインダーを覚えておき、時間が来たものを取り出す。
// Electron に依存しないので、node だけでテストできる（test/reminder-store.test.js）。
//
// ・タイマー    「3分たったら教えて」のように、今から何秒後かで決めるもの。
//               マスコットを終了したら消える（ファイルには書かない）
// ・リマインダー「明日9時に歯医者」のように、日時で決めるもの。ファイルに残し、
//               PC を切っている間に時間が過ぎていたら、次に起動したとき知らせる
//
// ファイルの中身:
//   { "version": 1, "reminders": [{ "id": 3, "kind": "reminder", "at": 1757900000000,
//                                   "message": "歯医者", "createdAt": 1757800000000 }] }
//
// 会話の共有フォルダには置かない（ほかの PC のマスコットも一緒に知らせてしまうため）

const fs = require('fs');
const path = require('path');

// 登録できる数と長さの上限（毎回システムプロンプトに一覧を入れるので控えめに）
const MAX_REMINDERS = 30;
const MESSAGE_MAX_CHARS = 100;
const TIMER_MAX_SECONDS = 24 * 60 * 60;
const REMINDER_MAX_DAYS = 366;
// 時間を過ぎてからこれ以上たって知らせるときは「過ぎちゃってた」と言う（寝ていた・起動していなかった）
const LATE_MS = 60 * 1000;

function isReminder(value) {
  return (
    value &&
    value.kind === 'reminder' &&
    Number.isInteger(value.id) &&
    Number.isFinite(value.at) &&
    typeof value.message === 'string'
  );
}

class ReminderStore {
  /** @param {string} filePath 保存先の JSON ファイル */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {{ id: number, kind: 'timer' | 'reminder', at: number, message: string, createdAt: number }[]} */
    this.items = [];
    // ファイルはあるのに読めなかったときは、空の一覧で上書きしないよう保存を止める
    this.saveDisabled = false;
  }

  /** ファイルから読み込む。無ければ空で始める。壊れていたら退避して空で始める */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this.saveDisabled = true;
      console.error('[reminder] リマインダーのファイルを読めなかったので、今回は保存しません:', err.message);
      return;
    }
    try {
      const data = JSON.parse(raw);
      this.items = (Array.isArray(data?.reminders) ? data.reminders : []).filter(isReminder);
    } catch (err) {
      const backup = `${this.filePath}.broken-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      console.error(`[reminder] リマインダーのファイルが読めなかったので ${backup} に退避しました:`, err.message);
      this.items = [];
    }
  }

  /** タイマーを足す。秒数や文がおかしいときは RangeError（メッセージはそのまま Gemini に返す） */
  addTimer(seconds, message, now = Date.now()) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > TIMER_MAX_SECONDS) {
      throw new RangeError(`秒数は 1〜${TIMER_MAX_SECONDS} の間で指定してください`);
    }
    return this.add('timer', now + Math.round(seconds * 1000), message, now);
  }

  /** リマインダーを足す。at は ISO 8601 の日時（タイムゾーン付き）か、ミリ秒の時刻 */
  addReminder(at, message, now = Date.now()) {
    const time = typeof at === 'number' ? at : Date.parse(String(at));
    if (!Number.isFinite(time)) throw new RangeError('日時が読み取れませんでした。ISO 8601 の形で指定してください');
    if (time <= now) throw new RangeError('過去の日時は登録できません');
    if (time > now + REMINDER_MAX_DAYS * 24 * 60 * 60 * 1000) {
      throw new RangeError(`${REMINDER_MAX_DAYS} 日より先の日時は登録できません`);
    }
    return this.add('reminder', time, message, now);
  }

  add(kind, at, message, now) {
    const text = String(message ?? '').trim();
    if (kind === 'reminder' && !text) throw new RangeError('知らせる内容が空です');
    if (this.items.length >= MAX_REMINDERS) {
      throw new RangeError(`登録できるのは ${MAX_REMINDERS} 件までです。先にいらないものを取り消してください`);
    }
    const item = {
      id: Math.max(0, ...this.items.map((existing) => existing.id)) + 1,
      kind,
      at,
      message: text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}…` : text,
      createdAt: now,
    };
    this.items.push(item);
    this.items.sort((a, b) => a.at - b.at);
    if (kind === 'reminder') this.save();
    return item;
  }

  /** 番号で取り消す。見つからなければ null */
  cancel(id) {
    const item = this.items.find((existing) => existing.id === Number(id));
    if (!item) return null;
    this.items = this.items.filter((existing) => existing !== item);
    if (item.kind === 'reminder') this.save();
    return item;
  }

  /**
   * 時間が来たものを一覧から外して返す（古い順）。
   * late は、時間を LATE_MS 以上過ぎていたか（PC を切っていた・スリープしていたなど）
   */
  takeDue(now = Date.now()) {
    const due = this.items.filter((item) => item.at <= now);
    if (due.length === 0) return [];
    this.items = this.items.filter((item) => item.at > now);
    if (due.some((item) => item.kind === 'reminder')) this.save();
    return due.map((item) => ({ ...item, late: now - item.at >= LATE_MS }));
  }

  save() {
    if (this.saveDisabled) return;
    try {
      const reminders = this.items.filter((item) => item.kind === 'reminder');
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // 書きかけで終了してもファイルが壊れないよう、別名に書いてから置き換える
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, reminders }, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[reminder] 保存に失敗しました:', err.message);
    }
  }
}

module.exports = { ReminderStore, MAX_REMINDERS, TIMER_MAX_SECONDS, LATE_MS };
