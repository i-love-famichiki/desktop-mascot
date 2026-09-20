'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Calendar,
  CalendarError,
  normalizeEvent,
  describeEvent,
  dueEventNotices,
  noticeKey,
  eventNoticeText,
  shouldBrief,
  briefingText,
  eventTimes,
  sameLengthEnd,
} = require('../calendar');

// この PC の時刻での日時（テストはどのタイムゾーンでも通るよう、ローカル時刻で作る）
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const timed = (id, title, start, minutes = 60, location = '') => ({ id, title, start, end: start + minutes * 60000, allDay: false, location });

test('Google の予定を扱いやすい形にする（時間のある予定・終日の予定）', () => {
  const event = normalizeEvent({
    id: 'e1',
    summary: ' 歯医者 ',
    location: '駅前',
    start: { dateTime: new Date(at(2026, 9, 25, 15)).toISOString() },
    end: { dateTime: new Date(at(2026, 9, 25, 16)).toISOString() },
  });
  assert.deepEqual(event, { id: 'e1', title: '歯医者', start: at(2026, 9, 25, 15), end: at(2026, 9, 25, 16), allDay: false, location: '駅前' });

  const allDay = normalizeEvent({ id: 'e2', start: { date: '2026-09-26' }, end: { date: '2026-09-27' } });
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.start, at(2026, 9, 26));
  assert.equal(allDay.title, '（タイトルなし）');
  assert.equal(normalizeEvent({ id: 'x', start: {} }), null);
});

test('予定を1行で言い表す', () => {
  assert.equal(describeEvent(timed('a', '歯医者', at(2026, 9, 25, 15), 60, '駅前')), '15:00〜16:00 歯医者（駅前）');
  assert.equal(describeEvent({ ...timed('b', '誕生日', at(2026, 9, 25)), allDay: true }, { withDay: true }), '9月25日(金) 終日 誕生日');
});

test('10分前になった予定だけを、1回だけ知らせる。終日と、始まってしまった予定は知らせない', () => {
  const now = at(2026, 9, 25, 14, 52);
  const events = [
    timed('soon', '歯医者', at(2026, 9, 25, 15)), // 8分後 → 知らせる
    timed('later', '会議', at(2026, 9, 25, 16)), // 68分後 → まだ
    timed('past', '昼ごはん', at(2026, 9, 25, 14, 50)), // もう始まった
    { ...timed('day', '誕生日', at(2026, 9, 25)), allDay: true },
  ];
  const notified = new Set();
  const due = dueEventNotices(events, now, 10 * 60000, notified);
  assert.deepEqual(due.map((event) => event.id), ['soon']);
  assert.equal(eventNoticeText(due[0], now), 'あと8分で「歯医者」だよ。15:00から');

  notified.add(noticeKey(due[0]));
  assert.deepEqual(dueEventNotices(events, now + 60000, 10 * 60000, notified), []);
  // 時間が動いた予定は、もう一度知らせる
  const moved = [{ ...events[0], start: at(2026, 9, 25, 15, 5) }];
  assert.equal(dueEventNotices(moved, at(2026, 9, 25, 14, 56), 10 * 60000, notified).length, 1);
});

test('今日の予定のまとめは、その日まだ言っていなくて5時を過ぎたときだけ（昼に起動しても言う）', () => {
  assert.equal(shouldBrief(undefined, at(2026, 9, 25, 7)), true);
  assert.equal(shouldBrief('2026-09-24', at(2026, 9, 25, 14)), true);
  assert.equal(shouldBrief('2026-09-25', at(2026, 9, 25, 9)), false);
  assert.equal(shouldBrief('2026-09-24', at(2026, 9, 25, 4, 59)), false);
});

test('まとめの文。あいさつは時間に合わせ、昼からは終わった予定を省く', () => {
  const events = [
    { ...timed('d', '誕生日', at(2026, 9, 25)), allDay: true },
    timed('m', '会議', at(2026, 9, 25, 10), 30),
    timed('e', '夕飯', at(2026, 9, 25, 19)),
  ];
  assert.equal(briefingText([], at(2026, 9, 25, 7)), 'おはよう。今日はカレンダーに予定が入っていないよ。');
  assert.equal(
    briefingText(events, at(2026, 9, 25, 7)),
    'おはよう。今日の予定は3つだよ。\n・終日 誕生日\n・10:00〜10:30 会議\n・19:00〜20:00 夕飯',
  );
  assert.equal(briefingText(events, at(2026, 9, 25, 14)), 'こんにちは。今日のこれからの予定は2つだよ。\n・終日 誕生日\n・19:00〜20:00 夕飯');
  assert.equal(briefingText(events.slice(1, 2), at(2026, 9, 25, 20)), 'こんばんは。今日はこれからの予定は入っていないよ。');
});

test('予定を足すときの時間。終わりが無ければ1時間、終日は次の日までと書く', () => {
  const start = new Date(at(2026, 9, 25, 15)).toISOString();
  const times = eventTimes({ start });
  assert.equal(Date.parse(times.end.dateTime) - Date.parse(times.start.dateTime), 60 * 60000);
  assert.deepEqual(eventTimes({ start: '2026-09-25', allDay: true }), { start: { date: '2026-09-25' }, end: { date: '2026-09-26' } });
  assert.deepEqual(eventTimes({ start: '2026-09-30', end: '2026-10-01', allDay: true }), {
    start: { date: '2026-09-30' },
    end: { date: '2026-10-02' },
  });
  assert.throws(() => eventTimes({ start: 'あした' }), RangeError);
  assert.throws(() => eventTimes({ start, end: start }), RangeError);
});

