'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, net, shell, dialog, nativeImage, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { HistoryStore } = require('./history-store');
const { searchConversations, mergeMessages, parseDay } = require('./archive-store');
const { ReminderStore } = require('./reminder-store');
const { loadSettings, saveSettings, CALENDAR_MODES, CALENDAR_REFRESH_CHOICES, MASCOT_LOOKS, GEMINI_MODELS } = require('./settings');
const {
  TONE_AXES,
  TONE_NG_ITEMS,
  TONE_PRESET_COUNT,
  TONE_NAME_MAX_CHARS,
  PLAIN_TONE_PRESET_INDEX,
  clampAxisValue,
  toneSteps,
  normalizeToneName,
  tonePromptLines,
} = require('./tone');
const { soundChoices, SOUND_VOLUMES, AUDIO_EXTENSIONS, SoundError, importSoundFile, playable, volumeById } = require('./sounds');
const { createSseParser } = require('./sse');
const { toolGroups: chatToolGroups } = require('./chat-tools');
const { parseCompressCommand, compressImages, describeResult } = require('./image-compress');
const { GoogleAuth, GoogleAuthError } = require('./google-auth');
const {
  Calendar,
  CalendarError,
  DAY_MS,
  localDateKey,
  describeEvent,
  dueEventNotices,
  noticeKey,
  eventNoticeText,
  shouldBrief,
  briefingText,
} = require('./calendar');

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
// どのモデルを使うかは設定で選ぶ（settings.geminiModel、選択肢は settings.js の GEMINI_MODELS）
function currentModel() {
  return GEMINI_MODELS.find((model) => model.id === settings.geminiModel) ?? GEMINI_MODELS[0];
}

