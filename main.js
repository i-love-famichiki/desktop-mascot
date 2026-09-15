'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, net, shell } = require('electron');
const path = require('path');

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
    '名前はまだありません。ユーザーが名前をくれたら喜んで受け取ってください。',
    '口調は親しみやすく、少しだけ子どもっぽく、絵文字は使いません。',
    '返事は必ず日本語で、基本は2〜3文の短さに収めてください。画面の小さな吹き出しに表示されます。',
  ].join('\n');
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;

// 会話履歴はメインプロセスだけが持つ（メモリ上のみ）
// 要素は { role: 'user' | 'assistant', content: string, at: number }
let history = [];

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
}

function createTray() {
  // アイコンは後で差し替える。空でもトレイには載る。
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Desktop Mascot');
  tray.setContextMenu(buildMenu());
}

/** トレイと、マスコットの右クリックで共通のメニュー */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '会話の履歴を見る', click: () => win?.webContents.send('history:show') },
    { label: '会話をリセット', click: () => { history = []; } },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
}

ipcMain.on('menu:show', () => {
  if (win) buildMenu().popup({ window: win });
});

app.whenReady().then(() => {
  createWindow();
  try {
    createTray();
  } catch (err) {
    // アイコン未配置でも起動は止めない
    console.warn('トレイの作成をスキップしました:', err.message);
  }
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

// 履歴の表示用。メモリ上の会話をそのまま渡す（終了やリセットで消える）
ipcMain.handle('chat:history', () =>
  history.map(({ role, content, at }) => ({ role, content, at })),
);

async function chat(userText) {
  try {
    const { text, sources } = await askGemini(buildContents(history, userText));
    history.push(
      { role: 'user', content: userText, at: Date.now() },
      { role: 'assistant', content: text, at: Date.now() },
    );

    // 履歴が伸びすぎないよう、古い方から捨てる（直近20往復ぶん）
    if (history.length > HISTORY_MAX_TURNS * 2) history = history.slice(-HISTORY_MAX_TURNS * 2);

    return { ok: true, text, sources };
  } catch (err) {
    return { ok: false, text: describeError(err), sources: [] };
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

/** 今日の直近の会話に新しい発言を足して、Gemini に送る contents の形にする */
function buildContents(pastMessages, userText) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  return [
    ...pastMessages
      .filter((message) => message.at >= startOfToday)
      .slice(-HISTORY_MAX_TURNS * 2)
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.content }],
      })),
    { role: 'user', parts: [{ text: userText }] },
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
 * Google 検索を道具として渡しておき、検索するかどうかはモデルが決める。
 * @returns {Promise<{ text: string, sources: { title: string, uri: string }[] }>}
 */
async function askGemini(contents) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError('no-key', 'GEMINI_API_KEY が設定されていません');

  let res;
  try {
    // Chromium の通信機能を使う（OS の証明書ストアを使うので、セキュリティソフトの割り込みにも強い）
    res = await net.fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents,
        tools: [{ google_search: {} }],
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

  return { text, sources: extractSources(candidate?.groundingMetadata) };
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
