'use strict';

// Google カレンダー連携（中身は calendar.js、ログインは google-auth.js）
// ・会話で「明日の予定は？」「金曜15時に歯医者を入れて」→ Gemini がカレンダーの道具を呼ぶ
// ・予定の10分前に、リマインダーと同じ吹き出しと音で知らせる
// ・その日はじめて（朝5時より後に）豆を起動したとき、今日の予定をまとめて言う。昼からの起動なら、これからの予定だけ
//   （起動したままで日が変わっても言わない。起動したときにカレンダー連携が OFF なら、その日は言わない）

const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const state = require('./state');
const { showDialog } = require('./dialogs');
const { pushNotice, deliverNotices } = require('./notices');
const { settingsState, fromSettingsWindow } = require('./settings-panel');
const { CALENDAR_MODES, CALENDAR_REFRESH_CHOICES } = require('../lib/settings');
const { parseDay } = require('../lib/archive-store');
const { GoogleAuthError } = require('../lib/google-auth');
const {
  CalendarError,
  DAY_MS,
  localDateKey,
  describeEvent,
  dueEventNotices,
  noticeKey,
  eventNoticeText,
  shouldBrief,
  briefingText,
} = require('../lib/calendar');

const EVENT_NOTICE_LEAD_MS = 10 * 60 * 1000;
// 予定を読み直す間隔は設定で変えられる（settings.calendarRefreshMinutes）。
// 直前に足された予定は10分前のお知らせに間に合わないこともあるが、タイマーほどの正確さは要らないので長めでよい
function calendarRefreshMs() {
  return state.settings.calendarRefreshMinutes * 60 * 1000;
}

// うまく読めなかったときに、もう一度試すまでの時間
const CALENDAR_RETRY_MS = 60 * 1000;
// 日付が変わっても、朝5時までは前の日の続きとして、まとめは言わない
const BRIEFING_HOUR_START = 5;

const CALENDAR_FUNCTION_DECLARATIONS = [
  {
    name: 'list_calendar_events',
    description: 'ユーザーの Google カレンダーの予定を、期間を指定して読む。「今日の予定は？」「来週なにがある？」など',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '期間のはじめの日。YYYY-MM-DD' },
        to: { type: 'string', description: '期間の終わりの日（この日も含む）。YYYY-MM-DD。1日だけなら from と同じ日' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'add_calendar_event',
    description: 'ユーザーの Google カレンダーに予定を足す。「金曜の15時に歯医者を入れて」「カレンダーに登録して」など',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '予定の名前（例: 歯医者）' },
        start: {
          type: 'string',
          description: '始まり。時間のある予定はタイムゾーン付きの ISO 8601（例: 2026-09-25T15:00:00+09:00）、終日の予定は YYYY-MM-DD',
        },
        end: { type: 'string', description: '終わり（省略すると1時間、終日なら1日）。形は start と同じ' },
        all_day: { type: 'boolean', description: '終日の予定なら true' },
        location: { type: 'string', description: '場所（あれば）' },
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'ユーザーの Google カレンダーにある予定を直す。「歯医者を3時にずらして」「場所を変えて」など。先に list_calendar_events で番号を調べる',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '直す予定の番号（list_calendar_events が返した番号）' },
        title: { type: 'string', description: '新しい名前（変えるときだけ）' },
        start: {
          type: 'string',
          description: '新しい始まり（時間を変えるときは必ず指定）。時間のある予定はタイムゾーン付きの ISO 8601、終日の予定は YYYY-MM-DD',
        },
        end: { type: 'string', description: '新しい終わり（省略すると、今と同じ長さのまま動かす）。形は start と同じ' },
        all_day: { type: 'boolean', description: '終日の予定に変えるなら true' },
        location: { type: 'string', description: '新しい場所（変えるときだけ。空にすると場所を消す）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'ユーザーの Google カレンダーから予定を消す。「歯医者の予定を消して」など。先に list_calendar_events で番号を調べ、どの予定を消すかユーザーに確かめてから呼ぶ',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: '消す予定の番号（list_calendar_events が返した番号）' } },
      required: ['id'],
    },
  },
];
const CALENDAR_FUNCTION_NAMES = new Set(CALENDAR_FUNCTION_DECLARATIONS.map((declaration) => declaration.name));

