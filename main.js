'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, net, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { HistoryStore } = require('./history-store');
const { loadSettings, saveSettings } = require('./settings');

// 自動起動（Windows にサインインしたとき立ち上がる）で起動されたときに付く目印
const AUTOSTART_ARG = '--autostart';
// 自動起動のときは、ほかの常駐アプリと重ならないよう少し待ってから表示する
const AUTOSTART_DELAY_MS = 15 * 1000;
// レジストリ（HKCU\...\CurrentVersion\Run）に書く名前
const LOGIN_ITEM_NAME = 'DesktopMascot';

// アプリ用の保存場所（%APPDATA%\Desktop Mascot）を、開発中（npm start）と exe で揃える。
// 「マスコットは1つだけ」の決まりはこのフォルダ単位なので、揃えると両方にまたがって効く
app.setPath('userData', path.join(app.getPath('appData'), 'Desktop Mascot'));

// 自動起動と手動の起動が重なっても、マスコットは1つだけにする
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Gemini API で返事をもらう。キーは環境変数 GEMINI_API_KEY から読む。
// 雑談用なので速くて安いモデルを使う。賢さが欲しくなったら 'gemini-3.8-flash' などに。
const MODEL = 'gemini-3.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const GEMINI_TIMEOUT_MS = 30 * 1000;

// 吹き出しに添える出典の数の上限（小さい吹き出しなので少なめに）
const SOURCES_MAX = 3;

// 送る会話履歴の上限（今日の直近20往復まで）
const HISTORY_MAX_TURNS = 20;
// 1回の発言も長すぎると文脈を圧迫するので上限を設けておく
const USER_TEXT_MAX_CHARS = 2000;

// 古い会話の要約。1日分の会話ログは長すぎる分を切ってから送り、要約も短く切る
const SUMMARY_SOURCE_MAX_CHARS = 8000;
const SUMMARY_MAX_CHARS = 150;
const SUMMARY_PROMPT = [
  'あなたは会話ログを短くまとめる係です。',
  'ユーザーとデスクトップマスコットの1日分の会話ログを、日本語で1〜2文（100文字程度まで）に要約してください。',
  '話題と、ユーザーについて分かったこと（名前、好み、予定、困っていることなど）を優先して残してください。',
  'あいさつや短い雑談だけの日は「軽い雑談のみ」のように短く書いてください。',
  '後から読んでも分かるよう、「明日」「来週の月曜」などは会話の日付をもとに「9月14日」のような日付に直してください。',
  '前置きや箇条書きは使わず、要約の文だけを返してください。',
].join('\n');

// 「分からないことは分からないと言って」だけだと、キャラになりきって
// 知っていることまで分からないと答えてしまうため、答えてよい範囲をはっきり書く。
// 天気やニュースは Google 検索（tools の google_search）で調べられるので、
// 検索するかどうかはモデル自身に判断させる。
// 日付は話しかけるたびに入れ直す（モデルは今日が何日か知らない）。
function buildSystemPrompt() {
  const now = new Date().toLocaleString('ja-JP', { dateStyle: 'full', timeStyle: 'short' });
  return [
    'あなたはユーザーのデスクトップに住んでいるマスコットです。',
    '見た目はマスコットですが、中身は物知りな AI アシスタントです。',
    '漢字、言葉、料理、勉強、プログラミングなど、一般的な知識で答えられることは遠慮なく教えてください。',
    '「ぼくはマスコットだから」「食べたことがないから」などを理由に、知っていることを分からないと言ってはいけません。',
    '天気、ニュース、最近の出来事など新しい情報が必要なときは、Google 検索で調べてから答えてください。',
    '場所によって答えが変わる質問（天気など）で場所が分からないときは、短く聞き返してください。',
    `現在の日時は ${now} です。`,
    ...elapsedPromptLines(),
    'ユーザーの発言の先頭にある [9月16日 21:33] のような表記は、その発言をした日時です。',
    '「さっき」「朝に話した」などの時間の感覚に使ってください。返事には、この日時の表記を付けないでください。',
    '名前はまだありません。ユーザーが名前をくれたら喜んで受け取ってください。',
    '口調は親しみやすく、少しだけ子どもっぽく、絵文字は使いません。',
    '返事は必ず日本語で、基本は2〜3文の短さに収めてください。画面の小さな吹き出しに表示されます。',
    ...memoryPromptLines(),
  ].join('\n');
}

