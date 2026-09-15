'use strict';

const mascotEl = document.getElementById('mascot');
const mascotImgEl = document.getElementById('mascot-img');
const fallbackEl = document.getElementById('mascot-fallback');
const bubbleEl = document.getElementById('bubble');
const bubbleTextEl = document.getElementById('bubble-text');
const inputRowEl = document.getElementById('input-row');
const inputEl = document.getElementById('input');

let hideTimer = null;
let busy = false;

// ---------------------------------------------------------------------------
// 画像の差し替え
// ---------------------------------------------------------------------------
// assets/mascot.png が読めたらそれを使い、無ければ CSS 製のキャラのまま。
// 画像を置き換えるだけで見た目が変わり、会話やドラッグのコードは触らなくていい。
mascotImgEl.addEventListener('load', () => {
  mascotImgEl.hidden = false;
  fallbackEl.hidden = true;
  mascotEl.classList.add('has-image');
});

mascotImgEl.addEventListener('error', () => {
  mascotImgEl.hidden = true;
  fallbackEl.hidden = false;
  mascotEl.classList.remove('has-image');
});

// ---------------------------------------------------------------------------
// 吹き出し
// ---------------------------------------------------------------------------
const bubbleRestoreEl = document.getElementById('bubble-restore');

function say(text, { keep = false } = {}) {
  clearTimeout(hideTimer);
  bubbleTextEl.textContent = text;
  bubbleTextEl.scrollTop = 0;
  bubbleEl.classList.remove('hidden', 'minimized', 'history');
  bubbleRestoreEl.textContent = '返事を見る';
  if (!keep) {
    // 読み終わるくらいの時間で引っ込める
    hideTimer = setTimeout(hideBubble, 4000 + text.length * 80);
  }
}

function hideBubble() {
  bubbleEl.classList.add('hidden');
  bubbleEl.classList.remove('thinking', 'minimized', 'history');
}

// ---------------------------------------------------------------------------
// 会話の履歴（右クリックかトレイのメニューから）
// ---------------------------------------------------------------------------
// 吹き出しの中に一覧で出す。長くなりすぎないよう高さを抑え、中でスクロールさせる
const HISTORY_MAX_HEIGHT = 360;

async function showHistory() {
  if (busy) return;
  const messages = await window.mascot.getHistory();
  if (messages.length === 0) {
    say('まだ会話していないよ。');
    return;
  }

  clearTimeout(hideTimer);
  bubbleTextEl.replaceChildren(...messages.map(renderHistoryItem));
  bubbleEl.classList.remove('hidden', 'minimized');
  bubbleEl.classList.add('history');
  bubbleRestoreEl.textContent = '履歴を見る';

  // 高さの上限を先に決めてから、いちばん新しい発言が見えるよう下までスクロール
  fitWindow();
  bubbleTextEl.scrollTop = bubbleTextEl.scrollHeight;
}

function renderHistoryItem(message) {
  const item = document.createElement('span');
  item.className = `history-item ${message.role}`;

  const who = document.createElement('span');
  who.className = 'history-who';
  const time = new Date(message.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  who.textContent = `${message.role === 'user' ? 'あなた' : '豆'}  ${time}`;

  const body = document.createElement('span');
  body.className = 'history-body';
  body.textContent = message.content;

  item.append(who, body);
  return item;
}

window.mascot.onShowHistory(showHistory);

// 返事は残しておき、×ボタンを押したときだけ閉じる（考え中は閉じない）。
// 吹き出し本体のクリックでは消えないので、文字を選んでコピーできる
document.getElementById('bubble-close').addEventListener('click', () => {
  if (!busy) hideBubble();
});

// 最小化: 返事は残したまま「返事を見る」ボタンだけに縮める
document.getElementById('bubble-minimize').addEventListener('click', () => {
  if (!busy) bubbleEl.classList.add('minimized');
});

document.getElementById('bubble-restore').addEventListener('click', () => {
  bubbleEl.classList.remove('minimized');
});

// ---------------------------------------------------------------------------
// ウィンドウの高さ合わせ
// ---------------------------------------------------------------------------
// 長い返事でも全文が見えるよう、中身の高さをメインに伝えてウィンドウを上に伸ばしてもらう。
// 画面の高さを超える分だけは、吹き出しの中でスクロールさせる。
const stageEl = document.getElementById('stage');

function fitWindow() {
  const stageStyle = getComputedStyle(stageEl);
  const gap = parseFloat(stageStyle.rowGap) || 0;
  const visible = [...stageEl.children].filter((el) => el.offsetHeight > 0);
  const bubbleVisible = visible.includes(bubbleEl);

  // 吹き出し以外が占める高さ
  let others =
    parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom) +
    gap * Math.max(visible.length - 1, 0);
  for (const el of visible) {
    if (el !== bubbleEl) others += el.offsetHeight;
  }

  let height = others;
  if (bubbleVisible) {
    const bubbleStyle = getComputedStyle(bubbleEl);
    const bubbleTop = parseFloat(bubbleStyle.marginTop) + parseFloat(bubbleStyle.marginBottom);
    // 最小化中は本文が隠れていて測れないので、上限はそのままにしておく
    if (bubbleTextEl.offsetHeight > 0) {
      const bubbleChrome = bubbleEl.offsetHeight - bubbleTextEl.offsetHeight;
      let limit = window.screen.availHeight - others - bubbleTop - bubbleChrome;
      if (bubbleEl.classList.contains('history')) limit = Math.min(limit, HISTORY_MAX_HEIGHT);
      bubbleTextEl.style.maxHeight = `${Math.max(limit, 60)}px`;
    }
    height += bubbleTop + bubbleEl.offsetHeight;
  }
  window.mascot.fitHeight(Math.ceil(height));
}