/** 予定の通知（10分前・朝のまとめ）を出すか。Gemini は通さないので、トークンはかからない */
function calendarNotifying() {
  return state.settings.calendarMode !== 'off' && Boolean(state.googleAuth.account);
}

/**
 * 会話で予定を読み書きできるようにするか。
 * こちらを ON にすると、予定の道具の説明を毎回 Gemini に送ることになる（実測 約1,040トークン／回）
 */
function calendarInChat() {
  return state.settings.calendarMode === 'full' && Boolean(state.googleAuth.account);
}

function setCalendarMode(mode) {
  state.updateSettings({ calendarMode: mode });
  resetCalendarCache();
  state.settingsChanged();
}

// 会話で予定を読み書きできないときの、今の状態の一言。
// 「つながっていません」だけだと、何を直せばよいか分からないので、どこが原因かをはっきり言わせる
const CALENDAR_STATUS = Object.freeze({
  noClient: 'カレンダー連携の準備（クライアント ID のファイル）がまだだから、予定は見られないよ。「設定を開く」のカレンダーのところから準備してね',
  signedOut: 'Google のアカウントのログインが切れてるから、予定を見たり入れたり消したりできないよ。「設定を開く」からログインし直してね',
  notSignedIn: 'Google のアカウントにまだログインしてないから、予定は見られないよ。「設定を開く」のカレンダーのところからログインしてね',
  off: 'カレンダー連携が「使わない」の設定になってるから、予定は見られないよ。「設定を開く」で「会話でも予定を読み書きする」にしてね',
  notifyOnly: '設定が「予定の通知だけ」になってるから、会話では予定を見たり入れたり消したりできないよ。「設定を開く」で「会話でも予定を読み書きする」にしてね',
});

/** 今の状態がどれか */
function calendarStatus() {
  if (!state.googleAuth.hasClient()) return CALENDAR_STATUS.noClient;
  // 使う設定のままログインだけ無い＝ログインが切れた
  if (!state.googleAuth.account) return state.settings.calendarMode === 'off' ? CALENDAR_STATUS.notSignedIn : CALENDAR_STATUS.signedOut;
  if (state.settings.calendarMode === 'off') return CALENDAR_STATUS.off;
  return CALENDAR_STATUS.notifyOnly;
}

/** 会話で予定を読み書きできないときに出す行 */
function calendarUnavailableLines() {
  return [
    '',
    '今は、ユーザーの Google カレンダーの予定を読み書きできません。',
    `予定を聞かれたり、入れて・消してと頼まれたりしたら、ぼかさずに理由を「${calendarStatus()}」のように伝えてください。`,
    '予定を調べた・入れた・消したとは言わないでください。',
  ];
}

// つながっているが、予定の話が出ていないので道具を渡さない回に出す1行。
// 「つながっていません」と言うと、つながっているのに設定を見直させてしまう
const CALENDAR_IDLE_LINES = Object.freeze([
  '',
  'ユーザーの Google カレンダーとはつながっていますが、この回は予定を読み書きできません。予定を調べた・足したとは言わず、予定の話なら「〇日の〇時に〇〇を入れて」のように、もう一度言ってもらってください。',
]);