// 前回の会話からどれくらいたったか。「久しぶり」「さっきの続き」を判断できるようにする
function elapsedPromptLines() {
  const last = store.messages.at(-1);
  if (!last) return ['ユーザーと話すのは、今回が初めてか、しばらくぶりです。'];
  return [`前回ユーザーと話したのは ${describeElapsed(Date.now() - last.at)}（${formatMessageTime(last.at)}）です。`];
}

/** 経過時間を「5分前」「3時間前」「2日前」のように言い表す */
function describeElapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/** 発言の日時を「9月16日 21:33」の形にする */
function formatMessageTime(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 7日より前の会話は要約だけが残っている。話題に関係があるときだけ使ってもらう
function memoryPromptLines() {
  const summaries = store.summariesForPrompt();
  if (!summaries) return [];
  return [
    '',
    '以下は、1週間より前にユーザーと話した内容の短い要約（古い記憶）です。',
    '今の話題に関係があるときだけ参考にし、関係がなければ自分から持ち出さないでください。',
    summaries,
  ];
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;

// 会話履歴と設定の保存先。exe ではアプリのフォルダに書き込めないことがあるので
// アプリ用の保存場所に置く。開発中（npm start）は今まで通りプロジェクトの data/ に置く
const dataDir = app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'data');

// 設定（自動起動の ON/OFF など）。テストのときは MASCOT_SETTINGS_FILE で差し替えられる
const settingsFile = process.env.MASCOT_SETTINGS_FILE
  ? path.resolve(process.env.MASCOT_SETTINGS_FILE)
  : path.join(dataDir, 'settings.json');
let settings = loadSettings(settingsFile);

// 共有フォルダの中に作る、このアプリ用のフォルダの名前
const SHARE_SUBFOLDER = 'Desktop Mascot';
// 共有中、ほかの PC で書き足されていないかファイルを見に行く間隔
const SHARE_WATCH_INTERVAL_MS = 5 * 1000;

/** 会話履歴のファイルの場所。共有中は共有フォルダ、そうでなければこの PC の中 */
function historyFilePath() {
  if (process.env.MASCOT_HISTORY_FILE) return path.resolve(process.env.MASCOT_HISTORY_FILE);
  return path.join(settings.historyFolder || dataDir, 'history.json');
}

// 会話履歴はメインプロセスだけが持ち、history.json に保存する（終了しても消えない）。
// テストのときは環境変数 MASCOT_HISTORY_FILE で保存先を差し替えられる。
const store = new HistoryStore(historyFilePath());

// ウィンドウの基本の高さ。長い返事のときだけ一時的に上へ伸ばす
const WINDOW_MIN_HEIGHT = 420;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: 320,
    height: WINDOW_MIN_HEIGHT,
    // 右下に初期配置
    x: workArea.x + workArea.width - 360,
    y: workArea.y + workArea.height - 460,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 全画面アプリの上にも出す
  win.setAlwaysOnTop(true, 'screen-saver');
  // 透明な部分のクリックは後ろのアプリに渡す。マウスの動きだけは受け取り、
  // マスコットや吹き出しの上に来たらレンダラーが受け付けに切り替える
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');

  // 検索候補の枠の中のリンクは新しいウィンドウとして開かれる。アプリの中では開かず、
  // Google 検索のページだけを外部ブラウザに渡す
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleSearchUrl(url)) shell.openExternal(url);
    else console.warn('[link] 開かなかったリンク:', url);
    return { action: 'deny' };
  });

  // 「隠す／表示」のメニューの文字を合わせる
  win.on('show', refreshTrayMenu);
  win.on('hide', refreshTrayMenu);
  refreshTrayMenu();
}

// ---------------------------------------------------------------------------
// 表示／非表示（終了せずに引っ込める）
// ---------------------------------------------------------------------------
/** マスコットを出す。自動起動の待ち時間中なら、待たずにすぐ出す */
function showMascot() {
  if (!win) {
    createWindow();
    return;
  }
  win.show();
  // 隠している間に外れることがあるので、一番手前に出す指定をかけ直す
  win.setAlwaysOnTop(true, 'screen-saver');
}

function hideMascot() {
  if (!win) return;
  win.hide();
  // 隠すとマウスはもう上に無いので、次に出したとき透明な所が素通りになるよう戻しておく
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.send('window:hidden');
}