test('カレンダーの読み書き（Google への送り方）', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    if (options.method === 'POST') {
      return { ok: true, json: async () => ({ id: 'new', summary: JSON.parse(options.body).summary, start: { date: '2026-09-25' }, end: { date: '2026-09-26' } }) };
    }
    return {
      ok: true,
      json: async () => ({
        items: [
          { id: 'a', summary: '会議', start: { dateTime: new Date(at(2026, 9, 25, 10)).toISOString() }, end: { dateTime: new Date(at(2026, 9, 25, 11)).toISOString() } },
          { id: 'b', status: 'cancelled', start: { date: '2026-09-25' } },
        ],
      }),
    };
  };
  const calendar = new Calendar({ auth: { getAccessToken: async () => 'token-1' }, fetch });

  const events = await calendar.listEvents(at(2026, 9, 25), at(2026, 9, 26));
  assert.deepEqual(events.map((event) => event.title), ['会議']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-1');
  assert.equal(calls[0].url.searchParams.get('singleEvents'), 'true');
  assert.equal(calls[0].url.searchParams.get('orderBy'), 'startTime');

  const added = await calendar.addEvent({ title: '誕生日', start: '2026-09-25', allDay: true });
  assert.equal(added.title, '誕生日');
  assert.deepEqual(JSON.parse(calls[1].options.body), { summary: '誕生日', start: { date: '2026-09-25' }, end: { date: '2026-09-26' } });
  await assert.rejects(calendar.addEvent({ title: ' ', start: '2026-09-25', allDay: true }), RangeError);
});

test('終わりを省いて時間を変えたら、同じ長さのまま動かす', () => {
  const current = timed('e1', '歯医者', at(2026, 9, 25, 15), 90);
  const moved = sameLengthEnd(current, new Date(at(2026, 9, 26, 10)).toISOString(), false);
  assert.equal(Date.parse(moved) - at(2026, 9, 26, 10), 90 * 60000);
  // 終日 → 時間のある予定は、ふつうの長さ（1時間）にする
  const allDay = { ...current, allDay: true, start: at(2026, 9, 25), end: at(2026, 9, 26) };
  assert.equal(Date.parse(sameLengthEnd(allDay, new Date(at(2026, 9, 26, 10)).toISOString(), false)) - at(2026, 9, 26, 10), 60 * 60000);
  // 2日の終日の予定は、動かしても2日のまま（終わりの日は最後の日）
  const twoDays = { ...current, allDay: true, start: at(2026, 9, 25), end: at(2026, 9, 27) };
  assert.equal(sameLengthEnd(twoDays, '2026-10-01', true), '2026-10-02');
  assert.throws(() => sameLengthEnd(current, 'あした', false), RangeError);
});

test('予定を直す（渡したところだけ変え、時間は今と同じ長さのまま動かす）', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'PATCH') return { ok: true, json: async () => ({ id: 'a', summary: '歯医者', ...JSON.parse(options.body) }) };
    // GET（今の予定）
    return {
      ok: true,
      json: async () => ({
        id: 'a',
        summary: '歯医者',
        start: { dateTime: new Date(at(2026, 9, 25, 15)).toISOString() },
        end: { dateTime: new Date(at(2026, 9, 25, 16, 30)).toISOString() },
      }),
    };
  };
  const calendar = new Calendar({ auth: { getAccessToken: async () => 'token-1' }, fetch });

  // 名前と場所だけ変えるときは、今の予定を読みに行かない
  await calendar.updateEvent({ id: 'a', title: '歯医者（変更）', location: '駅前' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { summary: '歯医者（変更）', location: '駅前' });

  // 始まりだけ変えたら、1時間半のまま動く
  calls.length = 0;
  await calendar.updateEvent({ id: 'a', start: new Date(at(2026, 9, 26, 10)).toISOString() });
  const body = JSON.parse(calls[1].options.body);
  assert.equal(Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime), 90 * 60000);

  await assert.rejects(calendar.updateEvent({ id: 'a', end: '2026-09-26' }), RangeError);
  await assert.rejects(calendar.updateEvent({ id: 'a' }), RangeError);
  await assert.rejects(calendar.updateEvent({ id: ' ' }), RangeError);
});

test('予定を消す。もう無い予定は、分かる言葉で断る', async () => {
  const calls = [];
  const calendar = new Calendar({
    auth: { getAccessToken: async () => 'token-1' },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      // 消したあとの本文は空（204）
      return { ok: true, status: 204, json: async () => { throw new Error('空'); } };
    },
  });
  await calendar.deleteEvent('a b');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/a%20b'));
  await assert.rejects(calendar.deleteEvent(''), RangeError);

  const gone = new Calendar({
    auth: { getAccessToken: async () => 'token-1' },
    fetch: async () => ({ ok: false, status: 410, json: async () => ({ error: { message: 'deleted' } }) }),
  });
  await assert.rejects(gone.deleteEvent('a'), (err) => err instanceof CalendarError && err.notFound === true);
});
