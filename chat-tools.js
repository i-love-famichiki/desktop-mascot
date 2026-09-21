'use strict';

// 会話のたびに Gemini へ渡す「道具の説明」を、その回に使いそうなものだけに絞る。
// 説明（JSON）は重く、実測でタイマーと履歴探しが約700トークン、カレンダーが約830トークン。
// 毎回ぜんぶ渡すと、どちらにも関係ない雑談でもその分を払うことになる。
// 拾いすぎても損はしない（元に戻るだけ）ので、言葉は広めに取ってある。
// Electron に依存しないので、node だけでテストできる（test/chat-tools.test.js）。

const TOOL_WORDS = Object.freeze({
  timer: /タイマー|リマインド|リマインダー|アラーム|知らせ|しらせ|教えて|おしえて|起こして|セット|後に|あとで|後で|\d+\s*(秒|分|時間|日)|時に|時半|分後|キャンセル|取り消|やめて|忘れず|忘れない/,
  history: /前に|以前|昔|去年|先月|先週|おととい|覚え|おぼえ|話した|言ってた|なんだっけ|何だっけ|いつ|あのとき|あの時/,
  calendar: /予定|スケジュール|カレンダー|会議|打ち合わせ|ミーティング|アポ|空いて|あいて|入れて|いれて|日程|何時|なんじ|今日|明日|明後日|来週|今週|土曜|日曜|月曜|火曜|水曜|木曜|金曜/,
});

/**
 * この発言で渡す道具の組み合わせ。システムプロンプトの説明も、これに合わせる
 * @param {string} userText 話しかけられた言葉
 * @param {{ hasReminders?: boolean, calendarInChat?: boolean }} [state]
 */
function toolGroups(userText, { hasReminders = false, calendarInChat = false } = {}) {
  const text = String(userText ?? '');
  return {
    // 登録中のタイマーがあるときは、取り消しや問い合わせに答えられるよう必ず渡す
    timer: hasReminders || TOOL_WORDS.timer.test(text),
    history: TOOL_WORDS.history.test(text),
    // カレンダー連携を会話で使う設定のときだけ
    calendar: calendarInChat && TOOL_WORDS.calendar.test(text),
  };
}

module.exports = { TOOL_WORDS, toolGroups };
