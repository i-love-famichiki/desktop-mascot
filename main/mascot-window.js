'use strict';

// マスコットの窓（作る・出す・隠す・ドラッグで動かす・高さを合わせる）

const { BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const state = require('./state');
const { isGoogleSearchUrl } = require('./gemini');

// ウィンドウの基本の高さ。長い返事のときだけ一時的に上へ伸ばす
const WINDOW_MIN_HEIGHT = 420;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  const win = new BrowserWindow({
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
      preload: path.join(state.ROOT, 'windows', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // タイマーやリマインダーの音は、クリックされていなくても鳴らせるようにする
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  state.win = win;

  // 全画面アプリの上にも出す
  win.setAlwaysOnTop(true, 'screen-saver');
  // 透明な部分のクリックは後ろのアプリに渡す。マウスの動きだけは受け取り、
  // マスコットや吹き出しの上に来たらレンダラーが受け付けに切り替える
  win.setIgnoreMouseEvents(true, { forward: true });
  // ※ 一時的: 画面側の [drag] の記録も端末に出す
  win.webContents.on('console-message', (_event, _level, message) => {
    if (String(message).startsWith('[drag]')) console.log('[renderer]', message);
  });
  win.loadFile('windows/index.html');
  // 起動する前や待ち時間中に時間が来ていたリマインダーは、読み込みが終わってから知らせる（notices.js）
  win.webContents.on('did-finish-load', () => state.events.emit('window-loaded'));

  // 検索候補の枠の中のリンクは新しいウィンドウとして開かれる。アプリの中では開かず、
  // Google 検索のページだけを外部ブラウザに渡す
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleSearchUrl(url)) shell.openExternal(url);
    else console.warn('[link] 開かなかったリンク:', url);
    return { action: 'deny' };
  });

  // 「隠す／表示」のメニューの文字を合わせる（menu.js）
  win.on('show', () => state.events.emit('window-visibility'));
  win.on('hide', () => state.events.emit('window-visibility'));
  state.events.emit('window-visibility');
}

// ---------------------------------------------------------------------------
// 表示／非表示（終了せずに引っ込める）
// ---------------------------------------------------------------------------
/** マスコットを出す。自動起動の待ち時間中なら、待たずにすぐ出す */
function showMascot() {
  if (!state.win) {
    createWindow();
    return;
  }
  state.win.show();
  // 隠している間に外れることがあるので、一番手前に出す指定をかけ直す
  state.win.setAlwaysOnTop(true, 'screen-saver');
}

function hideMascot() {
  if (!state.win) return;
  state.win.hide();
  // 隠すとマウスはもう上に無いので、次に出したとき透明な所が素通りになるよう戻しておく
  state.win.setIgnoreMouseEvents(true, { forward: true });
  state.win.webContents.send('window:hidden');
}

function toggleMascot() {
  if (state.win?.isVisible()) hideMascot();
  else showMascot();
}

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
  if (!state.win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = state.win.getPosition();
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
  dbgTicks = 0;
  dbgMoves = 0;
  console.log('[drag] start offset=', dragOffset, 'win=', wx, wy, 'cursor=', cursor.x, cursor.y);
});

// 「ここから本当に動かす」の合図。あとはこちらで追い続ける
ipcMain.on('drag:move', () => {
  if (!state.win || !dragOffset || dragTimer) return;
  console.log('[drag] move（追従を始める）');
  followCursor();
  dragTimer = setInterval(followCursor, DRAG_FOLLOW_MS);
});

function followCursor() {
  const { win } = state;
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
  const { win } = state;
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
  state.win?.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
});

// 画像をドロップされたあと、すぐ話しかけられるよう入力欄に文字を打てる状態にする
ipcMain.on('window:focus', () => {
  state.win?.focus();
});

module.exports = { createWindow, showMascot, hideMascot, toggleMascot };
