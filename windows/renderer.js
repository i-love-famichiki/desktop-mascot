'use strict';

const mascotEl = document.getElementById('mascot');
const mascotImgEl = document.getElementById('mascot-img');
const fallbackEl = document.getElementById('mascot-fallback');
const lookEls = [...document.querySelectorAll('.mascot-svg')];
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
const bubbleSearchEl = document.getElementById('bubble-search');

function say(text, { keep = false, sources = [], searchSuggestions = null } = {}) {
  clearTimeout(hideTimer);
  bubbleTextEl.replaceChildren(...linkify(text));
  bubbleTextEl.scrollTop = 0;
  showSources(sources);
  showSearchSuggestions(searchSuggestions);
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

// Google 検索を使った返事の「検索候補」。Google の規約で表示が求められている。
// Google が作った HTML（スタイル付き）は変えずにそのまま枠の中へ入れる。
// 枠はスクリプトを動かせず、リンクは新しいウィンドウ扱いにして、メイン側で外部ブラウザに渡す
function showSearchSuggestions(suggestions) {
  const html = suggestions?.html || buildSuggestionChips(suggestions?.queries ?? []);
  bubbleSearchEl.hidden = !html;
  bubbleSearchEl.style.height = '0';
  if (!html) {
    bubbleSearchEl.removeAttribute('srcdoc');
    return;
  }
  // <base target="_blank"> でリンクを枠の外（外部ブラウザ）で開かせる。body の余白だけ消す
  bubbleSearchEl.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0}</style>${html}`;
}

// 枠の中身の高さに合わせる（吹き出しの高さが変わるとウィンドウの高さも合わせ直される）
bubbleSearchEl.addEventListener('load', () => {
  const doc = bubbleSearchEl.contentDocument;
  if (!doc || bubbleSearchEl.hidden) return;
  bubbleSearchEl.style.height = `${doc.documentElement.scrollHeight}px`;
});

// renderedContent が無いのに検索語だけあるときの代わり。Google 検索へのリンクを並べる
function buildSuggestionChips(queries) {
  if (queries.length === 0) return '';
  const escape = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const chips = queries
    .map((query) => `<a href="https://www.google.com/search?q=${encodeURIComponent(query)}" style="display:inline-block;margin:2px 4px 2px 0;padding:3px 10px;border:1px solid #d2d2d2;border-radius:14px;color:#5e5e5e;text-decoration:none;font:12px sans-serif;background:#fff">${escape(query)}</a>`)
    .join('');
  return `<div style="font:11px sans-serif;color:#777;margin-bottom:2px">Google 検索の候補</div>${chips}`;
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
  showSearchSuggestions(null);
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
  // 転がっている・はねている途中で掴まれたら、その場でやめる
  stopRoll();
  stopBounce();
  pointerDownAt = { x: event.screenX, y: event.screenY };
  dragging = false;
  window.mascot.dragStart();
});

window.addEventListener('mousemove', (event) => {
  if (!pointerDownAt) return;
  // 画面の外などで離されて mouseup を取りこぼしたときは、ここで掴むのをやめる
  if (event.buttons === 0) {
    console.log('[drag] buttons=0 なので掴むのをやめた');
    endDrag();
    return;
  }
  if (!dragging) {
    const moved =
      Math.abs(event.screenX - pointerDownAt.x) +
      Math.abs(event.screenY - pointerDownAt.y);
    if (moved < DRAG_THRESHOLD) return;
    dragging = true;
  }
  console.log('[drag] mousemove buttons=', event.buttons, 'dragging=', dragging);
  window.mascot.dragMove();
});

window.addEventListener('mouseup', () => {
  // 動かさずに離したらクリック扱い＝話しかける
  if (endDrag() === 'click') toggleInput();
});

// 掴むのをやめる。動かさずに離したときだけ 'click' を返す
function endDrag() {
  if (!pointerDownAt) return 'none';
  const wasDrag = dragging;
  pointerDownAt = null;
  dragging = false;
  window.mascot.dragEnd();
  return wasDrag ? 'drag' : 'click';
}

// ほかのアプリへ切り替わったときも、掴んだままにしない
window.addEventListener('blur', endDrag);

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
  return target instanceof SVGElement && !(target instanceof SVGSVGElement);
}

// 豆の見た目。絵は4つとも index.html にあり、選ばれたものだけを出す
function applyLook(id) {
  const found = lookEls.some((el) => el.dataset.look === id);
  for (const el of lookEls) el.classList.toggle('on', el.dataset.look === (found ? id : 'smooth'));
}

window.mascot.getLook().then(applyLook).catch(() => applyLook('smooth'));
window.mascot.onLookChanged(applyLook);

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
  // 画像を受け取って待っている間は、話しかけた言葉を「どれくらい小さくするか」として扱う
  if (pendingImages) compress(text);
  else ask(text);
});

// ---------------------------------------------------------------------------
// マスコットに話しかける（返事はメインプロセスが Gemini からもらってくる）
// ---------------------------------------------------------------------------
// 返事は Gemini からあっという間に届くので、そのまま出すと一度に出たように見える。
// 届いた文字をためておき、1文字ずつ打つように吹き出しへ出す。
// ためている文字が多いときは1回に出す文字を増やし、遅れすぎないようにする
const TYPE_INTERVAL_MS = 45;
const TYPE_CATCHUP_TICKS = 60;

let typed = '';
let pendingChars = [];
let typeTimer = null;
let onTypingDone = null;

window.mascot.onDelta((delta) => {
  // 返事が出はじめたところで鳴らす（打ち終わりではなく話しはじめ）
  playReplySound();
  pendingChars.push(...delta);
  if (!typeTimer) typeTimer = setInterval(typeStep, TYPE_INTERVAL_MS);
});

// 1回の返事で1度だけ鳴らす。ask() が話しかけるたびに待ち受けに戻す
let replySoundPending = false;

function playReplySound() {
  if (!replySoundPending) return;
  replySoundPending = false;
  playSound(sounds.reply, sounds.volume);
}

function typeStep() {
  if (pendingChars.length === 0) {
    stopTyping();
    return;
  }
  // 最初の1文字を出すときに「考え中」表示をやめて本文に切り替える
  if (typed === '') bubbleEl.classList.remove('thinking');
  const count = Math.max(1, Math.ceil(pendingChars.length / TYPE_CATCHUP_TICKS));
  typed += pendingChars.splice(0, count).join('');
  bubbleTextEl.textContent = typed.trimStart();
}

function stopTyping() {
  clearInterval(typeTimer);
  typeTimer = null;
  onTypingDone?.();
  onTypingDone = null;
}

/** ためている文字を出し終わるまで待つ */
function waitTyping() {
  if (!typeTimer) return Promise.resolve();
  return new Promise((resolve) => {
    onTypingDone = resolve;
  });
}

function resetTyping() {
  pendingChars = [];
  stopTyping();
  typed = '';
}

async function ask(text) {
  busy = true;
  replySoundPending = true;
  resetTyping();
  clearTimeout(hideTimer);
  bubbleTextEl.textContent = '';
  showSources([]);
  showSearchSuggestions(null);
  bubbleEl.classList.remove('hidden', 'minimized', 'history');
  bubbleEl.classList.add('thinking');
  mascotEl.classList.add('talking');

  try {
    const result = await window.mascot.send(text);
    // うまくいったときは、打ち終わってから全文をリンクつきで出し直す。
    // 失敗時はエラー文が入る（途中まで出ていた文は置き換える）。
    // 読み返せるよう、次に話しかけるか×を押すまで残す。
    // Google 検索を使った返事なら出典も添える
    if (result.ok) await waitTyping();
    resetTyping();
    say(result.text, { keep: true, sources: result.sources ?? [], searchSuggestions: result.searchSuggestions });
    // 1文字も流れてこなかったとき（エラーの文など）は、ここで鳴らす
    playReplySound();
  } finally {
    busy = false;
    mascotEl.classList.remove('talking');
    bubbleEl.classList.remove('thinking');
  }
  // 返事を待っている間に時間が来たお知らせがあれば、ここで出す
  showReminders();
}

// ---------------------------------------------------------------------------
// 画像を小さくする（ドロップ → 話しかけて大きさを指定 → デスクトップに置く）
// ---------------------------------------------------------------------------
const IMAGE_EXTENSIONS = /\.(jpe?g|png)$/i;
const COMPRESS_HELP = '「500KBにして」「50%にして」「半分にして」「メール添付用にして」みたいに言ってね。';

// 受け取って、指定を待っている画像の場所。待っていないときは null
let pendingImages = null;

// ドロップを受け付ける。受け付けないと、Electron が画像そのものを窓に開いてしまう
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  if (busy) return;
  const paths = [...event.dataTransfer.files].map((file) => window.mascot.pathForFile(file)).filter(Boolean);
  if (paths.length === 0) return;
  if (!paths.some((file) => IMAGE_EXTENSIONS.test(file))) {
    say('JPEG か PNG の画像を渡してね。');
    return;
  }

  // 画像でないファイルも一緒に預かり、処理のときに「処理できなかった」と伝える
  pendingImages = paths;
  say(`画像を${paths.length}枚受け取ったよ。どれくらい小さくする？\n${COMPRESS_HELP}\n（やめるときは「やめて」）`, { keep: true });
  inputRowEl.classList.remove('hidden');
  resizeInput();
  window.mascot.focusWindow();
  inputEl.focus();
});

window.mascot.onCompressProgress((text) => {
  if (busy) say(text, { keep: true });
});

async function compress(text) {
  busy = true;
  mascotEl.classList.add('talking');
  say('どれどれ…', { keep: true });
  try {
    const result = await window.mascot.compressImages(pendingImages, text);
    if (result.status === 'unknown') {
      say(`ごめん、どれくらいにするか分からなかった。\n${COMPRESS_HELP}\n（やめるときは「やめて」）`, { keep: true });
    } else {
      pendingImages = null;
      say(result.status === 'cancel' ? 'わかった、やめておくね。' : result.text, { keep: true });
    }
  } catch (err) {
    pendingImages = null;
    console.error('[image]', err);
    say('ごめん、画像を小さくしている途中でエラーが起きちゃった。', { keep: true });
  } finally {
    busy = false;
    mascotEl.classList.remove('talking');
  }
  showReminders();
}

// ---------------------------------------------------------------------------
// タイマーとリマインダーのお知らせ（時間の管理はメインプロセス）
// ---------------------------------------------------------------------------
// 吹き出しで知らせて、豆をはねさせる。返事を待っている間に来たら、返事が出てから知らせる
let pendingReminders = [];

window.mascot.onReminder((text) => {
  pendingReminders.push(text);
  showReminders();
});

function showReminders() {
  if (busy || pendingReminders.length === 0) return;
  say(pendingReminders.join('\n\n'), { keep: true });
  pendingReminders = [];
  startBounce();
  playSound(sounds.notify, sounds.volume);
}

// 鳴らす音は設定で選べる（sounds.js / sound-player.js）。中身はメイン側から受け取り、
// 設定が変わったら受け取り直す
let sounds = { notify: null, reply: null, volume: null };

async function loadSounds() {
  try {
    sounds = await window.mascot.getSounds();
  } catch (err) {
    console.warn('[sound] 音の設定を読めませんでした:', err.message);
  }
}

loadSounds();
window.mascot.onSoundsChanged(loadSounds);

function startBounce() {
  stopRoll();
  // 続けて知らせたときも、はね始めからやり直す
  mascotEl.classList.remove('bouncing');
  void mascotEl.offsetWidth;
  mascotEl.classList.add('bouncing');
}

function stopBounce() {
  mascotEl.classList.remove('bouncing');
}

mascotEl.addEventListener('animationend', (event) => {
  if (event.animationName === 'bounce') stopBounce();
});

// 右クリックでメニュー（履歴・リセット・終了）。トレイが無い環境でも使えるように
mascotEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.mascot.showMenu();
});

// 起動時のあいさつ
window.addEventListener('DOMContentLoaded', () => {
  say('やあ。クリックで話しかけてね。');
});
