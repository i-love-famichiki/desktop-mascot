'use strict';

// 吹き出しで知らせる文（タイマー・リマインダー・カレンダーの予定）。
// 自動起動の待ち時間中などで窓がまだ無いときは、出せるようになるまでためておく

const state = require('./state');
const { showMascot } = require('./mascot-window');

let dueNotices = [];

function pushNotice(text) {
  dueNotices.push(text);
}

function deliverNotices() {
  const { win } = state;
  if (dueNotices.length === 0 || !win || win.webContents.isLoading()) return;
  // 隠しているときも気づけるよう、表に出してから知らせる
  if (!win.isVisible()) showMascot();
  win.webContents.send('reminder:due', dueNotices.join('\n\n'));
  dueNotices = [];
}

// 豆の画面を読み終えたら、たまっていた分を出す
state.events.on('window-loaded', deliverNotices);

module.exports = { pushNotice, deliverNotices };
