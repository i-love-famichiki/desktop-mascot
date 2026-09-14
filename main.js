'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, Tray } = require('electron');
const path = require('path');
const { ClaudeSession, ClaudeCliError } = require('./claude-session');

// Claude Code CLI（`claude -p`）を常駐させて返事をもらう。
// PATH 上の claude が使えない環境では MASCOT_CLAUDE_COMMAND にフルパスを入れる。
const CLAUDE_COMMAND = process.env.MASCOT_CLAUDE_COMMAND || 'claude';

// 雑談用なので軽くて安いモデルを使う。賢さが欲しくなったら 'opus' などに。
const MODEL = 'haiku';

// CLI は起動だけで数十秒かかることがあるので、タイムアウトは長めに取る
const CLAUDE_TIMEOUT_MS = 120 * 1000;

// 同じ claude プロセスでこの回数やり取りしたら作り直す（文脈が伸び続けないように）
const SESSION_MAX_TURNS = 20;

// 作り直した claude に添える会話履歴の上限（長くなりすぎないように文字数でも絞る）
const PROMPT_HISTORY_MAX_TURNS = 20;
const PROMPT_HISTORY_MAX_CHARS = 4000;
const PROMPT_HISTORY_MESSAGE_MAX_CHARS = 400;
// 1回の発言も長すぎると文脈を圧迫するので上限を設けておく
const USER_TEXT_MAX_CHARS = 2000;

const SYSTEM_PROMPT = [
  'あなたはユーザーのデスクトップに住んでいるマスコットです。',
  '名前はまだありません。ユーザーが名前をくれたら喜んで受け取ってください。',
  '口調は親しみやすく、少しだけ子どもっぽく、絵文字は使いません。',
  '返事は必ず日本語で、2文以内の短さに収めてください。画面の小さな吹き出しに表示されます。',
  '分からないことは知ったかぶりせず、素直に分からないと言ってください。',
].join('\n');

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;

// 会話履歴はメインプロセスだけが持つ（メモリ上のみ）
// 要素は { role: 'user' | 'assistant', content: string, at: number }
let history = [];

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: 320,
    height: 420,
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
  win.loadFile('index.html');
}

function createTray() {
  // アイコンは後で差し替える。空でもトレイには載る。
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Desktop Mascot');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '会話をリセット',
        click: () => {
          history = [];
          // claude 側も会話を覚えているので、まっさらなプロセスに入れ替える
          restartSession();
        },
      },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(() => {
  createWindow();
  try {
    createTray();
  } catch (err) {
    // アイコン未配置でも起動は止めない
    console.warn('トレイの作成をスキップしました:', err.message);
  }

  // 最初に話しかけられるまでに起動を済ませておく
  restartSession();
  scheduleDailyRestart();
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  if (session) session.stop();
});

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

ipcMain.on('app:quit', () => app.quit());

// ---------------------------------------------------------------------------
// Claude との会話
// ---------------------------------------------------------------------------
/** @type {ClaudeSession | null} */
let session = null;

function restartSession() {
  if (session) session.stop();
  session = new ClaudeSession({
    command: CLAUDE_COMMAND,
    args: [
      '--model', MODEL,
      // Claude Code 標準のシステムプロンプトではなく、マスコットの人格で喋らせる
      '--system-prompt', SYSTEM_PROMPT,
      // 雑談専用なので、ファイル操作やコマンド実行などのツールは一切渡さない
      '--tools', '',
      // マスコットとの会話を Claude Code のセッション履歴に残さない
      '--no-session-persistence',
    ],
    // プロジェクトの CLAUDE.md などを拾わないよう、アプリ専用のフォルダで動かす
    cwd: app.getPath('userData'),
    env: claudeEnv(),
    timeoutMs: CLAUDE_TIMEOUT_MS,
  });
  session.start();
}

