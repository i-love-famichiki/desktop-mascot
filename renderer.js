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
function say(text, { keep = false } = {}) {
  clearTimeout(hideTimer);
  bubbleTextEl.textContent = text;
  bubbleEl.classList.remove('hidden');
  if (!keep) {
    // 読み終わるくらいの時間で引っ込める
    hideTimer = setTimeout(hideBubble, 4000 + text.length * 80);
  }
}

function hideBubble() {
  bubbleEl.classList.add('hidden');
  bubbleEl.classList.remove('thinking');
}

// 返事は残しておくので、クリックで閉じられるようにする（考え中は閉じない）
bubbleEl.addEventListener('click', () => {
  if (!busy) hideBubble();
});

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
  bubbleEl.classList.remove('hidden');
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

// 右クリックで終了メニュー代わり（トレイが無い環境でも閉じられるように）
mascotEl.addEventListener('contextmenu', () => {
  if (confirm('マスコットを終了する？')) window.mascot.quit();
});

// 起動時のあいさつ
window.addEventListener('DOMContentLoaded', () => {
  say('やあ。クリックで話しかけてね。');
});