function toggleMascot() {
  if (win?.isVisible()) hideMascot();
  else showMascot();
}

// 隠したまま忘れて、もう一度起動しようとしたときは、隠れているマスコットを出す
app.on('second-instance', () => {
  if (app.isReady()) showMascot();
});

function createTray() {
  // アイコンは後で差し替える。空でもトレイには載る。
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Desktop Mascot（クリックで表示／非表示）');
  tray.setContextMenu(buildMenu());
  // 左クリックで隠す／表示を切り替える（右クリックはメニュー）
  tray.on('click', toggleMascot);
}

/** トレイのメニューは作った時点の表示を持っているので、状態が変わったら作り直す */
function refreshTrayMenu() {
  tray?.setContextMenu(buildMenu());
}

/** トレイと、マスコットの右クリックで共通のメニュー */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: win?.isVisible() ? 'マスコットを隠す' : 'マスコットを表示', click: toggleMascot },
    { type: 'separator' },
    {
      label: '会話の履歴を見る',
      click: () => {
        if (!win) return;
        showMascot();
        win.webContents.send('history:show');
      },
    },
    { label: '会話をリセット', click: confirmReset },
    {
      label: 'ほかの PC と会話を共有',
      submenu: [
        {
          label: settings.historyFolder ? `共有中: ${settings.historyFolder}` : '共有していません',
          enabled: false,
        },
        { label: '共有するフォルダを選ぶ…', click: chooseShareFolder },
        { label: '共有をやめる', enabled: Boolean(settings.historyFolder), click: stopSharing },
      ],
    },
    { type: 'separator' },
    {
      label: '起動時に自動で立ち上げる',
      type: 'checkbox',
      checked: settings.openAtLogin,
      // チェックの表示は押した時点で切り替わっているので、その値を保存する
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'このアプリについて', click: showAbout },
    { label: '終了', click: () => app.quit() },
  ]);
}

// ---------------------------------------------------------------------------
// 自動起動
// ---------------------------------------------------------------------------
function setOpenAtLogin(enabled) {
  settings = { ...settings, openAtLogin: enabled };
  saveSettings(settingsFile, settings);
  applyOpenAtLogin();
  refreshTrayMenu();
}

/**
 * 設定に合わせて、Windows の自動起動の登録（レジストリの Run）を書く／消す。
 * 起動のたびに呼び、フォルダを移したときなどもここで登録し直す。
 */
function applyOpenAtLogin() {
  // 開発中（npm start）に登録すると、インストールした exe の登録を electron.exe で
  // 上書きしてしまうので、登録は exe のときだけ行う
  if (!app.isPackaged) {
    console.log('[startup] 開発中なので自動起動の登録は変えません');
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: settings.openAtLogin,
    name: LOGIN_ITEM_NAME,
    path: process.execPath,
    args: [AUTOSTART_ARG],
  });
}

// ---------------------------------------------------------------------------
// ほかの PC と会話を共有する
// ---------------------------------------------------------------------------
// 会話の履歴を Google ドライブなどのフォルダに置き、ほかの PC のマスコットと同じファイルを使う。
// 同期はドライブのアプリに任せ、こちらは保存のたびに混ぜることと、変化を見に行くことだけをする。

function showDialog(options) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/** 共有フォルダを最初に開く場所。Google ドライブか OneDrive があればそこから */
function defaultShareParent() {
  const candidates = ['G:\\マイドライブ', 'G:\\My Drive', process.env.OneDrive, app.getPath('documents')];
  return candidates.find((dir) => dir && fs.existsSync(dir));
}

