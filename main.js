'use strict';

// メインプロセスの入口。起動の順番だけをここに書き、中身は main/ フォルダに役目ごとに分けてある
//   state.js          設定・保存先・窓など、あちこちで使うもの
//   mascot-window.js  マスコットの窓（出す・隠す・ドラッグ・高さ合わせ）
//   menu.js           タスクトレイと右クリックのメニュー
//   settings-panel.js 設定ウィンドウ（sound-settings / autostart / sharing / calendar-link も設定の操作を持つ）
//   chat.js           会話（prompt.js でプロンプトを組み、tools.js の道具を渡し、gemini.js で送る）
//   reminders.js      タイマーとリマインダー（知らせる文は notices.js が出す）

const { app } = require('electron');
const path = require('path');

// アプリ用の保存場所（%APPDATA%\Desktop Mascot）を、開発中（npm start）と exe で揃える。
// 「マスコットは1つだけ」の決まりはこのフォルダ単位なので、揃えると両方にまたがって効く。
// 保存先を決めるより前（main/ を読み込む前）にしておく
app.setPath('userData', path.join(app.getPath('appData'), 'Desktop Mascot'));

// 自動起動と手動の起動が重なっても、マスコットは1つだけにする
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const state = require('./main/state');
const { createWindow, showMascot } = require('./main/mascot-window');
const { createTray } = require('./main/menu');
const { applyOpenAtLogin, AUTOSTART_ARG, AUTOSTART_DELAY_MS } = require('./main/autostart');
const { watchSharedHistory } = require('./main/sharing');
const { REMINDER_CHECK_INTERVAL_MS, checkReminders } = require('./main/reminders');
const { checkCalendar } = require('./main/calendar-link');
const { deliverNotices } = require('./main/notices');
const { summarizeDay } = require('./main/chat');
// 設定ウィンドウや豆の窓からの呼び出し（ipc）を受け付けるだけのもの
require('./main/sound-settings');
require('./main/image-drop');

// 隠したまま忘れて、もう一度起動しようとしたときは、隠れているマスコットを出す
app.on('second-instance', () => {
  if (app.isReady()) showMascot();
});

app.whenReady().then(async () => {
  const { store } = state;
  applyOpenAtLogin();
  store.load();
  watchSharedHistory();
  state.reminders.load();
  state.googleAuth.load();
  state.apiKeys.load();
  // 1秒ごとに、時間が来たタイマー・リマインダーと、10分前になった予定を知らせる
  setInterval(() => {
    checkReminders();
    checkCalendar();
    deliverNotices();
  }, REMINDER_CHECK_INTERVAL_MS);
  try {
    createTray();
  } catch (err) {
    // アイコン未配置でも起動は止めない
    console.warn('トレイの作成をスキップしました:', err.message);
  }

  // 自動起動のときだけ、少し待ってから表示する（待っている間もトレイからは操作できる）
  if (process.argv.includes(AUTOSTART_ARG)) {
    console.log(`[startup] 自動起動なので ${AUTOSTART_DELAY_MS / 1000} 秒待ってから表示します`);
    await new Promise((resolve) => setTimeout(resolve, AUTOSTART_DELAY_MS));
  }
  // 待っている間にトレイから「表示」を押されていたら、もう出ている
  if (!state.win) createWindow();
  console.log('[startup] マスコットを表示しました');

  // 昔の会話を覚えない設定のときは、要約せず（Gemini も呼ばず）、切った後の昨日より前の発言を捨てるだけ
  if (!state.settings.keepPast) {
    if (store.dropStaleEphemeral() > 0) store.save().catch(() => {});
    return;
  }
  // 7日より前の会話の要約は、起動時に1回だけ行う。終わるのを待たずに会話できる
  store.compact(summarizeDay).then(({ summarizedDays, failedDay }) => {
    if (summarizedDays.length) console.log('[history] 要約しました:', summarizedDays.join(', '));
    if (failedDay) console.log('[history] 次回の起動で続きを要約します:', failedDay);
  });
});

// 自動起動の待ち時間中（マスコットの窓がまだ無い）に設定ウィンドウを閉じても、終了しない
app.on('window-all-closed', () => {
  if (state.win) app.quit();
});
