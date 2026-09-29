'use strict';

// 会話で Gemini に渡すもの（システムプロンプトと、今日の会話）を組み立てる

const state = require('./state');
const { describeElapsed, formatMessageTime, localIsoString } = require('./format');
const { reminderPromptLines } = require('./reminders');
const { CALENDAR_IDLE_LINES, calendarInChat, calendarPromptLines, calendarUnavailableLines } = require('./calendar-link');

// 送る会話履歴の上限（今日の直近20往復まで）。昨日より前の会話は、システムプロンプトに短く入れる
const HISTORY_MAX_TURNS = 20;

// 「分からないことは分からないと言って」だけだと、キャラになりきって
// 知っていることまで分からないと答えてしまうため、答えてよい範囲をはっきり書く。
// 天気やニュースは Google 検索（tools の google_search）で調べられるので、
// 検索するかどうかはモデル自身に判断させる。
// 日付は話しかけるたびに入れ直す（モデルは今日が何日か知らない）。
function buildSystemPrompt(
  groups = { timer: true, history: true, calendar: calendarInChat(), pastDays: true },
  search = state.settings.webSearch ? 'on' : 'off',
) {
  const { settings } = state;
  // 昔の会話を覚えない設定のときは、昔の会話探しも昨日より前の会話も渡さない
  if (!settings.keepPast) groups = { ...groups, history: false, pastDays: false };
  const now = new Date().toLocaleString('ja-JP', { dateStyle: 'full', timeStyle: 'short' });
  return [
    'あなたはユーザーのデスクトップに住んでいるマスコットです。',
    '見た目はマスコットですが、中身は物知りな AI アシスタントです。',
    '漢字、言葉、料理、勉強、プログラミングなど、一般的な知識で答えられることは遠慮なく教えてください。',
    '「ぼくはマスコットだから」「食べたことがないから」などを理由に、知っていることを分からないと言ってはいけません。',
    ...searchPromptLines(search),
    '場所によって答えが変わる質問（天気など）で場所が分からないときは、短く聞き返してください。',
    `現在の日時は ${now}（ISO 8601 では ${localIsoString(Date.now())}）です。`,
    ...elapsedPromptLines(),
    'ユーザーの発言の先頭にある [9月16日 21:33] のような表記は、その発言をした日時です。',
    '「さっき」「朝に話した」などの時間の感覚に使ってください。返事には、この日時の表記を付けないでください。',
    '名前はまだありません。ユーザーが名前をくれたら喜んで受け取ってください。',
    '口調は親しみやすく、少しだけ子どもっぽく、絵文字は使いません。',
    '返事は必ず日本語で、基本は2〜3文の短さに収めてください。画面の小さな吹き出しに表示されます。',
    // 道具の使い方は、その道具を渡す回にだけ書く（渡していない道具の話を書くと、
    // 持っていない道具を使ったつもりで返事をしてしまう）
    ...(groups.timer ? reminderPromptLines() : []),
    ...(groups.calendar ? calendarPromptLines() : calendarInChat() ? CALENDAR_IDLE_LINES : calendarUnavailableLines()),
    ...(groups.history
      ? [
          '',
          '以前の会話について聞かれ、下の会話や要約だけでは詳しく分からないときは、search_history で保管庫を探してから答えてください。',
          '言い換えも考えて、言葉はいくつか渡してください（例: 転職、仕事を変える、退職）。',
          '「一年前」「去年の夏」などは、現在の日時をもとに期間（from / to）に直してください。',
          '見つからなかったときは、覚えていないと正直に答えてください。見つからない話を作ってはいけません。',
        ]
      : []),
    ...(!settings.keepPast ? NO_PAST_LINES : groups.pastDays ? pastDaysPromptLines() : PAST_DAYS_IDLE_LINES),
    ...(settings.keepPast ? memoryPromptLines() : []),
  ].join('\n');
}

// 前回の会話からどれくらいたったか。「久しぶり」「さっきの続き」を判断できるようにする
function elapsedPromptLines() {
  const last = state.store.messages.at(-1);
  if (!last) return ['ユーザーと話すのは、今回が初めてか、しばらくぶりです。'];
  return [`前回ユーザーと話したのは ${describeElapsed(Date.now() - last.at)}（${formatMessageTime(last.at)}）です。`];
}