async function chooseShareFolder() {
  const options = {
    title: '会話を共有するフォルダを選ぶ',
    message: 'Google ドライブなど、ほかの PC と同期しているフォルダを選んでください',
    buttonLabel: 'このフォルダで共有',
    defaultPath: defaultShareParent(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (canceled || !filePaths[0]) return;

  // 選んだフォルダの中に専用のフォルダを作る。専用のフォルダそのものを選んだときはそのまま使う
  const picked = filePaths[0];
  const folder = path.basename(picked) === SHARE_SUBFOLDER ? picked : path.join(picked, SHARE_SUBFOLDER);

  try {
    await switchHistoryFolder(folder);
  } catch (err) {
    await showDialog({
      type: 'error',
      title: '会話を共有できませんでした',
      message: 'そのフォルダに会話を保存できませんでした。',
      detail: `${err.message}\n\nドライブのアプリが動いているか確かめてから、もう一度選んでください。`,
    });
    return;
  }
  await showDialog({
    type: 'info',
    title: '会話の共有を始めました',
    message: `会話を「${folder}」に保存します。`,
    detail: 'ほかの PC でも、右クリックメニューの「ほかの PC と会話を共有」から、同じフォルダを選んでください。',
  });
}

async function stopSharing() {
  await switchHistoryFolder('');
  await showDialog({
    type: 'info',
    title: '会話の共有をやめました',
    message: 'これからの会話は、この PC の中だけに保存します。',
    detail: 'これまでの会話はこの PC にも残しています。共有フォルダの中身は消していません。',
  });
}

/** 履歴の保存先を移し、設定に残す。移した先にあった会話とは混ぜる */
async function switchHistoryFolder(folder) {
  const previous = settings.historyFolder;
  settings = { ...settings, historyFolder: folder };
  try {
    await store.moveTo(historyFilePath());
  } catch (err) {
    // 保存できなかったら元の場所に戻す
    settings = { ...settings, historyFolder: previous };
    await store.moveTo(historyFilePath()).catch(() => {});
    throw err;
  }
  saveSettings(settingsFile, settings);
  watchSharedHistory();
  refreshTrayMenu();
}

let watchedFile = null;

/** 共有中は、ほかの PC が書き足していないかファイルを見に行き、変わっていたら取り込む */
function watchSharedHistory() {
  if (watchedFile) fs.unwatchFile(watchedFile);
  watchedFile = null;
  if (!settings.historyFolder || process.env.MASCOT_HISTORY_FILE) return;

  watchedFile = store.filePath;
  // ドライブが後からつながったとき（サインイン直後など）も、ファイルが現れた時点で気づける
  fs.watchFile(watchedFile, { interval: SHARE_WATCH_INTERVAL_MS }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    store.sync().then((changed) => {
      if (changed) console.log('[history] ほかの PC の会話を取り込みました');
    }).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// このアプリについて（バージョン情報）
// ---------------------------------------------------------------------------
async function showAbout() {
  await showDialog({
    type: 'none',
    icon: path.join(__dirname, 'build', 'icon.png'),
    title: 'このアプリについて',
    message: `Desktop Mascot  バージョン ${app.getVersion()}`,
    detail: [
      'デスクトップに住む枝豆のマスコット',
      '',
      `AI のモデル: ${MODEL}`,
      `会話の保存先: ${store.filePath}`,
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    ].join('\n'),
    buttons: ['閉じる'],
  });
}

ipcMain.on('menu:show', () => {
  if (win) buildMenu().popup({ window: win });
});

// 履歴はファイルに残るようになったので、消す前に確認する
async function confirmReset() {
  const options = {
    type: 'warning',
    buttons: ['消す', 'やめる'],
    defaultId: 1,
    cancelId: 1,
    title: '会話をリセット',
    message: '会話の履歴と、古い会話の要約をすべて消します。',
    detail: '消した内容は元に戻せません。',
  };
  // 自動起動の待ち時間中はまだウィンドウが無いので、トレイから押されたら単独で出す
  const { response } = await showDialog(options);
  if (response === 0) await store.clear();
}

app.whenReady().then(async () => {
  applyOpenAtLogin();
  store.load();
  watchSharedHistory();
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
  if (!win) createWindow();
  console.log('[startup] マスコットを表示しました');

  // 7日より前の会話の要約は、起動時に1回だけ行う。終わるのを待たずに会話できる
  store.compact(summarizeDay).then(({ summarizedDays, failedDay }) => {
    if (summarizedDays.length) console.log('[history] 要約しました:', summarizedDays.join(', '));
    if (failedDay) console.log('[history] 次回の起動で続きを要約します:', failedDay);
  });
});

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// ドラッグ移動
// ---------------------------------------------------------------------------
// カーソルの実座標で追従させる（DPI スケーリングでズレないようにするため）
let dragOffset = null;

ipcMain.on('drag:start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
});

ipcMain.on('drag:move', () => {
  if (!win || !dragOffset) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
});

ipcMain.on('drag:end', () => {
  dragOffset = null;
});

// ---------------------------------------------------------------------------
// ウィンドウの高さ合わせ
// ---------------------------------------------------------------------------
// 長い返事が吹き出しに収まるよう、足元の位置はそのままで上に伸ばす。
// 短くなったら元の高さまで戻す。画面の高さを超える分は吹き出しの中でスクロール。
// 画面の上端につかえたときは下へずらすので、そのずれを覚えておき、縮めるときに戻す。
let pushedDown = 0;

ipcMain.on('window:fit-height', (_event, requested) => {
  if (!win || dragOffset) return;
  const bounds = win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const height = Math.round(Math.min(Math.max(requested, WINDOW_MIN_HEIGHT), workArea.height));
  if (height === bounds.height) return;

  const bottom = bounds.y + bounds.height - pushedDown;
  const y = Math.max(workArea.y, bottom - height);
  pushedDown = y + height - bottom;
  win.setBounds({ x: bounds.x, y, width: bounds.width, height });
});

ipcMain.on('window:click-through', (_event, enabled) => {
  win?.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
});

// ---------------------------------------------------------------------------
// Gemini との会話
// ---------------------------------------------------------------------------
// 返事を待っている間に次の発言が来ても、1つずつ順番に処理する
let chatQueue = Promise.resolve();

ipcMain.handle('chat:send', (_event, userText) => {
  const reply = chatQueue.then(() => chat(clip(String(userText), USER_TEXT_MAX_CHARS)));
  chatQueue = reply.catch(() => {});
  return reply;
});

// 履歴の表示用。古い会話の要約と、直近7日の詳しい会話を渡す
ipcMain.handle('chat:history', () => ({
  summaries: store.summaries.map(({ date, summary }) => ({ date, summary })),
  messages: store.messages.map(({ role, content, at }) => ({ role, content, at })),
}));

async function chat(userText) {
  try {
    const { text, sources, searchSuggestions } = await askGemini(buildContents(store.messages, userText));
    // 返事を表示するのに保存の完了は待たない（失敗しても store 側でログに出す）
    store.append(
      { role: 'user', content: userText, at: Date.now() },
      { role: 'assistant', content: text, at: Date.now() },
    ).catch(() => {});

    return { ok: true, text, sources, searchSuggestions };
  } catch (err) {
    return { ok: false, text: describeError(err), sources: [], searchSuggestions: null };
  }
}

// 出典のリンクは既定のブラウザで開く。http(s) 以外は開かない
ipcMain.on('link:open', (_event, url) => {
  try {
    const { protocol } = new URL(String(url));
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(String(url));
  } catch {
    // URL として読めないものは無視する
  }
});

/**
 * 1日分の会話を Gemini で1〜2文に要約する（検索は使わない）。
 * @param {string} date
 * @param {{ role: string, content: string }[]} messages
 */
async function summarizeDay(date, messages) {
  const log = messages
    .map((message) => `${message.role === 'user' ? 'ユーザー' : 'マスコット'}: ${message.content}`)
    .join('\n');
  // 「来週の月曜」などを日付に直せるよう、曜日も添える
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(year, month - 1, day).toLocaleDateString('ja-JP', { weekday: 'short' });
  const { text } = await askGemini(
    [{ role: 'user', parts: [{ text: `${date}（${weekday}）の会話ログ:\n${clip(log, SUMMARY_SOURCE_MAX_CHARS)}` }] }],
    { systemPrompt: SUMMARY_PROMPT, tools: [] },
  );
  // 吹き出しや一覧で扱いやすいよう1行にまとめる
  return clip(text.replace(/\s*\n\s*/g, ' '), SUMMARY_MAX_CHARS);
}

/** 今日の直近の会話に新しい発言を足して、Gemini に送る contents の形にする */
// ユーザーの発言にだけ、話した日時を先頭に付けて送る（保存している会話には付けない）。
// まめの返事に付けると、まねして返事に日時を書き始めることがあるので付けない
function buildContents(pastMessages, userText) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const withTime = (text, at) => `[${formatMessageTime(at)}] ${text}`;
  return [
    ...pastMessages
      .filter((message) => message.at >= startOfToday)
      .slice(-HISTORY_MAX_TURNS * 2)
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.role === 'user' ? withTime(message.content, message.at) : message.content }],
      })),
    { role: 'user', parts: [{ text: withTime(userText, Date.now()) }] },
  ];
}