function calendarPromptLines() {
  if (!calendarInChat()) return calendarUnavailableLines();
  return [
    '',
    'ユーザーの Google カレンダーとつながっています。',
    '予定を聞かれたら list_calendar_events で調べてから答え、予定を入れてと頼まれたら add_calendar_event で足してください。',
    '予定を直す・消すときは、先に list_calendar_events でその予定の番号を調べてから update_calendar_event / delete_calendar_event を呼んでください。',
    '消すのは取り消せないので、delete_calendar_event を呼ぶ前に「どの予定を消すか」を必ずユーザーに確かめてください。同じ名前の予定が2つ以上あるときも、どれか確かめてください。',
    '「〇〇って教えて」「〇分たったら知らせて」のように知らせてほしいだけのときは、カレンダーではなくタイマーやリマインダーを使ってください。',
    '道具を使わずに、予定を調べた・足したと言ってはいけません。「明日」「来週の金曜」などは、現在の日時をもとに日付に直してください。',
    '「1001歓迎会1900」のような数字だけのメモ書きは、先の4けたを日付（10月1日）、後の4けたを時刻（19:00）と読んでください。',
    '「930会議1000」のように、日付（9月30日）とも時刻（9:30〜10:00）とも読めるときは、足す前にどちらかユーザーに確かめてください。',
    '予定を足したり直したりしたら、返事では必ず「9月30日(水) 10:00」のように日付と時刻をはっきり言ってください。',
    'カレンダーの予定は、始まる10分前に吹き出しで知らせます。',
    `ほかの所（スマホなど）で変えた予定に気づくまで、最大${state.settings.calendarRefreshMinutes}分かかります。`,
  ];
}

// 予定は Google の長い ID ではなく、タイマーと同じ「番号」でやりとりする。
// list_calendar_events で見せた予定にだけ番号を配るので、番号を取り違えて別の予定を消すことがない
const eventIdsByNumber = new Map();
const eventNumbersById = new Map();
let nextEventNumber = 1;
// 覚えておく予定の数（古いものから忘れる）
const EVENT_NUMBER_MAX = 200;

/** その予定の番号（はじめての予定には新しい番号を配る） */
function eventNumber(id) {
  const known = eventNumbersById.get(id);
  if (known) return known;
  const number = nextEventNumber++;
  eventIdsByNumber.set(number, id);
  eventNumbersById.set(id, number);
  while (eventIdsByNumber.size > EVENT_NUMBER_MAX) {
    const oldest = eventIdsByNumber.keys().next().value;
    eventNumbersById.delete(eventIdsByNumber.get(oldest));
    eventIdsByNumber.delete(oldest);
  }
  return number;
}

/** 番号から Google の予定 ID。まだ見せていない番号なら null */
function eventIdFromNumber(number) {
  return eventIdsByNumber.get(Number(number)) ?? null;
}

function forgetEventNumber(number) {
  const id = eventIdsByNumber.get(Number(number));
  if (id) eventNumbersById.delete(id);
  eventIdsByNumber.delete(Number(number));
}

/** Gemini が呼んだカレンダーの道具を実行する */
async function callCalendarFunction({ name, args = {} }) {
  const { calendar } = state;
  try {
    if (name === 'list_calendar_events') {
      const from = parseDay(args.from);
      const to = parseDay(args.to, true);
      if (from == null || to == null || to < from) return { ok: false, error: 'from と to は YYYY-MM-DD で、from が先になるように指定してください' };
      const events = await calendar.listEvents(from, Math.min(to + 1, from + 62 * DAY_MS));
      return {
        ok: true,
        count: events.length,
        events: events.map((event) => ({ id: eventNumber(event.id), event: describeEvent(event, { withDay: true }) })),
      };
    }
    if (name === 'update_calendar_event' || name === 'delete_calendar_event') {
      const eventId = eventIdFromNumber(args.id);
      if (!eventId) return { ok: false, error: 'その番号の予定が分かりません。先に list_calendar_events で予定を調べ直してください' };
      if (name === 'delete_calendar_event') {
        await calendar.deleteEvent(eventId);
        forgetEventNumber(args.id);
        resetCalendarCache();
        return { ok: true, deleted: true };
      }
      const updated = await calendar.updateEvent({
        id: eventId,
        ...(args.title !== undefined && { title: args.title }),
        ...(args.start !== undefined && { start: args.start }),
        ...(args.end !== undefined && { end: args.end }),
        ...(args.all_day !== undefined && { allDay: Boolean(args.all_day) }),
        ...(args.location !== undefined && { location: args.location }),
      });
      resetCalendarCache();
      return { ok: true, updated: updated ? describeEvent(updated, { withDay: true }) : '直しました' };
    }
    const event = await calendar.addEvent({
      title: args.title,
      start: args.start,
      end: args.end,
      allDay: Boolean(args.all_day),
      location: args.location,
    });
    resetCalendarCache();
    return { ok: true, added: describeEvent(event, { withDay: true }) };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, error: err.message };
    if (err instanceof GoogleAuthError && err.kind === 'signed-out') {
      state.settingsChanged();
      return { ok: false, error: `${CALENDAR_STATUS.signedOut}と、そのまま伝えてください` };
    }
    if (err instanceof CalendarError || err instanceof GoogleAuthError) return { ok: false, error: err.message };
    throw err;
  }
}