const fitObserver = new ResizeObserver(fitWindow);
fitObserver.observe(bubbleEl);
fitObserver.observe(inputRowEl);
fitObserver.observe(mascotEl);

// ---------------------------------------------------------------------------
// ドラッグ移動（クリックと区別するため、動いた距離でしきい値を取る）
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD = 4;
let pointerDownAt = null;
let dragging = false;

mascotEl.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  pointerDownAt = { x: event.screenX, y: event.screenY };
  dragging = false;
  window.mascot.dragStart();
});

window.addEventListener('mousemove', (event) => {
  if (!pointerDownAt) return;
  if (!dragging) {
    const moved =
      Math.abs(event.screenX - pointerDownAt.x) +
      Math.abs(event.screenY - pointerDownAt.y);
    if (moved < DRAG_THRESHOLD) return;
    dragging = true;
  }
  window.mascot.dragMove();
});

window.addEventListener('mouseup', () => {
  if (!pointerDownAt) return;
  const wasDrag = dragging;
  pointerDownAt = null;
  dragging = false;
  window.mascot.dragEnd();

  // 動かさずに離したらクリック扱い＝話しかける
  if (!wasDrag) toggleInput();
});

// ---------------------------------------------------------------------------
// 透明な部分のクリックを後ろのアプリに渡す
// ---------------------------------------------------------------------------
// ウィンドウは透明な所もクリックを受け止めてしまうので、マウスがマスコット・
// 吹き出し・入力欄の上にあるときだけ受け付け、それ以外は素通りさせる。
let clickThrough = true;

function setClickThrough(enabled) {
  if (enabled === clickThrough) return;
  clickThrough = enabled;
  window.mascot.setClickThrough(enabled);
}

function isSolid(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('#bubble, #input-row, #mascot-img')) return true;
  // SVG は描かれた図形の上だけ。枠の四角い余白は透明なので素通りさせる
  return target instanceof SVGElement && target.id !== 'mascot-svg';
}

window.addEventListener('mousemove', (event) => {
  // ドラッグ中に切り替えると mouseup を取りこぼすので触らない
  if (pointerDownAt) return;
  setClickThrough(!isSolid(event.target));
});

document.documentElement.addEventListener('mouseleave', () => {
  if (!pointerDownAt) setClickThrough(true);
});

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------
function toggleInput() {
  if (inputRowEl.classList.contains('hidden')) {
    inputRowEl.classList.remove('hidden');
    resizeInput();
    inputEl.focus();
  } else {
    inputRowEl.classList.add('hidden');
    inputEl.blur();
  }
}

// 入力欄は文字数に合わせて縦に伸ばす。ウィンドウの高さは固定なので、
// 吹き出しが押し出されないよう4行ぶんで止め、それ以上は中でスクロールさせる
const INPUT_MAX_LINES = 4;

function resizeInput() {
  const style = getComputedStyle(inputEl);
  const lineHeight = parseFloat(style.lineHeight);
  const extra =
    parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
    parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const maxHeight = lineHeight * INPUT_MAX_LINES + extra;

  inputEl.style.height = 'auto';
  const contentHeight = inputEl.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  inputEl.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  inputEl.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}

inputEl.addEventListener('input', resizeInput);

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    inputRowEl.classList.add('hidden');
    inputEl.blur();
    return;
  }
  // Shift+Enter は改行、IME 変換中の Enter は変換の確定なので送らない
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  resizeInput();
  ask(text);
});

// ---------------------------------------------------------------------------
// マスコットに話しかける（返事はメインプロセスが Gemini からもらってくる）
// ---------------------------------------------------------------------------
let streamed = '';

window.mascot.onDelta((delta) => {
  // 最初の1文字が来たら「考え中」表示をやめて本文に切り替える
  if (streamed === '') {
    bubbleEl.classList.remove('thinking');
    bubbleTextEl.textContent = '';
  }
  streamed += delta;
  bubbleTextEl.textContent = streamed;
});

async function ask(text) {
  busy = true;
  streamed = '';
  clearTimeout(hideTimer);
  bubbleTextEl.textContent = '';
  bubbleEl.classList.remove('hidden', 'minimized', 'history');
  bubbleEl.classList.add('thinking');
  mascotEl.classList.add('talking');

  try {
    const result = await window.mascot.send(text);
    // 失敗時はエラー文が入る。読み返せるよう、次に話しかけるかクリックするまで残す
    say(result.text, { keep: true });
  } finally {
    busy = false;
    streamed = '';
    mascotEl.classList.remove('talking');
    bubbleEl.classList.remove('thinking');
  }
}

// 右クリックでメニュー（履歴・リセット・終了）。トレイが無い環境でも使えるように
mascotEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.mascot.showMenu();
});

// 起動時のあいさつ
window.addEventListener('DOMContentLoaded', () => {
  say('やあ。クリックで話しかけてね。');
});
