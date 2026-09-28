'use strict';

// 会話のたびに Gemini へ渡す「道具の説明」を、その回に使いそうなものだけに絞る。
// 昨日から6日前までの会話（約700トークン）も、昔の話が出た回にだけ渡す（pastDays）。
// 説明（JSON）は重く、実測でタイマーと履歴探しが約700トークン、カレンダーが約830トークン。
// 毎回ぜんぶ渡すと、どちらにも関係ない雑談でもその分を払うことになる。
// 拾いすぎても損はしない（元に戻るだけ）ので、言葉は広めに取ってある。
// Electron に依存しないので、node だけでテストできる（test/chat-tools.test.js）。

const TOOL_WORDS = Object.freeze({
  timer: /タイマー|リマインド|リマインダー|アラーム|知らせ|しらせ|教えて|おしえて|起こして|セット|後に|あとで|後で|\d+\s*(秒|分|時間|日)|時に|時半|分後|キャンセル|取り消|やめて|忘れず|忘れない/,
  history: /前に|以前|昔|去年|先月|先週|おととい|覚え|おぼえ|話した|言ってた|なんだっけ|何だっけ|いつ|あのとき|あの時/,
  // 昨日より前の会話を渡す言葉。history の言葉のほかに、最近の話を指す言葉を足す。
  // 「さっき」は、夜中の 0 時をまたいで話したとき、前の日の会話が今日の会話に入らないため
  pastDays: /さっき|先ほど|昨日|きのう|この前|このまえ|こないだ|この間|先日|最近|続き|つづき|どうなった|その後|あれから/,
  // 「1001歓迎会1900」のような数字だけのメモ書きも拾えるよう、3〜4けたの数字・日付・時刻も入れてある
  calendar:
    /予定|スケジュール|カレンダー|会議|打ち合わせ|ミーティング|アポ|空いて|あいて|入れて|いれて|入れと|いれと|入って|はいって|登録|追加|日程|何時|なんじ|今日|明日|明後日|来週|今週|土曜|日曜|月曜|火曜|水曜|木曜|金曜|(歓迎|送別|飲み|懇親|勉強|説明|忘年|新年|食事)会|面談|面接|病院|歯医者|\d{1,2}月|\d{1,2}日|\d{1,2}:\d{2}|\d{3,4}/,
});

/** 全角の数字や記号（１９００、：）を半角にそろえる */
function normalize(text) {
  return String(text ?? '').normalize('NFKC');
}

/**
 * この発言で渡す道具の組み合わせ。システムプロンプトの説明も、これに合わせる
 * @param {string} userText 話しかけられた言葉
 * @param {{ hasReminders?: boolean, calendarInChat?: boolean, previousText?: string }} [state]
 *   previousText は少し前の、ひとつ前の発言。「入ってないよ」のような続きの話にも道具（と昔の会話）を渡すため
 */
function toolGroups(userText, { hasReminders = false, calendarInChat = false, previousText = '' } = {}) {
  const text = normalize(userText);
  const previous = normalize(previousText);
  const talksAboutPast = (t) => TOOL_WORDS.history.test(t) || TOOL_WORDS.pastDays.test(t);
  return {
    // 登録中のタイマーがあるときは、取り消しや問い合わせに答えられるよう必ず渡す
    timer: hasReminders || TOOL_WORDS.timer.test(text),
    history: TOOL_WORDS.history.test(text),
    // カレンダー連携を会話で使う設定のときだけ。ひとつ前が予定の話なら、その続きとして渡す
    calendar: calendarInChat && (TOOL_WORDS.calendar.test(text) || TOOL_WORDS.calendar.test(previous)),
    // 道具ではなく、昨日より前の会話をシステムプロンプトに入れるかどうか。ひとつ前が昔の話なら、その続きとして入れる
    pastDays: talksAboutPast(text) || talksAboutPast(previous),
  };
}

module.exports = { TOOL_WORDS, toolGroups };
