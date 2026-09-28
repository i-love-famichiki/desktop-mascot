'use strict';

// 会話で Gemini に渡す道具（タイマーとリマインダー、昔の会話探し、カレンダー）。
// どの道具を渡すかを決める所は chat-tools.js

const state = require('./state');
const { formatMessageTime } = require('./format');
const { REMINDER_FUNCTION_DECLARATIONS, callReminderFunction } = require('./reminders');
const { CALENDAR_FUNCTION_DECLARATIONS, CALENDAR_FUNCTION_NAMES, calendarInChat, callCalendarFunction } = require('./calendar-link');
const { toolGroups: chatToolGroups } = require('../chat-tools');
const { searchConversations, mergeMessages, parseDay } = require('../archive-store');

// この時間より前の発言は、続きの話とは見なさない
const FOLLOW_UP_MS = 10 * 60 * 1000;

/** この発言で渡す道具の組み合わせ（中身は chat-tools.js） */
function toolGroups(userText) {
  const previous = state.store.messages.findLast((message) => message.role === 'user');
  const groups = chatToolGroups(userText, {
    // 登録中のタイマーがあるときは、取り消しや問い合わせに答えられるよう必ず渡す
    hasReminders: state.reminders.items.length > 0,
    calendarInChat: calendarInChat(),
    previousText: previous && Date.now() - previous.at < FOLLOW_UP_MS ? previous.content : '',
  });
  // 昔の会話を覚えない設定のときは、保管庫を探す道具も渡さない
  return state.settings.keepPast ? groups : { ...groups, history: false, pastDays: false };
}

const SEARCH_HISTORY_DECLARATION = {
  name: 'search_history',
  description:
    'ユーザーと以前に話した会話を、保管庫から言葉で探す。「前にこんな話したっけ？」「一年前にこんな相談しなかった？」など、昔の会話の詳しい中身が必要なとき',
  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '探す言葉（1〜5個）。どれか1つでも含む発言が見つかる。言い換えも入れる（例: ["転職", "仕事を変える", "退職"]）',
      },
      from: { type: 'string', description: '探す期間のはじめ。YYYY-MM-DD か YYYY-MM（省略すると、いちばん古い会話から）' },
      to: { type: 'string', description: '探す期間の終わり。YYYY-MM-DD か YYYY-MM（省略すると、今まで）' },
    },
    required: ['keywords'],
  },
};

/** 今回の会話で渡す道具。使いそうにない道具は、説明ごと渡さない */
function chatFunctions(groups) {
  const declarations = [
    ...(groups.history ? [SEARCH_HISTORY_DECLARATION] : []),
    ...(groups.timer ? REMINDER_FUNCTION_DECLARATIONS : []),
    ...(groups.calendar ? CALENDAR_FUNCTION_DECLARATIONS : []),
  ];
  if (declarations.length === 0) return null;
  return {
    declarations,
    call: (functionCall) => {
      if (CALENDAR_FUNCTION_NAMES.has(functionCall.name)) return callCalendarFunction(functionCall);
      if (functionCall.name === 'search_history') return searchHistory(functionCall.args);
      return callReminderFunction(functionCall);
    },
  };
}

/** 保管庫と直近の履歴から、昔の会話を探す。見つかった発言だけを Gemini に返す */
async function searchHistory({ keywords, from, to } = {}) {
  const { store } = state;
  const range = { from: parseDay(from) ?? -Infinity, to: parseDay(to, true) ?? Infinity };
  let archived;
  try {
    archived = await store.archive.readRange(range);
  } catch (err) {
    return { ok: false, error: `保管庫を読めませんでした: ${err.message}` };
  }
  const words = (Array.isArray(keywords) ? keywords : [keywords]).slice(0, 5);
  const result = searchConversations(
    { messages: mergeMessages(archived, store.messages), summaries: store.summaries },
    { keywords: words, ...range },
  );
  // 1年以上前の話もあるので、年も付ける
  const time = (at) => `${new Date(at).getFullYear()}年${formatMessageTime(at)}`;
  return {
    ok: true,
    found: result.total,
    conversations: result.hits.map((hit) =>
      hit.map((message) => `[${time(message.at)}] ${message.role === 'user' ? 'ユーザー' : 'あなた'}: ${message.content}`),
    ),
    summaries: result.summaries.map(({ date, summary }) => `${date}: ${summary}`),
  };
}

module.exports = { toolGroups, chatFunctions };
