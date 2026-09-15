'use strict';

// 要約の動作確認用に、日付の古い会話が入った履歴ファイルを作る。
// 日付は「今日」を基準に何日前かで決めるので、PC の日付を変えずに試せる。
//
// 使い方（PowerShell）:
//   npm run mock-history                          → data/test-history.json を作る
//   $env:MASCOT_HISTORY_FILE = "data/test-history.json"; npm start
//   （終わったら  Remove-Item Env:MASCOT_HISTORY_FILE  で本番の履歴に戻す）
//
// 起動すると 7 日より前の日（12・9・7 日前）が要約され、6 日前と昨日は詳しいまま残る。

const fs = require('fs');
const path = require('path');

const target = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'data', 'test-history.json'));
if (path.basename(target) === 'history.json') {
  console.error('本番の履歴（history.json）は上書きしません。別の名前を指定してください。');
  process.exit(1);
}

/** 今日から daysAgo 日前の hour:minute（ローカル時刻） */
function daysAgo(days, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const conversations = [
  [12, [
    ['user', 'うちの猫の名前はミケっていうんだ。三毛猫で5歳だよ。'],
    ['assistant', 'ミケちゃん、かわいい名前だね。5歳ならまだまだ元気いっぱいだね。'],
    ['user', '最近ごはんをあまり食べなくて心配。'],
    ['assistant', 'それは心配だね。何日も続くなら、動物病院で診てもらうと安心だよ。'],
  ]],
  [9, [
    ['user', '奥歯が痛くて、来週の月曜に歯医者を予約した。'],
    ['assistant', '痛いのはつらいね。月曜まで、冷たいものや硬いものは控えめにしてね。'],
  ]],
  [7, [
    ['user', 'Python の勉強を始めたよ。for 文がよく分からない。'],
    ['assistant', 'for 文は、リストの中身を1つずつ順番に取り出して同じ処理をくり返す書き方だよ。'],
  ]],
  [6, [
    ['user', '好きな食べ物はカレー。辛口派。'],
    ['assistant', '辛口カレー、いいね。スパイスの香りがたまらないよね。'],
  ]],
  [1, [
    ['user', 'おはよう'],
    ['assistant', 'おはよう。今日もよろしくね。'],
  ]],
];

const messages = [];
for (const [days, lines] of conversations) {
  lines.forEach(([role, content], index) => {
    messages.push({ role, content, at: daysAgo(days, 20, index) });
  });
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ version: 1, messages, summaries: [] }, null, 2), 'utf8');
console.log(`モックの履歴を作りました: ${target}`);
console.log(`  会話 ${messages.length} 件（12・9・7 日前は要約の対象、6 日前と昨日は詳しいまま残る）`);