/** 話しかけるさきの URL。会話の返事は、できた分から少しずつ受け取る（alt=sse で Server-Sent Events の形になる） */
function geminiEndpoint(stream) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel().id}`;
  return stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
}

const GEMINI_TIMEOUT_MS = 30 * 1000;

// 吹き出しに添える出典の数の上限（小さい吹き出しなので少なめに）
const SOURCES_MAX = 3;

// 送る会話履歴の上限（今日の直近20往復まで）。昨日より前の会話は、システムプロンプトに短く入れる
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
function buildSystemPrompt(groups = { timer: true, history: true, calendar: calendarInChat() }) {
  const now = new Date().toLocaleString('ja-JP', { dateStyle: 'full', timeStyle: 'short' });
  return [
    'あなたはユーザーのデスクトップに住んでいるマスコットです。',
    '見た目はマスコットですが、中身は物知りな AI アシスタントです。',
    '漢字、言葉、料理、勉強、プログラミングなど、一般的な知識で答えられることは遠慮なく教えてください。',
    '「ぼくはマスコットだから」「食べたことがないから」などを理由に、知っていることを分からないと言ってはいけません。',
    '天気、ニュース、最近の出来事など新しい情報が必要なときは、Google 検索で調べてから答えてください。',
    '場所によって答えが変わる質問（天気など）で場所が分からないときは、短く聞き返してください。',
    `現在の日時は ${now}（ISO 8601 では ${localIsoString(Date.now())}）です。`,
    ...elapsedPromptLines(),
    'ユーザーの発言の先頭にある [9月16日 21:33] のような表記は、その発言をした日時です。',
    '「さっき」「朝に話した」などの時間の感覚に使ってください。返事には、この日時の表記を付けないでください。',
    '名前はまだありません。ユーザーが名前をくれたら喜んで受け取ってください。',
    // 口調のプリセットを使っているときは、ここで口調を決めない（決めると、下の【まめの口調設定】と
    // 引っぱり合って毒舌などが弱まる）。絵文字を使わないことだけは、どちらでも守らせる
    ...(usingTonePreset() ? ['絵文字は使いません。'] : ['口調は親しみやすく、少しだけ子どもっぽく、絵文字は使いません。']),
    // 渡した会話の中の、前の返事の口調に引っぱられて、口調を切り替えても変わらなかったので言い添える
    '下の会話にある、あなたの前の返事の口調はまねしないでください。口調を途中で変えることがあるので、いつも今ここに書いた口調で話してください。',
    ...toneChangedPromptLines(),
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
    ...pastDaysPromptLines(),
    ...memoryPromptLines(),
    // 口調の指示は一番最後に置く。中の「絶対的NGライン」が、ほかの指示に上書きされにくいようにするため
    // （1番目のプリセットのときは何も足さないので、今までと同じプロンプトになる）
    ...tonePromptLines(settings.tonePresets, settings.tonePresetIndex),
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

// 昨日から6日前までの詳しい会話。今日の会話は contents で送るので、ここには入れない
function pastDaysPromptLines() {
  const messages = store.pastDaysMessages();
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
/** 設定ウィンドウ。1つだけ開く（開いていないときは null） @type {BrowserWindow | null} */
let settingsWin = null;

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

// リマインダーの保存先。ほかの PC と一緒に知らせないよう、共有中でもこの PC の中に置く。
// テストのときは MASCOT_REMINDER_FILE で差し替えられる
const reminders = new ReminderStore(
  process.env.MASCOT_REMINDER_FILE
    ? path.resolve(process.env.MASCOT_REMINDER_FILE)
    : path.join(dataDir, 'reminders.json'),
);

// Google へのログインとカレンダー。ログイン情報はほかの PC と分けたいので、共有中でもこの PC の中に置く。
// テストのときは MASCOT_GOOGLE_DIR で置き場所を差し替えられる
const googleDir = process.env.MASCOT_GOOGLE_DIR ? path.resolve(process.env.MASCOT_GOOGLE_DIR) : dataDir;

// 「自分の音」に選ばれたファイルのコピーを置く所（お知らせ用と返事用で分ける）
const soundsDir = path.join(dataDir, 'sounds');
const googleAuth = new GoogleAuth({
  clientFile: path.join(googleDir, 'google-client.json'),
  tokenFile: path.join(googleDir, 'google-token.json'),
  fetch: (...args) => net.fetch(...args),
  openExternal: (url) => shell.openExternal(url),
  safeStorage,
});
const calendar = new Calendar({ auth: googleAuth, fetch: (...args) => net.fetch(...args) });
// 朝のまとめを最後に言った日。PC ごとに覚えておく
const calendarStateFile = path.join(googleDir, 'calendar-state.json');

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
      // タイマーやリマインダーの音は、クリックされていなくても鳴らせるようにする
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // 全画面アプリの上にも出す
  win.setAlwaysOnTop(true, 'screen-saver');
  // 透明な部分のクリックは後ろのアプリに渡す。マウスの動きだけは受け取り、
  // マスコットや吹き出しの上に来たらレンダラーが受け付けに切り替える
  win.setIgnoreMouseEvents(true, { forward: true });
  // ※ 一時的: 画面側の [drag] の記録も端末に出す
  win.webContents.on('console-message', (_event, _level, message) => {
    if (String(message).startsWith('[drag]')) console.log('[renderer]', message);
  });
  win.loadFile('index.html');
  // 起動する前や待ち時間中に時間が来ていたリマインダーは、読み込みが終わってから知らせる
  win.webContents.on('did-finish-load', deliverReminders);

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
    { type: 'separator' },
    // 自動起動や会話の共有などの設定は、設定ウィンドウにまとめている
    { label: '設定を開く…', click: openSettingsWindow },
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
  notifySettingsChanged();
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

/** ダイアログを載せる窓。設定ウィンドウから操作しているときは、そちらに載せる */
function dialogParent() {
  return settingsWin?.isFocused() ? settingsWin : win;
}

function showDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

/**
 * 共有フォルダを最初に開く場所。
 * 前に選んだ場所があればそこから、無ければ Google ドライブか OneDrive があればそこから
 */
function defaultShareParent() {
  const candidates = [
    settings.lastShareParent,
    'G:\\マイドライブ',
    'G:\\My Drive',
    process.env.OneDrive,
    app.getPath('documents'),
  ];
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
  const owner = dialogParent();
  const { canceled, filePaths } = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (canceled || !filePaths[0]) return;

  // 選んだフォルダの中に専用のフォルダを作る。専用のフォルダそのものを選んだときはそのまま使う
  const picked = filePaths[0];
  const folder = path.basename(picked) === SHARE_SUBFOLDER ? picked : path.join(picked, SHARE_SUBFOLDER);

  // 次に選ぶときも同じ場所から探せるよう覚えておく（共有をやめても消さない）
  const parent = path.basename(picked) === SHARE_SUBFOLDER ? path.dirname(picked) : picked;
  settings = { ...settings, lastShareParent: parent };
  saveSettings(settingsFile, settings);

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
  notifySettingsChanged();
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
// 設定ウィンドウ（settings-window.html）
// ---------------------------------------------------------------------------
// 自動起動や会話の共有などの設定を1つの窓にまとめる。項目を足すときは
// settings-window.html に行を足し、ここに読み書きの ipc を足す
function openSettingsWindow() {
  // もう開いていたら、新しく開かずに手前に出す
  if (settingsWin) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  // 項目が全部見える高さ。画面が小さいときは収まる高さにして、中でスクロールさせる
  const { workArea } = screen.getPrimaryDisplay();
  settingsWin = new BrowserWindow({
    width: 480,
    height: Math.min(780, workArea.height - 40),
    useContentSize: true,
    minWidth: 360,
    minHeight: 300,
    title: 'Desktop Mascot の設定',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile('settings-window.html');
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

/** 設定ウィンドウに見せる今の設定 */
function settingsState() {
  return {
    openAtLogin: settings.openAtLogin,
    historyFolder: settings.historyFolder,
    // 開発中（npm start）は Windows の自動起動の登録を変えないので、画面でそう伝える
    isPackaged: app.isPackaged,
    calendar: {
      mode: settings.calendarMode,
      modeChoices: CALENDAR_MODES.map(({ id, name }) => ({ id, name })),
      // 会話で予定を触るときだけ、毎回この分だけ入力が増える（実測値）
      chatTokens: 1040,
      hasClient: googleAuth.hasClient(),
      email: googleAuth.email,
      signingIn: Boolean(googleAuth.signingIn),
      refreshMinutes: settings.calendarRefreshMinutes,
      refreshChoices: [...CALENDAR_REFRESH_CHOICES],
    },
    look: { id: settings.mascotLook, choices: [...MASCOT_LOOKS] },
    model: { id: settings.geminiModel, choices: GEMINI_MODELS.map(({ id, name }) => ({ id, name })) },
    tone: {
      index: settings.tonePresetIndex,
      presets: settings.tonePresets.map((preset) => ({ name: preset.name, axes: { ...preset.axes } })),
      // つまみの説明と、止まる所（段）は tone.js が持っている。
      // Gemini に渡す文そのもの（levels の例文や caveat）は画面に出さないので渡さない
      axes: TONE_AXES.map((axis) => ({ id: axis.id, name: axis.name, note: axis.note, steps: toneSteps(axis) })),
      // このプリセットだけは、つまみを使わない（今までの口調のまま）
      plainIndex: PLAIN_TONE_PRESET_INDEX,
      nameMaxChars: TONE_NAME_MAX_CHARS,
      // つまみをどこまで上げてもしないこと（画面に並べて見せる）
      ngItems: [...TONE_NG_ITEMS],
    },
    sound: {
      choices: soundChoices(),
      volume: settings.soundVolume,
      volumeChoices: SOUND_VOLUMES.map(({ id, name }) => ({ id, name })),
      notify: { id: settings.notifySound, fileName: soundFileName('notify') },
      reply: { id: settings.replySound, fileName: soundFileName('reply') },
    },
  };
}

/** 設定が変わったら、トレイのメニューと設定ウィンドウの表示を合わせる */
function notifySettingsChanged() {
  refreshTrayMenu();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', settingsState());
}

// 設定ウィンドウからの呼び出しだけを受け付ける
function fromSettingsWindow(event) {
  return settingsWin && event.sender === settingsWin.webContents;
}

ipcMain.handle('settings:get', (event) => (fromSettingsWindow(event) ? settingsState() : null));

ipcMain.handle('settings:set-open-at-login', (event, enabled) => {
  if (fromSettingsWindow(event)) setOpenAtLogin(Boolean(enabled));
  return settingsState();
});

ipcMain.handle('settings:choose-share-folder', async (event) => {
  if (fromSettingsWindow(event)) await chooseShareFolder();
  return settingsState();
});

ipcMain.handle('settings:stop-sharing', async (event) => {
  if (fromSettingsWindow(event) && settings.historyFolder) await stopSharing();
  return settingsState();
});

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
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin, options);
  if (canceled || !filePaths[0]) return settingsState();
  try {
    googleAuth.importClientFile(filePaths[0]);
  } catch (err) {
    await showDialog({
      type: 'error',
      title: 'ファイルを使えませんでした',
      message: 'クライアント ID のファイルとして読めませんでした。',
      detail: `${err.message}\n\nGoogle Cloud の「クライアント」で「デスクトップ アプリ」を作り、「JSON をダウンロード」したファイルを選んでください。`,
    });
  }
  notifySettingsChanged();
  return settingsState();
});

// ブラウザで Google にログインする。ログインし直すと、アカウントの切り替えになる
ipcMain.handle('settings:calendar-sign-in', async (event) => {
  if (!fromSettingsWindow(event)) return settingsState();
  const signingIn = googleAuth.signIn();
  // 「ブラウザでログインしてください」の表示に切り替える
  notifySettingsChanged();
  try {
    await signingIn;
    // ログインしたら通知だけ始める。会話で予定を触るかは、トークンが増えるので自分で選んでもらう
    if (settings.calendarMode === 'off') setCalendarMode('notify');
  } catch (err) {
    if (!(err instanceof GoogleAuthError && err.kind === 'canceled')) {
      console.error('[google]', err.message);
      await showDialog({ type: 'error', title: 'ログインできませんでした', message: 'Google にログインできませんでした。', detail: err.message });
    }
  }
  notifySettingsChanged();
  return settingsState();
});

ipcMain.handle('settings:calendar-sign-out', async (event) => {
  if (!fromSettingsWindow(event)) return settingsState();
  await googleAuth.signOut();
  setCalendarMode('off');
  return settingsState();
});

ipcMain.handle('settings:set-calendar-mode', (event, mode) => {
  // ログインしていないときは「使わない」のまま
  if (fromSettingsWindow(event) && CALENDAR_MODES.some((choice) => choice.id === mode)) {
    setCalendarMode(googleAuth.account ? mode : 'off');
  }
  return settingsState();
});

ipcMain.handle('settings:set-calendar-refresh', (event, minutes) => {
  // 画面にある選択肢以外は受け取らない
  if (fromSettingsWindow(event) && CALENDAR_REFRESH_CHOICES.includes(Number(minutes))) {
    settings = { ...settings, calendarRefreshMinutes: Number(minutes) };
    saveSettings(settingsFile, settings);
    // 次の読み直しを待たず、新しい間隔ですぐ読み直す
    resetCalendarCache();
    notifySettingsChanged();
  }
  return settingsState();
});

// ---------------------------------------------------------------------------
// 音（お知らせの音と、返事が出たときの音）
// ---------------------------------------------------------------------------
// 内蔵の音はレンダラーがその場で作る。「自分の音」は、選ばれたファイルをアプリの中に
// コピーしておき、その中身をレンダラーへ渡して鳴らす（sounds.js / sound-player.js）
const SOUND_SLOTS = { notify: 'お知らせの音', reply: '返事の音' };

/** その音のコピーがあれば、その名前（設定の画面に出す） */
function soundFileName(slot) {
  const file = settings[`${slot}SoundFile`];
  return file ? path.basename(file) : '';
}

/** レンダラーに渡す、今鳴らすもの */
function soundState() {
  return {
    notify: playable(settings.notifySound, settings.notifySoundFile),
    reply: playable(settings.replySound, settings.replySoundFile),
    volume: volumeById(settings.soundVolume),
  };
}

function saveSoundSettings(next) {
  settings = { ...settings, ...next };
  saveSettings(settingsFile, settings);
  // 次に鳴らすときから新しい音になるよう、豆の窓にも伝える
  if (win && !win.isDestroyed()) win.webContents.send('sound:changed');
  notifySettingsChanged();
}

// 豆の窓と設定の窓（試し聞き）の両方が使う
ipcMain.handle('sound:get', () => soundState());

ipcMain.handle('settings:set-sound', (event, slot, id) => {
  if (fromSettingsWindow(event) && SOUND_SLOTS[slot] && soundChoices().some((choice) => choice.id === id)) {
    saveSoundSettings({ [`${slot}Sound`]: id });
  }
  return settingsState();
});

// 豆の見た目。絵は index.html に4つとも置いてあるので、名前を渡すだけでよい
ipcMain.handle('look:get', () => settings.mascotLook);

ipcMain.handle('settings:set-mascot-look', (event, id) => {
  if (fromSettingsWindow(event) && MASCOT_LOOKS.some((look) => look.id === id)) {
    settings = { ...settings, mascotLook: id };
    saveSettings(settingsFile, settings);
    if (win && !win.isDestroyed()) win.webContents.send('look:changed', id);
    notifySettingsChanged();
  }
  return settingsState();
});

// 返事を作るモデル。次に話しかけるときから新しいモデルになる
ipcMain.handle('settings:set-model', (event, id) => {
  if (fromSettingsWindow(event) && GEMINI_MODELS.some((model) => model.id === id)) {
    settings = { ...settings, geminiModel: id };
    saveSettings(settingsFile, settings);
    notifySettingsChanged();
  }
  return settingsState();
});

ipcMain.handle('settings:set-sound-volume', (event, id) => {
  if (fromSettingsWindow(event) && SOUND_VOLUMES.some((volume) => volume.id === id)) saveSoundSettings({ soundVolume: id });
  return settingsState();
});

// 「自分の音」に使うファイルを選ぶ
ipcMain.handle('settings:choose-sound-file', async (event, slot) => {
  if (!fromSettingsWindow(event) || !SOUND_SLOTS[slot]) return settingsState();
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin, {
    title: `${SOUND_SLOTS[slot]}に使うファイルを選ぶ`,
    buttonLabel: 'この音を使う',
    defaultPath: app.getPath('music'),
    filters: [{ name: '音のファイル', extensions: AUDIO_EXTENSIONS.map((ext) => ext.slice(1)) }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return settingsState();
  try {
    // 選ばれたらそのまま「自分の音」に切り替える
    saveSoundSettings({ [`${slot}SoundFile`]: importSoundFile(path.join(soundsDir, slot), filePaths[0]), [`${slot}Sound`]: 'custom' });
  } catch (err) {
    if (!(err instanceof SoundError)) throw err;
    await showDialog({ type: 'error', title: '音を使えませんでした', message: 'この音のファイルは使えませんでした。', detail: err.message });
  }
  return settingsState();
});

// ---------------------------------------------------------------------------
// 口調（6つのつまみと、5つのプリセット）
// ---------------------------------------------------------------------------
// 変えた口調は、次の返事から効く（システムプロンプトは話しかけるたびに作り直すため）。
// 1番目のプリセットは今までの口調そのままなので、つまみは保存するだけで返事には使わない

/** 6つのつまみを使うプリセットを選んでいるか（1番目は今までの口調そのまま） */
function usingTonePreset() {
  return settings.tonePresetIndex !== PLAIN_TONE_PRESET_INDEX;
}

// 口調を変える前の会話を、メモとして渡すときの上限（文字数）
const BEFORE_TONE_CHANGE_MAX_CHARS = 2000;
// そのメモの中の、まめの返事1つあたりの上限。言い回しまで渡すと口調が移るので、中身が分かる程度に切る
const BEFORE_TONE_CHANGE_REPLY_CHARS = 60;

/** 今日、口調を変えた時刻。今日変えていなければ 0 */
function toneChangedToday() {
  const changedAt = settings.toneChangedAt;
  return changedAt && changedAt >= new Date().setHours(0, 0, 0, 0) ? changedAt : 0;
}

/**
 * 今日の会話の途中で口調を変えたときの、変える前の会話のメモ。
 * 変える前の返事を会話として渡すと、何往復しても前の口調に引っぱられたので、
 * 会話（contents）からは外し、中身だけをここで伝える（buildContents）
 */
function toneChangedPromptLines() {
  const changedAt = toneChangedToday();
  if (!changedAt) return [];
  const before = store.messages
    .filter((message) => message.at >= new Date().setHours(0, 0, 0, 0) && message.at < changedAt)
    .slice(-HISTORY_MAX_TURNS * 2)
    .map((message) =>
      message.role === 'user'
        ? `[${formatMessageTime(message.at)}] ユーザー: ${message.content}`
        : `あなた: ${clip(message.content.replace(/\s+/g, ' '), BEFORE_TONE_CHANGE_REPLY_CHARS)}`,
    );
  if (before.length === 0) return [];
  return [
    '',
    `[${formatMessageTime(changedAt)}] に口調を変えました。それより前の今日の会話は、下のメモだけです（あなたの返事は途中で切ってあります）。`,
    '話の中身は覚えておいてください。ただし前の口調・言い回しは、まねしないでください。',
    '---',
    clip(before.join('\n'), BEFORE_TONE_CHANGE_MAX_CHARS),
    '---',
  ];
}

function saveTone(next) {
  settings = { ...settings, ...next };
  saveSettings(settingsFile, settings);
  notifySettingsChanged();
}

/** 画面から来た番号が、5つのプリセットのどれかであること */
function isTonePresetIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < TONE_PRESET_COUNT;
}

/** そのプリセットだけを差し替えた、新しい一覧 */
function tonePresetsWith(index, preset) {
  return settings.tonePresets.map((current, i) => (i === index ? preset : current));
}

// 使うプリセットを切り替える（次に起動したときも、ここで選んだものに戻る）
ipcMain.handle('settings:select-tone-preset', (event, index) => {
  const at = Number(index);
  if (fromSettingsWindow(event) && isTonePresetIndex(at) && at !== settings.tonePresetIndex) {
    saveTone({ tonePresetIndex: at, toneChangedAt: Date.now() });
  }
  return settingsState();
});

// つまみを1つ動かす。範囲の外の値は、その軸で選べる値に丸める
ipcMain.handle('settings:set-tone-axis', (event, index, axisId, value) => {
  const at = Number(index);
  const axis = TONE_AXES.find((item) => item.id === axisId);
  if (fromSettingsWindow(event) && isTonePresetIndex(at) && axis) {
    const preset = settings.tonePresets[at];
    saveTone({
      tonePresets: tonePresetsWith(at, { ...preset, axes: { ...preset.axes, [axis.id]: clampAxisValue(axis, value) } }),
      // 今使っているプリセットのつまみを動かしたときも、口調が変わったことになる
      ...(at === settings.tonePresetIndex && usingTonePreset() && { toneChangedAt: Date.now() }),
    });
  }
  return settingsState();
});

// プリセットの名前を付け替える。空にしたときは、もとの名前（「プリセット2」など）に戻す
ipcMain.handle('settings:rename-tone-preset', (event, index, name) => {
  const at = Number(index);
  if (fromSettingsWindow(event) && isTonePresetIndex(at)) {
    saveTone({ tonePresets: tonePresetsWith(at, { ...settings.tonePresets[at], name: normalizeToneName(name, at) }) });
  }
  return settingsState();
});

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
      `AI のモデル: ${currentModel().id}`,
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
    detail: 'マスコットは今までの話を覚えていない状態に戻ります。話した中身は保管庫に残るので、「前にこんな話したっけ？」と聞けば探せます。',
  };
  // 自動起動の待ち時間中はまだウィンドウが無いので、トレイから押されたら単独で出す
  const { response } = await showDialog(options);
  if (response !== 0) return;
  try {
    await store.clear();
  } catch (err) {
    await showDialog({
      type: 'error',
      title: '会話をリセットできませんでした',
      message: '会話を保管庫に残せなかったので、リセットしませんでした。',
      detail: `${err.message}\n\n共有中なら、ドライブのアプリが動いているか確かめてから、もう一度試してください。`,
    });
  }
}

app.whenReady().then(async () => {
  applyOpenAtLogin();
  store.load();
  watchSharedHistory();
  reminders.load();
  googleAuth.load();
  setInterval(checkReminders, REMINDER_CHECK_INTERVAL_MS);
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

// 自動起動の待ち時間中（マスコットの窓がまだ無い）に設定ウィンドウを閉じても、終了しない
app.on('window-all-closed', () => {
  if (win) app.quit();
});

// ---------------------------------------------------------------------------
// ドラッグ移動
// ---------------------------------------------------------------------------
// カーソルの実座標で追従させる（DPI スケーリングでズレないようにするため）。
// 掴んでいる間はこちらで一定の間隔でカーソルを見に行く。レンダラーの mousemove に任せると、
// ウィンドウがカーソルについて動くぶん画面の中では止まって見え、mousemove が途切れて
// 追従が遅れる（掴んでいるうちに豆がカーソルから離れていく）
const DRAG_FOLLOW_MS = 16;
let dragOffset = null;
let dragTimer = null;

let dbgTicks = 0;
let dbgMoves = 0;

ipcMain.on('drag:start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
  dbgTicks = 0;
  dbgMoves = 0;
  console.log('[drag] start offset=', dragOffset, 'win=', wx, wy, 'cursor=', cursor.x, cursor.y);
});

// 「ここから本当に動かす」の合図。あとはこちらで追い続ける
ipcMain.on('drag:move', () => {
  if (!win || !dragOffset || dragTimer) return;
  console.log('[drag] move（追従を始める）');
  followCursor();
  dragTimer = setInterval(followCursor, DRAG_FOLLOW_MS);
});

function followCursor() {
  if (!win || win.isDestroyed() || !dragOffset) {
    stopFollowingCursor();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const want = { x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y };
  win.setPosition(want.x, want.y);
  dbgTicks++;
  // 10 回に1回だけ、狙った位置と実際の位置を出す
  if (dbgTicks % 10 === 0) {
    const [ax, ay] = win.getPosition();
    console.log('[drag] tick', dbgTicks, 'cursor=', cursor.x, cursor.y, 'want=', want.x, want.y, 'actual=', ax, ay);
  }
}

function stopFollowingCursor() {
  clearInterval(dragTimer);
  dragTimer = null;
}

ipcMain.on('drag:end', () => {
  console.log('[drag] end ticks=', dbgTicks, 'moves=', dbgMoves);
  dragOffset = null;
  stopFollowingCursor();
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

// 画像をドロップされたあと、すぐ話しかけられるよう入力欄に文字を打てる状態にする
ipcMain.on('window:focus', () => {
  win?.focus();
});

// ---------------------------------------------------------------------------
// ドロップされた画像を小さくする（中身は image-compress.js）
// ---------------------------------------------------------------------------
// 置き場所はいつもデスクトップ。テストのときは MASCOT_OUTPUT_DIR で差し替えられる
function compressOutputDir() {
  return process.env.MASCOT_OUTPUT_DIR ? path.resolve(process.env.MASCOT_OUTPUT_DIR) : app.getPath('desktop');
}

ipcMain.handle('image:compress', async (event, paths, text) => {
  const command = parseCompressCommand(text);
  if (!command || command.kind === 'cancel') return { status: command ? 'cancel' : 'unknown' };

  const files = (Array.isArray(paths) ? paths : []).filter((file) => typeof file === 'string' && file);
  const sender = event.sender;
  const result = await compressImages({
    paths: files,
    command,
    outDir: compressOutputDir(),
    nativeImage,
    onProgress: (index, total) => {
      if (sender.isDestroyed()) return;
      sender.send('image:progress', total > 1 ? `${total}枚のうち${index}枚目を処理中…` : '画像を処理中…');
    },
  });
  return { status: 'done', text: describeResult(result, command) };
});

// ---------------------------------------------------------------------------
// タイマーとリマインダー
// ---------------------------------------------------------------------------
// 「3分たったら教えて」「明日9時に歯医者って教えて」と話しかけると、Gemini が道具
// （set_timer / add_reminder）を呼んで登録する。時間が来たら、吹き出しで知らせて豆がはねる。
// 知らせる文は登録のときに Gemini が決めておくので、知らせるときは Gemini を呼ばない
const REMINDER_CHECK_INTERVAL_MS = 1000;

// この時間より前の発言は、続きの話とは見なさない
const FOLLOW_UP_MS = 10 * 60 * 1000;

/** この発言で渡す道具の組み合わせ（中身は chat-tools.js） */
function toolGroups(userText) {
  const previous = store.messages.findLast((message) => message.role === 'user');
  return chatToolGroups(userText, {
    // 登録中のタイマーがあるときは、取り消しや問い合わせに答えられるよう必ず渡す
    hasReminders: reminders.items.length > 0,
    calendarInChat: calendarInChat(),
    previousText: previous && Date.now() - previous.at < FOLLOW_UP_MS ? previous.content : '',
  });
}

// 会話で Gemini に渡す道具（タイマーとリマインダー、昔の会話探し）
const CHAT_FUNCTIONS = {
  declarations: [
    {
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
    },
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
  ],
  call: (functionCall) => (functionCall.name === 'search_history' ? searchHistory(functionCall.args) : callReminderFunction(functionCall)),
};

/** 今回の会話で渡す道具。使いそうにない道具は、説明ごと渡さない */
function chatFunctions(groups) {
  const declarations = [
    ...(groups.history ? CHAT_FUNCTIONS.declarations.filter((d) => d.name === 'search_history') : []),
    ...(groups.timer ? CHAT_FUNCTIONS.declarations.filter((d) => d.name !== 'search_history') : []),
    ...(groups.calendar ? CALENDAR_FUNCTION_DECLARATIONS : []),
  ];
  if (declarations.length === 0) return null;
  return {
    declarations,
    call: (functionCall) =>
      CALENDAR_FUNCTION_NAMES.has(functionCall.name) ? callCalendarFunction(functionCall) : CHAT_FUNCTIONS.call(functionCall),
  };
}

/** 保管庫と直近の履歴から、昔の会話を探す。見つかった発言だけを Gemini に返す */
async function searchHistory({ keywords, from, to } = {}) {
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

/** Gemini が呼んだ道具を実行し、結果を Gemini に返す形にする */
function callReminderFunction({ name, args = {} }) {
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
  const list = reminders.items.map(
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

/** 「2026-09-17T20:13:00+09:00」のような、この PC の時刻とタイムゾーンでの ISO 8601 */
function localIsoString(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

// 知らせる文。自動起動の待ち時間中などで窓がまだ無いときは、出せるようになるまでためておく
let dueNotices = [];

function checkReminders() {
  for (const item of reminders.takeDue()) {
    const message = item.message || '時間だよ。';
    // PC を切っていた・スリープしていたなどで遅れたときは、いつの分かを添える
    dueNotices.push(item.late ? `（${formatMessageTime(item.at)} の分。時間が過ぎちゃってた）\n${message}` : message);
  }
  checkCalendar();
  deliverReminders();
}

function deliverReminders() {
  if (dueNotices.length === 0 || !win || win.webContents.isLoading()) return;
  // 隠しているときも気づけるよう、表に出してから知らせる
  if (!win.isVisible()) showMascot();
  win.webContents.send('reminder:due', dueNotices.join('\n\n'));
  dueNotices = [];
}

// ---------------------------------------------------------------------------
// Google カレンダー連携（中身は calendar.js、ログインは google-auth.js）
// ---------------------------------------------------------------------------
// ・会話で「明日の予定は？」「金曜15時に歯医者を入れて」→ Gemini がカレンダーの道具を呼ぶ
// ・予定の10分前に、リマインダーと同じ吹き出しと音で知らせる
// ・その日はじめて（朝5時より後に）豆を起動したとき、今日の予定をまとめて言う。昼からの起動なら、これからの予定だけ
//   （起動したままで日が変わっても言わない。起動したときにカレンダー連携が OFF なら、その日は言わない）
const EVENT_NOTICE_LEAD_MS = 10 * 60 * 1000;
// 予定を読み直す間隔は設定で変えられる（settings.calendarRefreshMinutes）。
// 直前に足された予定は10分前のお知らせに間に合わないこともあるが、タイマーほどの正確さは要らないので長めでよい
function calendarRefreshMs() {
  return settings.calendarRefreshMinutes * 60 * 1000;
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

/** カレンダー連携を使うか（設定で ON、かつ Google にログインしている） */
/** 予定の通知（10分前・朝のまとめ）を出すか。Gemini は通さないので、トークンはかからない */
function calendarNotifying() {
  return settings.calendarMode !== 'off' && Boolean(googleAuth.account);
}

/**
 * 会話で予定を読み書きできるようにするか。
 * こちらを ON にすると、予定の道具の説明を毎回 Gemini に送ることになる（実測 約1,040トークン／回）
 */
function calendarInChat() {
  return settings.calendarMode === 'full' && Boolean(googleAuth.account);
}

function setCalendarMode(mode) {
  settings = { ...settings, calendarMode: mode };
  saveSettings(settingsFile, settings);
  resetCalendarCache();
  notifySettingsChanged();
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
  if (!googleAuth.hasClient()) return CALENDAR_STATUS.noClient;
  // 使う設定のままログインだけ無い＝ログインが切れた
  if (!googleAuth.account) return settings.calendarMode === 'off' ? CALENDAR_STATUS.notSignedIn : CALENDAR_STATUS.signedOut;
  if (settings.calendarMode === 'off') return CALENDAR_STATUS.off;
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
    `ほかの所（スマホなど）で変えた予定に気づくまで、最大${settings.calendarRefreshMinutes}分かかります。`,
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
      notifySettingsChanged();
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
    return JSON.parse(fs.readFileSync(calendarStateFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCalendarState(state) {
  try {
    fs.mkdirSync(path.dirname(calendarStateFile), { recursive: true });
    fs.writeFileSync(calendarStateFile, JSON.stringify(state, null, 2), 'utf8');
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
    dueNotices.push(eventNoticeText(event, now));
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
        notifySettingsChanged();
        if (!signedOutNoticeShown) {
          signedOutNoticeShown = true;
          dueNotices.push(notice);
          deliverReminders();
        }
      }
    })
    .finally(() => {
      calendarChecking = false;
    });
}

async function refreshCalendar(now) {
  upcomingEvents = await calendar.listEvents(now, now + DAY_MS);
  signedOutNoticeShown = false;

  if (!briefingPending) return;
  const state = loadCalendarState();
  // 起動したのと同じ日のうちに予定を読めたときだけ言う（前の晩に起動して、つながらないまま朝になったときは言わない）
  const sameDay = localDateKey(now) === localDateKey(launchedAt);
  if (sameDay && shouldBrief(state.lastBriefingDate, launchedAt, BRIEFING_HOUR_START)) {
    dueNotices.push(briefingText(await calendar.listToday(now), now));
    saveCalendarState({ ...state, lastBriefingDate: localDateKey(now) });
    deliverReminders();
  }
  briefingPending = false;
}

// ---------------------------------------------------------------------------
// Gemini との会話
// ---------------------------------------------------------------------------
// 返事を待っている間に次の発言が来ても、1つずつ順番に処理する
let chatQueue = Promise.resolve();

ipcMain.handle('chat:send', (event, userText) => {
  // 届いた分の返事を、その都度レンダラーへ送って吹き出しに流す
  const sender = event.sender;
  const onDelta = (delta) => {
    if (!sender.isDestroyed()) sender.send('chat:delta', delta);
  };
  const reply = chatQueue.then(() => chat(clip(String(userText), USER_TEXT_MAX_CHARS), onDelta));
  chatQueue = reply.catch(() => {});
  return reply;
});

// 履歴の表示用。古い会話の要約と、直近7日の詳しい会話を渡す
ipcMain.handle('chat:history', () => ({
  summaries: store.summaries.map(({ date, summary }) => ({ date, summary })),
  messages: store.messages.map(({ role, content, at }) => ({ role, content, at })),
}));

async function chat(userText, onDelta) {
  try {
    const groups = toolGroups(userText);
    const { text, sources, searchSuggestions } = await askGemini(buildContents(store.messages, userText), {
      onDelta,
      systemPrompt: buildSystemPrompt(groups),
      functions: chatFunctions(groups),
    });
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
  // 今日口調を変えていたら、それより前の会話は送らない（中身はシステムプロンプトのメモで渡す）
  const since = Math.max(new Date().setHours(0, 0, 0, 0), toneChangedToday());
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

// ---------------------------------------------------------------------------
// 使ったトークンを見る（課金の内訳を確かめるとき用）
// ---------------------------------------------------------------------------
// ふだんは何も出さない。確かめたいときは MASCOT_DEBUG_TOKENS=1 を付けて起動する
const DEBUG_TOKENS = process.env.MASCOT_DEBUG_TOKENS === '1';

// その日の合計を残しておくファイル。立ち上げ直しても数え続けられるようにする
// （請求の画面に内訳が出ないので、使った量はこちらで数えるしかない）
const tokenLogFile = path.join(dataDir, 'token-log.json');

/** 今日の合計を読む。日が変わっていたら 0 から数え直す */
function loadTokenLog() {
  const today = localDateKey(Date.now());
  try {
    const saved = JSON.parse(fs.readFileSync(tokenLogFile, 'utf8'));
    if (saved.date === today) return saved;
  } catch {
    // 無ければ今日のぶんを新しく作る
  }
  return { date: today, requests: 0, prompt: 0, output: 0, thoughts: 0, searches: 0 };
}

/** 1回ぶんの内訳と、今日の合計を出す。検索（グラウンディング）が走ったかも数える */
function logTokens(chunks) {
  const usage = chunks.findLast((chunk) => chunk?.usageMetadata)?.usageMetadata;
  if (!usage) return;
  const prompt = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  // 「考えた分」は画面には出ないが、出力として課金される
  const thoughts = usage.thoughtsTokenCount ?? 0;
  // Google 検索が走った回は、トークンとは別に1回いくらで課金されることがある
  const searched = chunks.some((chunk) => chunk?.candidates?.[0]?.groundingMetadata);

  const total = loadTokenLog();
  total.requests += 1;
  total.prompt += prompt;
  total.output += output;
  total.thoughts += thoughts;
  total.searches += searched ? 1 : 0;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenLogFile, JSON.stringify(total, null, 2), 'utf8');
  } catch (err) {
    console.warn('[tokens] 記録できませんでした:', err.message);
  }

  console.log(
    `[tokens] ${currentModel().id} 入力 ${prompt} / 出力 ${output} / 考えた分 ${thoughts}${searched ? ' / 検索あり' : ''}`,
    `｜今日 ${total.requests}回 入力 ${total.prompt} / 出力 ${total.output} / 考えた分 ${total.thoughts} / 検索 ${total.searches}回`,
  );
}

/** 入力の何が長いのかを、文字数で見る（トークンではないが、削る所を探すには十分） */
function logPromptParts(systemPrompt, contents) {
  // 要約のときは口調を入れないので、入っている回だけ数える
  const tone = tonePromptLines(settings.tonePresets, settings.tonePresetIndex).join('\n');
  const toneChars = systemPrompt.includes('【まめの口調設定】') ? tone.length : 0;
  const talkChars = JSON.stringify(contents).length;
  console.log(
    `[tokens] 入力の中身（文字数）: システム ${systemPrompt.length}`,
    `（うち口調 ${toneChars}）／ 送った会話 ${talkChars}`,
  );
}

// タイマーの登録や昔の会話探しで、道具を使う → 結果を返す、を繰り返す回数の上限
// （探して見つからず、言葉を変えてもう一度探すこともあるので少し余裕を持たせる）
const MAX_TOOL_ROUNDS = 4;

/**
 * Gemini API を呼んで、返事の本文と出典を返す。
 * 会話では Google 検索を道具として渡しておき、検索するかどうかはモデルが決める。
 * 要約のときは systemPrompt を差し替え、tools を空にして検索させない。
 * onDelta を渡すと、返事をできた分から少しずつ受け取り、届くたびに本文の続きを渡す。
 * functions を渡すと、モデルがそれを呼んだときに実行して結果を返し、続きの返事をもらう。
 * @param {{ declarations: object[], call: (functionCall: { name: string, args?: object }) => object } | null} [options.functions]
 * @returns {Promise<{ text: string, sources: { title: string, uri: string }[] }>}
 */
async function askGemini(
  contents,
  { systemPrompt = buildSystemPrompt(), tools = [{ google_search: {} }], onDelta = null, functions = null } = {},
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError('no-key', 'GEMINI_API_KEY が設定されていません');

  const allTools = functions ? [...tools, { functionDeclarations: functions.declarations }] : tools;
  if (DEBUG_TOKENS) logPromptParts(systemPrompt, contents);
  const texts = [];
  let finishReason;
  let groundingMetadata;

  for (let round = 1; ; round++) {
    const chunks = await requestGemini(apiKey, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      ...(allTools.length > 0 && { tools: allTools }),
      // Google 検索と自作の道具を一緒に渡すときは、この指定が要る
      ...(functions && tools.length > 0 && { toolConfig: { includeServerSideToolInvocations: true } }),
      // 内部で考えた分も出力として課金されるので、雑談では考えさせない。
      // 考えないモデル（lite）にこの指定を送ると 400 になるので、考えるモデルにだけ付ける
      ...(currentModel().thinking && { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
    }, onDelta);

    if (DEBUG_TOKENS) logTokens(chunks);

    // 少しずつ受け取ったときは、本文をつなげ、終わり方と検索の情報は最後に来たものを使う
    const blockReason = chunks.find((chunk) => chunk?.promptFeedback?.blockReason)?.promptFeedback.blockReason;
    if (blockReason) {
      throw new GeminiError('blocked', `blockReason=${blockReason}`);
    }

    const candidates = chunks.map((chunk) => chunk?.candidates?.[0]).filter(Boolean);
    texts.push(candidates.map(candidateText).join(''));
    finishReason = candidates.findLast((candidate) => candidate.finishReason)?.finishReason ?? finishReason;
    groundingMetadata = candidates.findLast((candidate) => candidate.groundingMetadata)?.groundingMetadata ?? groundingMetadata;

    const parts = candidates.flatMap((candidate) => candidate.content?.parts ?? []);
    const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
    if (!functions || calls.length === 0 || round >= MAX_TOOL_ROUNDS) break;

    // モデルの発言（thoughtSignature も含めてそのまま）と道具の結果を足して、続きをもらう
    contents = [
      ...contents,
      { role: 'model', parts },
      {
        role: 'user',
        parts: await Promise.all(
          calls.map(async (call) => ({
            functionResponse: { name: call.name, ...(call.id && { id: call.id }), response: await functions.call(call) },
          })),
        ),
      },
    ];
  }

  const text = texts.join('').trim();
  if (!text) {
    throw new GeminiError(
      finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' ? 'blocked' : 'failed',
      `返事が空でした finishReason=${finishReason}`,
    );
  }

  return {
    text,
    sources: extractSources(groundingMetadata),
    searchSuggestions: extractSearchSuggestions(groundingMetadata),
  };
}

/**
 * Gemini API に1回リクエストして、届いた塊（JSON）を順に並べて返す。
 * 少しずつ受け取るときは、本文が届くたびに onDelta へ渡す。
 */
async function requestGemini(apiKey, body, onDelta) {
  let res;
  let chunks;
  try {
    // Chromium の通信機能を使う（OS の証明書ストアを使うので、セキュリティソフトの割り込みにも強い）
    // 時間切れは、返事を最後まで受け取り終わるまでを数える
    res = await net.fetch(geminiEndpoint(Boolean(onDelta)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });

    // 失敗のときは、少しずつ受け取る形でもふつうの JSON が1つ返ってくる
    if (!res.ok || !onDelta) {
      chunks = [await res.json().catch(() => null)];
    } else {
      chunks = await readStream(res, onDelta);
    }
  } catch (err) {
    throw err.name === 'TimeoutError'
      ? new GeminiError('timeout', `${GEMINI_TIMEOUT_MS}ms 以内に応答がありませんでした`)
      : new GeminiError('network', err.message);
  }

  if (!res.ok) {
    const error = chunks[0]?.error;
    const detail = `status=${res.status} ${error?.status ?? ''} ${error?.message ?? ''}`;
    const reason = error?.details?.find((d) => d.reason)?.reason;
    if (reason === 'API_KEY_INVALID' || res.status === 401 || res.status === 403) {
      throw new GeminiError('bad-key', detail);
    }
    if (res.status === 429) throw new GeminiError('rate-limit', detail);
    throw new GeminiError('failed', detail);
  }
  return chunks;
}

/** 返事の本文（考えている途中の文は除く） */
function candidateText(candidate) {
  return (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('');
}

/** 少しずつ届く返事を最後まで読み、届いた塊（JSON）を順に並べて返す。本文は届くたびに onDelta へ */
async function readStream(res, onDelta) {
  const chunks = [];
  const parser = createSseParser((data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // 読めない塊は飛ばす
    }
    chunks.push(chunk);
    const delta = candidateText(chunk?.candidates?.[0]);
    if (delta) onDelta(delta);
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
  return chunks;
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