function clip(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

class GeminiError extends Error {
  /** @param {'no-key' | 'bad-key' | 'rate-limit' | 'blocked' | 'network' | 'timeout' | 'failed'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Gemini API を呼んで、返事の本文と出典を返す。
 * 会話では Google 検索を道具として渡しておき、検索するかどうかはモデルが決める。
 * 要約のときは systemPrompt を差し替え、tools を空にして検索させない。
 * @returns {Promise<{ text: string, sources: { title: string, uri: string }[] }>}
 */
async function askGemini(contents, { systemPrompt = buildSystemPrompt(), tools = [{ google_search: {} }] } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError('no-key', 'GEMINI_API_KEY が設定されていません');

  let res;
  try {
    // Chromium の通信機能を使う（OS の証明書ストアを使うので、セキュリティソフトの割り込みにも強い）
    res = await net.fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(tools.length > 0 && { tools }),
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (err) {
    throw err.name === 'TimeoutError'
      ? new GeminiError('timeout', `${GEMINI_TIMEOUT_MS}ms 以内に応答がありませんでした`)
      : new GeminiError('network', err.message);
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = `status=${res.status} ${body?.error?.status ?? ''} ${body?.error?.message ?? ''}`;
    const reason = body?.error?.details?.find((d) => d.reason)?.reason;
    if (reason === 'API_KEY_INVALID' || res.status === 401 || res.status === 403) {
      throw new GeminiError('bad-key', detail);
    }
    if (res.status === 429) throw new GeminiError('rate-limit', detail);
    throw new GeminiError('failed', detail);
  }

  if (body?.promptFeedback?.blockReason) {
    throw new GeminiError('blocked', `blockReason=${body.promptFeedback.blockReason}`);
  }

  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();

  if (!text) {
    const finishReason = candidate?.finishReason;
    throw new GeminiError(
      finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' ? 'blocked' : 'failed',
      `返事が空でした finishReason=${finishReason}`,
    );
  }

  return {
    text,
    sources: extractSources(candidate?.groundingMetadata),
    searchSuggestions: extractSearchSuggestions(candidate?.groundingMetadata),
  };
}

/**
 * 検索を使った返事なら、Google の規約で表示が求められている「検索候補」を取り出す。
 * html は Google が作った表示用の HTML（そのまま使う）、queries は実際に検索した言葉。
 * 検索しなかった返事では null。
 */
function extractSearchSuggestions(groundingMetadata) {
  const html = groundingMetadata?.searchEntryPoint?.renderedContent;
  const queries = (groundingMetadata?.webSearchQueries ?? []).filter((q) => typeof q === 'string' && q.trim());
  if (!html && queries.length === 0) return null;
  return { html: typeof html === 'string' ? html : '', queries };
}

/** Google 検索の結果ページの URL か（検索候補のリンクはこれだけを開く） */
function isGoogleSearchUrl(url) {
  try {
    const { protocol, hostname, pathname } = new URL(url);
    return protocol === 'https:' && /^(www\.)?google\.[a-z.]+$/.test(hostname) && pathname === '/search';
  } catch {
    return false;
  }
}

/**
 * 検索を使った返事なら、groundingMetadata から出典（サイト名とリンク）を取り出す。
 * 同じサイトが何度も出てくるので名前でまとめ、先頭から数件だけにする。
 * リンクは Google の転送用 URL で、開くと元のページに移る。
 */
function extractSources(groundingMetadata) {
  const sources = [];
  for (const chunk of groundingMetadata?.groundingChunks ?? []) {
    const { title, uri } = chunk.web ?? {};
    if (!uri || sources.some((source) => source.title === title)) continue;
    sources.push({ title: title || 'リンク', uri });
    if (sources.length >= SOURCES_MAX) break;
  }
  return sources;
}

function describeError(err) {
  console.error('[gemini]', err.message);
  switch (err instanceof GeminiError && err.kind) {
    case 'no-key':
      return 'APIキーが見つからないみたい。GEMINI_API_KEY を設定してね。';
    case 'bad-key':
      return 'APIキーが正しくないみたい。GEMINI_API_KEY を確かめてね。';
    case 'rate-limit':
      return '喋りすぎたか、検索の利用上限に達したかもしれない。少し待ってからまた話しかけて。';
    case 'blocked':
      return 'ごめん、その話にはうまく答えられないみたい。';
    case 'network':
      return 'ネットにつながらないみたい。';
    case 'timeout':
      return '考えこみすぎちゃったみたい。もう一回話しかけて。';
    default:
      return 'エラーが起きたみたい。ちょっと待ってからまた話しかけて。';
  }
}
