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
const bubbleSourcesEl = document.getElementById('bubble-sources');

function say(text, { keep = false, sources = [] } = {}) {
  clearTimeout(hideTimer);
  bubbleTextEl.replaceChildren(...linkify(text));
  bubbleTextEl.scrollTop = 0;
  showSources(sources);
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

// 検索を使った返事の出典。サイト名を押すと既定のブラウザで開く
function showSources(sources) {
  bubbleSourcesEl.replaceChildren();
  bubbleSourcesEl.hidden = sources.length === 0;
  if (sources.length === 0) return;

  bubbleSourcesEl.append('出典: ');
  sources.forEach((source, index) => {
    if (index > 0) bubbleSourcesEl.append('、');
    bubbleSourcesEl.append(createLink(source.title, source.uri));
  });
}

// 押すと既定のブラウザで開くリンク（吹き出しの中では画面を移動させない）
function createLink(label, url) {
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = label;
  link.title = `ブラウザで開く: ${url}`;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    window.mascot.openLink(url);
  });
  return link;
}

// 返事の中の URL と、Markdown 形式のリンク [名前](URL) を押せるリンクにする。
// 文は日本語で続くことが多いので、URL は全角の文字や空白の手前で区切る
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`　-ヿ一-鿿＀-￯]+/g;
// URL の直後に付きやすい句読点やかっこは、URL に含めない
const URL_TRAILING = /[.,;:!?'")\]]+$/;

function linkify(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    let [whole, label, url] = match;
    if (!url) {
      url = whole.replace(URL_TRAILING, '');
      // 閉じかっこは、URL の中に開きかっこがあるときだけ残す（Wikipedia の URL など）
      const rest = whole.slice(url.length);
      if (rest.startsWith(')') && url.includes('(')) url += ')';
      whole = url;
    }
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(createLink(label ?? url, url));
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ---------------------------------------------------------------------------
// 会話の履歴（右クリックかトレイのメニューから）
// ---------------------------------------------------------------------------
// 吹き出しの中に一覧で出す。長くなりすぎないよう高さを抑え、中でスクロールさせる
const HISTORY_MAX_HEIGHT = 360;

async function showHistory() {
  if (busy) return;
  // 1週間より前は要約だけ、直近7日は詳しい会話が届く
  const { summaries, messages } = await window.mascot.getHistory();
  if (summaries.length === 0 && messages.length === 0) {
    say('まだ会話していないよ。');
    return;
  }

  clearTimeout(hideTimer);
  bubbleTextEl.replaceChildren(
    ...summaries.map(renderSummaryItem),
    ...messages.map(renderHistoryItem),
  );
  showSources([]);
  bubbleEl.classList.remove('hidden', 'minimized');
  bubbleEl.classList.add('history');
  bubbleRestoreEl.textContent = '履歴を見る';

  // 高さの上限を先に決めてから、いちばん新しい発言が見えるよう下までスクロール
  fitWindow();
  bubbleTextEl.scrollTop = bubbleTextEl.scrollHeight;
}

function renderHistoryItem(message) {
  // 何日分も残るので、時刻だけでなく日付も添える
  const time = new Date(message.at).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return buildHistoryItem(message.role, `${message.role === 'user' ? 'あなた' : '豆'}  ${time}`, message.content);
}

function renderSummaryItem({ date, summary }) {
  const [, month, day] = date.split('-').map(Number);
  return buildHistoryItem('summary', `${month}/${day} のまとめ`, summary);
}

function buildHistoryItem(kind, label, text) {
  const item = document.createElement('span');
  item.className = `history-item ${kind}`;

  const who = document.createElement('span');
  who.className = 'history-who';
  who.textContent = label;

  const body = document.createElement('span');
  body.className = 'history-body';
  body.replaceChildren(...linkify(text));

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
// たまに転がる
// ---------------------------------------------------------------------------
// 何もしていないとき（吹き出しも入力欄も出ていない・ドラッグ中でない）だけ、
// ときどき左右どちらかへ転がって元の場所に戻る。動きそのものは style.css
const ROLL_INTERVAL_MIN_MS = 30 * 1000;
const ROLL_INTERVAL_MAX_MS = 90 * 1000;

function scheduleRoll() {
  const delay = ROLL_INTERVAL_MIN_MS + Math.random() * (ROLL_INTERVAL_MAX_MS - ROLL_INTERVAL_MIN_MS);
  setTimeout(() => {
    startRoll();
    scheduleRoll();
  }, delay);
}

function startRoll() {
  const idle =
    !busy &&
    !pointerDownAt &&
    bubbleEl.classList.contains('hidden') &&
    inputRowEl.classList.contains('hidden');
  if (!idle || mascotEl.classList.contains('rolling')) return;

  mascotEl.style.setProperty('--roll', Math.random() < 0.5 ? '-1' : '1');
  mascotEl.classList.add('rolling');
}

function stopRoll() {
  mascotEl.classList.remove('rolling');
}

mascotEl.addEventListener('animationend', (event) => {
  if (event.animationName === 'roll-move') stopRoll();
});

scheduleRoll();

// ---------------------------------------------------------------------------
// ドラッグ移動（クリックと区別するため、動いた距離でしきい値を取る）
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD = 4;
let pointerDownAt = null;
let dragging = false;

mascotEl.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  // 転がっている途中で掴まれたら、その場で転がるのをやめる
  stopRoll();
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

// 隠したときはメイン側で素通りに戻しているので、こちらで覚えている状態も合わせる。
// 合わせないと、次に出したとき豆の上に来ても受け付けに切り替わらない
window.mascot.onHidden(() => {
  clickThrough = true;
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
  showSources([]);
  bubbleEl.classList.remove('hidden', 'minimized', 'history');
  bubbleEl.classList.add('thinking');
  mascotEl.classList.add('talking');

  try {
    const result = await window.mascot.send(text);
    // 失敗時はエラー文が入る。読み返せるよう、次に話しかけるか×を押すまで残す。
    // Google 検索を使った返事なら出典も添える
    say(result.text, { keep: true, sources: result.sources ?? [] });
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
