'use strict';

// Google カレンダー（いつも使うカレンダー = primary）の予定を読み書きする。
// あわせて、予定の前のお知らせと、朝のまとめの文を作る。
// 通信の fetch と鍵（GoogleAuth）は呼び出す側から渡してもらうので、読み込むだけなら node でも動く
// （test/calendar.test.js）。

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DAY_MS = 24 * 60 * 60 * 1000;
// 1回に読む予定の数の上限（吹き出しと会話に収まるくらい）
const MAX_EVENTS = 50;
const DEFAULT_EVENT_MINUTES = 60;

class CalendarError extends Error {}

/** この PC のタイムゾーン（例: Asia/Tokyo） */
function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Date を、この PC の日付の「2026-09-20」にする */
function localDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 「2026-09-20」を、この PC の時刻でのその日の0時にする */
function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!match) return null;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Google の予定を、扱いやすい形にする。終日の予定は、この PC の時刻でのその日の0時から */
function normalizeEvent(item) {
  const allDay = Boolean(item?.start?.date);
  const start = allDay ? parseDateKey(item.start.date)?.getTime() : Date.parse(item?.start?.dateTime);
  const end = allDay ? parseDateKey(item.end?.date)?.getTime() : Date.parse(item?.end?.dateTime);
  if (!Number.isFinite(start)) return null;
  return {
    id: String(item.id ?? ''),
    title: String(item.summary ?? '').trim() || '（タイトルなし）',
    start,
    end: Number.isFinite(end) ? end : start,
    allDay,
    location: String(item.location ?? '').trim(),
  };
}

function formatTime(at) {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDay(at) {
  const d = new Date(at);
  const weekday = d.toLocaleDateString('ja-JP', { weekday: 'short' });
  return `${d.getMonth() + 1}月${d.getDate()}日(${weekday})`;
}

/** 「15:00〜16:00 歯医者（駅前）」のような1行。withDay で日付も付ける */
function describeEvent(event, { withDay = false } = {}) {
  const when = event.allDay ? '終日' : `${formatTime(event.start)}〜${formatTime(event.end)}`;
  const place = event.location ? `（${event.location}）` : '';
  return `${withDay ? `${formatDay(event.start)} ` : ''}${when} ${event.title}${place}`;
}

/**
 * 今知らせる予定（始まる leadMs 前になった、まだ知らせていない予定）。終日の予定は知らせない。
 * 始まってしまった予定は、もう知らせない（起動が遅れたときなど）
 */
function dueEventNotices(events, now, leadMs, notified) {
  return events.filter((event) => !event.allDay && event.start - leadMs <= now && now < event.start && !notified.has(noticeKey(event)));
}

/** 同じ予定を2回知らせないための目印。時間が変わった予定は、もう一度知らせる */
function noticeKey(event) {
  return `${event.id}@${event.start}`;
}

function eventNoticeText(event, now) {
  const minutes = Math.max(1, Math.round((event.start - now) / 60000));
  const place = event.location ? `（${event.location}）` : '';
  return `あと${minutes}分で「${event.title}」だよ。${formatTime(event.start)}から${place}`;
}

/** 今日の予定のまとめを言うか（now の日にまだ言っていなくて、now が朝 hour 時を過ぎている）。now には起動した時刻を渡す */
function shouldBrief(lastBriefingDate, now, hour = 5) {
  const d = new Date(now);
  return lastBriefingDate !== localDateKey(d) && d.getHours() >= hour;
}

// 昼からは、もう終わった予定は言わずに「これからの予定」を言う
const AFTERNOON_HOUR = 12;

function greeting(hour) {
  if (hour < 10) return 'おはよう';
  if (hour < 18) return 'こんにちは';
  return 'こんばんは';
}

/** 今日の予定のまとめの文。あいさつは時間に合わせ、昼からは終わった予定を省く */
function briefingText(events, now) {
  const hour = new Date(now).getHours();
  const hello = greeting(hour);
  if (hour < AFTERNOON_HOUR) {
    if (events.length === 0) return `${hello}。今日はカレンダーに予定が入っていないよ。`;
    return [`${hello}。今日の予定は${events.length}つだよ。`, ...events.map((event) => `・${describeEvent(event)}`)].join('\n');
  }
  const rest = events.filter((event) => event.allDay || event.end > now);
  if (rest.length === 0) return `${hello}。今日はこれからの予定は入っていないよ。`;
  return [`${hello}。今日のこれからの予定は${rest.length}つだよ。`, ...rest.map((event) => `・${describeEvent(event)}`)].join('\n');
}

/** 予定を足すときの、Google に渡す start / end。終わりが無ければ1時間、終日なら1日 */
function eventTimes({ start, end, allDay }) {
  if (allDay) {
    const day = parseDateKey(String(start).slice(0, 10));
    if (!day) throw new RangeError('終日の予定の日付は YYYY-MM-DD で指定してください');
    const last = end ? parseDateKey(String(end).slice(0, 10)) : day;
    if (!last || last < day) throw new RangeError('終わりの日付がおかしいです');
    // Google の終日の予定は、終わりの日の「次の日」を書く決まり
    return { start: { date: localDateKey(day) }, end: { date: localDateKey(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)) } };
  }
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) throw new RangeError('始まりの日時が読み取れませんでした。タイムゾーン付きの ISO 8601 で指定してください');
  const endMs = end ? Date.parse(end) : startMs + DEFAULT_EVENT_MINUTES * 60000;
  if (!Number.isFinite(endMs) || endMs <= startMs) throw new RangeError('終わりの日時は、始まりより後にしてください');
  const timeZone = localTimeZone();
  return {
    start: { dateTime: new Date(startMs).toISOString(), timeZone },
    end: { dateTime: new Date(endMs).toISOString(), timeZone },
  };
}