// 次の24時間の予定（10分前に知らせるため）と、もう知らせた予定の目印。
// 予定を読んだときの一覧をもとに、1秒ごとの確認は PC の中だけで行う（そのたびに Google へは行かない）
let upcomingEvents = [];
const notifiedEvents = new Set();
let nextCalendarCheckAt = 0;
let calendarChecking = false;
let signedOutNoticeShown = false;

// Google のログインが切れたときの吹き出し
const GOOGLE_SIGNED_OUT_NOTICE = 'Google のアカウントのログインが切れてるよ。右クリックの「設定を開く」から、ログインし直してね。';
// 朝のまとめは、起動した時刻で決める。予定を読めたら（ネットにつながったら）1回だけ言う
const launchedAt = Date.now();
let briefingPending = true;

function resetCalendarCache() {
  upcomingEvents = [];
  nextCalendarCheckAt = 0;
}

function loadCalendarState() {
  try {
    return JSON.parse(fs.readFileSync(state.calendarStateFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCalendarState(calendarState) {
  try {
    fs.mkdirSync(path.dirname(state.calendarStateFile), { recursive: true });
    fs.writeFileSync(state.calendarStateFile, JSON.stringify(calendarState, null, 2), 'utf8');
  } catch (err) {
    console.error('[calendar] 朝のまとめを言った日を保存できませんでした:', err.message);
  }
}

/** 1秒ごとに呼ばれる。10分前になった予定を知らせ、ときどき予定を読み直す */
function checkCalendar() {
  if (!calendarNotifying()) {
    briefingPending = false;
    return;
  }
  const now = Date.now();
  for (const event of dueEventNotices(upcomingEvents, now, EVENT_NOTICE_LEAD_MS, notifiedEvents)) {
    notifiedEvents.add(noticeKey(event));
    pushNotice(eventNoticeText(event, now));
  }
  if (calendarChecking || now < nextCalendarCheckAt) return;

  calendarChecking = true;
  refreshCalendar(now)
    .then(() => {
      nextCalendarCheckAt = Date.now() + calendarRefreshMs();
    })
    .catch((err) => {
      nextCalendarCheckAt = Date.now() + CALENDAR_RETRY_MS;
      console.warn('[calendar] 予定を読めませんでした:', err.message);
      // ログインが切れた・カレンダーを許可していないときは、1回だけ吹き出しで知らせる
      const notice =
        err instanceof GoogleAuthError && err.kind === 'signed-out'
          ? GOOGLE_SIGNED_OUT_NOTICE
          : err.noScope
            ? 'カレンダーを見る許可がもらえていないみたい。「設定を開く」の「アカウントを切り替える」でログインし直して、Google の画面でカレンダーにチェックを入れてね。'
            : null;
      if (notice) {
        state.settingsChanged();
        if (!signedOutNoticeShown) {
          signedOutNoticeShown = true;
          pushNotice(notice);
          deliverNotices();
        }
      }
    })
    .finally(() => {
      calendarChecking = false;
    });
}

async function refreshCalendar(now) {
  const { calendar } = state;
  upcomingEvents = await calendar.listEvents(now, now + DAY_MS);
  signedOutNoticeShown = false;

  if (!briefingPending) return;
  const saved = loadCalendarState();
  // 起動したのと同じ日のうちに予定を読めたときだけ言う（前の晩に起動して、つながらないまま朝になったときは言わない）
  const sameDay = localDateKey(now) === localDateKey(launchedAt);
  if (sameDay && shouldBrief(saved.lastBriefingDate, launchedAt, BRIEFING_HOUR_START)) {
    pushNotice(briefingText(await calendar.listToday(now), now));
    saveCalendarState({ ...saved, lastBriefingDate: localDateKey(now) });
    deliverNotices();
  }
  briefingPending = false;
}

// ---------------------------------------------------------------------------
// 設定ウィンドウからの操作
// ---------------------------------------------------------------------------
// Google Cloud でダウンロードした、クライアント ID の JSON を選ぶ
ipcMain.handle('settings:calendar-choose-client', async (event) => {
  if (!fromSettingsWindow(event)) return settingsState();
  const options = {
    title: 'クライアント ID のファイル（JSON）を選ぶ',
    buttonLabel: 'このファイルを使う',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  };
  const { canceled, filePaths } = await dialog.showOpenDialog(state.settingsWin, options);
  if (canceled || !filePaths[0]) return settingsState();
  try {
    state.googleAuth.importClientFile(filePaths[0]);
  } catch (err) {
    await showDialog({
      type: 'error',
      title: 'ファイルを使えませんでした',
      message: 'クライアント ID のファイルとして読めませんでした。',
      detail: `${err.message}\n\nGoogle Cloud の「クライアント」で「デスクトップ アプリ」を作り、「JSON をダウンロード」したファイルを選んでください。`,
    });
  }
  state.settingsChanged();
  return settingsState();
});

// ブラウザで Google にログインする。ログインし直すと、アカウントの切り替えになる
ipcMain.handle('settings:calendar-sign-in', async (event) => {
  if (!fromSettingsWindow(event)) return settingsState();
  const signingIn = state.googleAuth.signIn();
  // 「ブラウザでログインしてください」の表示に切り替える
  state.settingsChanged();
  try {
    await signingIn;
    // ログインしたら通知だけ始める。会話で予定を触るかは、トークンが増えるので自分で選んでもらう
    if (state.settings.calendarMode === 'off') setCalendarMode('notify');
  } catch (err) {
    if (!(err instanceof GoogleAuthError && err.kind === 'canceled')) {
      console.error('[google]', err.message);
      await showDialog({ type: 'error', title: 'ログインできませんでした', message: 'Google にログインできませんでした。', detail: err.message });
    }
  }
  state.settingsChanged();
  return settingsState();
});

ipcMain.handle('settings:calendar-sign-out', async (event) => {
  if (!fromSettingsWindow(event)) return settingsState();
  await state.googleAuth.signOut();
  setCalendarMode('off');
  return settingsState();
});

ipcMain.handle('settings:set-calendar-mode', (event, mode) => {
  // ログインしていないときは「使わない」のまま
  if (fromSettingsWindow(event) && CALENDAR_MODES.some((choice) => choice.id === mode)) {
    setCalendarMode(state.googleAuth.account ? mode : 'off');
  }
  return settingsState();
});

ipcMain.handle('settings:set-calendar-refresh', (event, minutes) => {
  // 画面にある選択肢以外は受け取らない
  if (fromSettingsWindow(event) && CALENDAR_REFRESH_CHOICES.includes(Number(minutes))) {
    state.updateSettings({ calendarRefreshMinutes: Number(minutes) });
    // 次の読み直しを待たず、新しい間隔ですぐ読み直す
    resetCalendarCache();
    state.settingsChanged();
  }
  return settingsState();
});

module.exports = {
  CALENDAR_FUNCTION_DECLARATIONS,
  CALENDAR_FUNCTION_NAMES,
  CALENDAR_IDLE_LINES,
  calendarInChat,
  calendarPromptLines,
  calendarUnavailableLines,
  callCalendarFunction,
  checkCalendar,
};