// 昨日から6日前までの詳しい会話。今日の会話は contents で送るので、ここには入れない。
// 約700トークンあるので、昔の話が出た回にだけ入れる（chat-tools.js の pastDays）
function pastDaysPromptLines() {
  const messages = state.store.pastDaysMessages();
  if (messages.length === 0) return [];
  return [
    '',
    '以下は、昨日より前の最近の会話（新しい方の一部）です。',
    '「昨日話したこと」など、今の話題に関係があるときに参考にしてください。関係がなければ自分から持ち出さないでください。',
    ...messages.map((message) => {
      const speaker = message.role === 'user' ? 'ユーザー' : 'あなた';
      return `[${formatMessageTime(message.at)}] ${speaker}: ${message.content.replace(/\s*\n\s*/g, ' ')}`;
    }),
  ];
}

// 昨日より前の会話を入れない回に出す1行。入れていないのに、覚えているふりで話を合わせないようにする
const PAST_DAYS_IDLE_LINES = Object.freeze([
  '',
  '昨日より前の会話は、この回は渡していません。前に話したことを持ち出されて分からないときは、知ったかぶりせず短く聞き返してください。',
]);

// 検索についての指示。'refused' は、検索つきで頼んだら断られて、検索なしでやり直している回
function searchPromptLines(search) {
  if (search === 'on') return ['天気、ニュース、最近の出来事など新しい情報が必要なときは、Google 検索で調べてから答えてください。'];
  if (search === 'refused') {
    return [
      '今回は Google 検索が使えませんでした（無料枠のキーでは、検索は断られます）。天気、ニュース、最近の出来事など新しい情報が必要なときは、調べられなかったことを短く伝えてください（無料枠のキーなら検索は使えないことも、ひとこと添えてください）。古い知識で言い切ってはいけません。そういう質問でないときは、検索できないことに触れないでください。',
    ];
  }
  return [
    '今は Google 検索を使えない設定です。天気、ニュース、最近の出来事など新しい情報が必要なときは、設定で検索を切ってあるので調べられないことと、設定の「KEY」タブで「Google 検索を使う」を入れれば調べられることを、短く伝えてください（無料枠のキーでは検索が使えないことも、ひとこと添えてください）。古い知識で言い切ってはいけません。そういう質問でないときは、検索できないことに触れないでください。',
  ];
}

// 設定で昔の会話を覚えないようにしているときの1行
const NO_PAST_LINES = Object.freeze([
  '',
  '昨日より前の会話は覚えない設定になっています。今日の会話（下にあるもの）は覚えているので、そこに出てきたことは普通に使ってください。',
  '今日の会話に無い、前に話したことを持ち出されたときだけ、覚えていないと短く伝えてください。',
]);

// 7日より前の会話は要約だけが残っている。話題に関係があるときだけ使ってもらう
function memoryPromptLines() {
  const summaries = state.store.summariesForPrompt();
  if (!summaries) return [];
  return [
    '',
    '以下は、1週間より前にユーザーと話した内容の短い要約（古い記憶）です。',
    '今の話題に関係があるときだけ参考にし、関係がなければ自分から持ち出さないでください。',
    summaries,
  ];
}

/** 今日の直近の会話に新しい発言を足して、Gemini に送る contents の形にする */
// ユーザーの発言にだけ、話した日時を先頭に付けて送る（保存している会話には付けない）。
// まめの返事に付けると、まねして返事に日時を書き始めることがあるので付けない
function buildContents(pastMessages, userText) {
  const since = new Date().setHours(0, 0, 0, 0);
  const withTime = (text, at) => `[${formatMessageTime(at)}] ${text}`;
  return [
    ...pastMessages
      .filter((message) => message.at >= since)
      .slice(-HISTORY_MAX_TURNS * 2)
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.role === 'user' ? withTime(message.content, message.at) : message.content }],
      })),
    { role: 'user', parts: [{ text: withTime(userText, Date.now()) }] },
  ];
}

module.exports = { buildSystemPrompt, buildContents };