class Calendar {
  /** @param {{ auth: { getAccessToken(): Promise<string> }, fetch: typeof fetch }} options */
  constructor({ auth, fetch }) {
    this.auth = auth;
    this.fetch = fetch;
  }

  async #request(url, options = {}) {
    const token = await this.auth.getAccessToken();
    let res;
    try {
      res = await this.fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(30 * 1000),
      });
    } catch (err) {
      throw new CalendarError(`カレンダーにつながりませんでした: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    const message = String(data?.error?.message ?? '');
    // ログインのとき、カレンダーの項目のチェックを外していた
    if (res.status === 403 && /insufficient.*scope/i.test(message)) {
      const error = new CalendarError('カレンダーへのアクセスが許可されていません。設定画面の「アカウントを切り替える」でログインし直し、Google の画面でカレンダーの項目にチェックを入れてください');
      error.noScope = true;
      throw error;
    }
    if (!res.ok) throw new CalendarError(`カレンダーの操作に失敗しました: ${res.status} ${message}`);
    return data;
  }

  /** from から to までの予定（時間の順、繰り返しの予定は1回ずつに分けて） */
  async listEvents(from, to) {
    const params = new URLSearchParams({
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(MAX_EVENTS),
      timeZone: localTimeZone(),
    });
    const data = await this.#request(`${API}?${params}`);
    return (data.items ?? []).filter((item) => item.status !== 'cancelled').map(normalizeEvent).filter(Boolean);
  }

  /** 今日（この PC の日付）の予定 */
  listToday(now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return this.listEvents(start, start.getTime() + DAY_MS);
  }

  /** 予定を足す。足した予定を返す */
  async addEvent({ title, start, end, allDay = false, location = '', description = '' }) {
    const summary = String(title ?? '').trim();
    if (!summary) throw new RangeError('予定の名前が空です');
    const body = {
      summary,
      ...eventTimes({ start, end, allDay }),
      ...(location && { location: String(location) }),
      ...(description && { description: String(description) }),
    };
    return normalizeEvent(await this.#request(API, { method: 'POST', body: JSON.stringify(body) }));
  }
}

module.exports = {
  Calendar,
  CalendarError,
  DAY_MS,
  localDateKey,
  normalizeEvent,
  describeEvent,
  dueEventNotices,
  noticeKey,
  eventNoticeText,
  shouldBrief,
  briefingText,
  eventTimes,
};