function claudeEnv() {
  // 親が Claude Code のターミナルから起動された場合の変数を子に引き継がない。
  // API キーも渡さず、Claude Code にログインしているアカウントで動かす。
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name.startsWith('CLAUDE_CODE_')) {
      delete env[name];
    }
  }
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function startOfToday() {
  return new Date().setHours(0, 0, 0, 0);
}

// 日付が変わったら、昨日の会話を覚えている claude を作り直しておく
function scheduleDailyRestart() {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    if (session && session.turns > 0 && !session.busy) restartSession();
    scheduleDailyRestart();
  }, nextMidnight.getTime() - Date.now());
}

// 返事を待っている間に次の発言が来ても、1つずつ順番に処理する
let chatQueue = Promise.resolve();

ipcMain.handle('chat:send', (_event, userText) => {
  const reply = chatQueue.then(() => chat(clip(String(userText), USER_TEXT_MAX_CHARS)));
  chatQueue = reply.catch(() => {});
  return reply;
});

async function chat(userText) {
  try {
    const text = await askSession(userText);
    history.push(
      { role: 'user', content: userText, at: Date.now() },
      { role: 'assistant', content: text, at: Date.now() },
    );

    // 履歴が伸びすぎないよう、古い方から捨てる（直近20往復ぶん）
    if (history.length > 40) history = history.slice(-40);

    // 上限に達したら、次の発言までに裏で作り直しておく
    if (session.turns >= SESSION_MAX_TURNS) restartSession();

    return { ok: true, text };
  } catch (err) {
    // 固まった・落ちた claude は捨てて、次の発言に備えて作り直しておく
    // （コマンドが無い場合は作り直しても同じなので、次の発言時に改めて試す）
    if (err.kind !== 'not-found' && !session.alive) restartSession();
    return { ok: false, text: describeError(err) };
  }
}

async function askSession(userText) {
  for (let attempt = 1; ; attempt++) {
    const stale =
      !session || !session.alive || (session.turns > 0 && session.startedAt < startOfToday());
    if (stale) restartSession();

    // 作り直したばかりの claude はこれまでの会話を知らないので、最初の1回だけ履歴を添える
    const prompt = session.turns === 0 ? buildPrompt(history, userText) : userText;
    try {
      return await session.ask(prompt);
    } catch (err) {
      // 落ちたことにまだ気づかないうちに送ってしまった場合などは、作り直してもう一度だけ試す
      if (err.kind !== 'exited' || attempt >= 2) throw err;
    }
  }
}

/**
 * 今日の直近の会話を簡単なテキストにして、新しい発言の前に添える。
 * 新しい方から詰めていき、上限を超えたところで打ち切る。
 */
function buildPrompt(pastMessages, userText) {
  const todayStart = startOfToday();
  const recent = pastMessages
    .filter((message) => message.at >= todayStart)
    .slice(-PROMPT_HISTORY_MAX_TURNS * 2);

  const lines = [];
  let budget = PROMPT_HISTORY_MAX_CHARS;
  for (let i = recent.length - 1; i >= 0; i--) {
    const speaker = recent[i].role === 'user' ? 'ユーザー' : 'マスコット';
    const body = clip(recent[i].content.replace(/\s+/g, ' '), PROMPT_HISTORY_MESSAGE_MAX_CHARS);
    const line = `${speaker}: ${body}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }

  if (lines.length === 0) return userText;

  return [
    '以下は今日のこれまでの会話です（古い順）。',
    ...lines,
    '',
    'この流れを踏まえて、次のユーザーの発言に返事してください。',
    `ユーザー: ${userText}`,
  ].join('\n');
}

function clip(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function describeError(err) {
  console.error('[claude]', err.message);
  if (err instanceof ClaudeCliError && err.kind === 'not-found') {
    return 'claude コマンドが見つからないみたい。Claude Code は入ってる？';
  }
  if (err instanceof ClaudeCliError && err.kind === 'timeout') {
    return '考えこみすぎちゃったみたい。もう一回話しかけて。';
  }
  return 'エラーが起きたみたい。ちょっと待ってからまた話しかけて。';
}
