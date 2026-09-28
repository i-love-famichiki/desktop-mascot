'use strict';

// タイマーとリマインダー
// 「3分たったら教えて」「明日9時に歯医者って教えて」と話しかけると、Gemini が道具
// （set_timer / add_reminder）を呼んで登録する。時間が来たら、吹き出しで知らせて豆がはねる。
// 知らせる文は登録のときに Gemini が決めておくので、知らせるときは Gemini を呼ばない

const state = require('./state');
const { pushNotice } = require('./notices');
const { formatMessageTime, localIsoString } = require('./format');

const REMINDER_CHECK_INTERVAL_MS = 1000;

const REMINDER_FUNCTION_DECLARATIONS = [
  {
    name: 'set_timer',
    description: '今から指定した秒数がたったら、ユーザーに知らせるタイマーを登録する。「3分たったら教えて」「1時間後に声かけて」など',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '今から何秒後に知らせるか（1〜86400）' },
        message: {
          type: 'string',
          description: '時間になったとき吹き出しに出す、あなたの口調の短い一言（例: 3分たったよ。カップラーメンができたよ）',
        },
      },
      required: ['seconds', 'message'],
    },
  },
  {
    name: 'add_reminder',
    description: '指定した日時にユーザーへ知らせるリマインダーを登録する。「明日の9時に歯医者って教えて」など',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'string', description: '知らせる日時。タイムゾーン付きの ISO 8601（例: 2026-09-18T09:00:00+09:00）' },
        message: {
          type: 'string',
          description: '時間になったとき吹き出しに出す、あなたの口調の短い一言（例: 歯医者の時間だよ）',
        },
      },
      required: ['at', 'message'],
    },
  },
  {
    name: 'cancel_reminder',
    description: '登録してあるタイマーやリマインダーを、番号を指定して取り消す',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: '取り消すものの番号' } },
      required: ['id'],
    },
  },
];

/** Gemini が呼んだ道具を実行し、結果を Gemini に返す形にする */
function callReminderFunction({ name, args = {} }) {
  const { reminders } = state;
  const describe = (item) => ({ id: item.id, at: localIsoString(item.at), message: item.message });
  try {
    switch (name) {
      case 'set_timer':
        return { ok: true, registered: describe(reminders.addTimer(Number(args.seconds), args.message)) };
      case 'add_reminder':
        return { ok: true, registered: describe(reminders.addReminder(args.at, args.message)) };
      case 'cancel_reminder': {
        const item = reminders.cancel(args.id);
        return item ? { ok: true, canceled: describe(item) } : { ok: false, error: `番号 ${args.id} は登録されていません` };
      }
      default:
        return { ok: false, error: `${name} という道具はありません` };
    }
  } catch (err) {
    // 値がおかしいときは、理由を Gemini に返してユーザーに説明してもらう
    if (err instanceof RangeError) return { ok: false, error: err.message };
    throw err;
  }
}

/** 今登録されているものの一覧と使い方。毎回システムプロンプトに入れる */
function reminderPromptLines() {
  const list = state.reminders.items.map(
    (item) => `- 番号${item.id}: ${formatMessageTime(item.at)}（${item.kind === 'timer' ? 'タイマー' : 'リマインダー'}）${item.message}`,
  );
  return [
    '',
    'タイマーやリマインダーを頼まれたら、道具で登録してから、いつ知らせるかを短く伝えてください。',
    '「3分たったら」「1時間後に」のように今からの時間なら set_timer、「明日の9時に」のように日時なら add_reminder を使ってください。',
    '取り消しを頼まれたら cancel_reminder を使ってください。道具を使わずに、登録した・取り消したと言ってはいけません。',
    '時間になったら、登録した一言がそのまま吹き出しに出ます。',
    ...(list.length > 0 ? ['今登録されているタイマーとリマインダー:', ...list] : ['今登録されているタイマーとリマインダーはありません。']),
  ];
}

/** 時間が来たものを、知らせる文としてためる（出すのは notices.js） */
function checkReminders() {
  for (const item of state.reminders.takeDue()) {
    const message = item.message || '時間だよ。';
    // PC を切っていた・スリープしていたなどで遅れたときは、いつの分かを添える
    pushNotice(item.late ? `（${formatMessageTime(item.at)} の分。時間が過ぎちゃってた）\n${message}` : message);
  }
}

module.exports = {
  REMINDER_CHECK_INTERVAL_MS,
  REMINDER_FUNCTION_DECLARATIONS,
  callReminderFunction,
  reminderPromptLines,
  checkReminders,
};
