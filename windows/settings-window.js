'use strict';

// 設定ウィンドウの表示と操作。設定の保存はメインプロセス（main/ の settings:* ）が行う

const $ = (id) => document.getElementById(id);
const openAtLoginEl = $('open-at-login');
const openAtLoginNoteEl = $('open-at-login-note');
const shareStatusEl = $('share-status');
const shareChooseEl = $('share-choose');
const shareStopEl = $('share-stop');
const mascotLookEl = $('mascot-look');
const geminiModelEl = $('gemini-model');
const webSearchEl = $('web-search');
const keepPastEl = $('keep-past');
const apiKeyModeEls = { env: $('api-key-mode-env'), saved: $('api-key-mode-saved') };
const apiKeyEnvNameEl = $('api-key-env-name');
const apiKeyEnvListEl = $('api-key-env-list');
const apiKeyEnvUseEl = $('api-key-env-use');
const apiKeyEnvStatusEl = $('api-key-env-status');
const apiKeySavedStatusEl = $('api-key-saved-status');
const apiKeyInputEl = $('api-key-input');
const apiKeySaveEl = $('api-key-save');
const apiKeyClearEl = $('api-key-clear');
const apiKeyMessageEl = $('api-key-message');
const usageSummaryEl = $('usage-summary');
const soundEls = {
  notify: {
    select: $('notify-sound'),
    test: $('notify-sound-test'),
    fileRow: $('notify-sound-file-row'),
    fileName: $('notify-sound-file'),
    choose: $('notify-sound-choose'),
  },
  reply: {
    select: $('reply-sound'),
    test: $('reply-sound-test'),
    fileRow: $('reply-sound-file-row'),
    fileName: $('reply-sound-file'),
    choose: $('reply-sound-choose'),
  },
};
const soundVolumeEl = $('sound-volume');
const calendarModeEl = $('calendar-mode');
const calendarModeNoteEl = $('calendar-mode-note');
const calendarAccountEl = $('calendar-account');
const calendarSignInEl = $('calendar-sign-in');
const calendarSignOutEl = $('calendar-sign-out');
const calendarRefreshEl = $('calendar-refresh');
const calendarClientEl = $('calendar-client');
const calendarClientChooseEl = $('calendar-client-choose');
const tabEls = [...document.querySelectorAll('.tabs button')];

// 操作の途中（ダイアログやブラウザでのログインを待っている間）は、ほかのボタンを押せなくする
let busy = false;
let lastState = null;

function render(state) {
  if (!state) return;
  lastState = state;

  openAtLoginEl.checked = state.openAtLogin;
  openAtLoginEl.disabled = busy;
  openAtLoginNoteEl.hidden = state.isPackaged;

  fillSelect(mascotLookEl, state.look.choices, state.look.id);
  mascotLookEl.disabled = busy;

  fillSelect(geminiModelEl, state.model.choices, state.model.id);
  geminiModelEl.disabled = busy;
  webSearchEl.checked = state.webSearch;
  webSearchEl.disabled = busy;
  keepPastEl.checked = state.keepPast;
  keepPastEl.disabled = busy;

  renderApiKey(state.apiKey);

  const { usage } = state;
  // 高いモデルのままになっていても気づけるよう、今のモデルも並べて出す
  const modelName = state.model.choices.find((choice) => choice.id === state.model.id)?.name ?? state.model.id;
  usageSummaryEl.textContent =
    `今のモデル: ${modelName}\n` +
    `${usage.month}: ${usage.requests.toLocaleString()} 回（今日 ${usage.todayRequests.toLocaleString()} 回）` +
    `・検索 ${usage.searches.toLocaleString()} 回（月 ${usage.searchFree.toLocaleString()} 回まで無料）\n` +
    `トークン ${(usage.sentTokens + usage.replyTokens).toLocaleString()}（送った分 ${usage.sentTokens.toLocaleString()}・返事 ${usage.replyTokens.toLocaleString()}）`;

  renderSound(state.sound);

  const sharing = Boolean(state.historyFolder);
  shareStatusEl.textContent = sharing ? `共有中: ${state.historyFolder}` : '共有していません';
  shareStatusEl.classList.toggle('on', sharing);
  shareChooseEl.disabled = busy;
  shareStopEl.disabled = busy || !sharing;

  const { mode, hasClient, email, signingIn } = state.calendar;
  const signedIn = Boolean(email);
  const using = signedIn && mode !== 'off';
  fillSelect(calendarModeEl, state.calendar.modeChoices, mode);
  calendarModeEl.disabled = busy || !signedIn;
  // 会話で使う分だけ、話しかけるたびに入力が増える。選ぶ前に分かるようにしておく
  calendarModeNoteEl.textContent =
    mode === 'full'
      ? `会話のたびに、予定の道具の説明として約${state.calendar.chatTokens}トークンぶん多く送ります。`
      : '予定の通知は、アプリの中で文章を作るので AI の料金はかかりません。';

  calendarAccountEl.classList.toggle('on', signedIn && !signingIn);
  if (signingIn) calendarAccountEl.textContent = 'ブラウザで Google にログインしてください…';
  else if (signedIn) calendarAccountEl.textContent = `ログイン中: ${email}`;
  else if (!hasClient) calendarAccountEl.textContent = 'ログインしていません（先に、下のクライアント ID のファイルを選んでください）';
  else calendarAccountEl.textContent = 'ログインしていません';
  calendarSignInEl.textContent = signedIn ? 'アカウントを切り替える' : 'Google でログイン';
  calendarSignInEl.disabled = busy || !hasClient;
  calendarSignOutEl.disabled = busy || !signedIn;

  renderRefreshChoices(state.calendar.refreshChoices, state.calendar.refreshMinutes);
  calendarRefreshEl.disabled = busy || !using;

  calendarClientEl.textContent = hasClient ? '選んであります' : 'まだ選んでいません';
  calendarClientEl.classList.toggle('on', hasClient);
  calendarClientChooseEl.disabled = busy;
}

/** 音の設定。選び直すと、その場で保存される */
function renderSound(sound) {
  for (const [slot, els] of Object.entries(soundEls)) {
    const { id, fileName } = sound[slot];
    fillSelect(els.select, sound.choices, id);
    els.select.disabled = busy;
    // 鳴らさないときは、試し聞きしても何も起きないので押せなくする
    els.test.disabled = busy || id === 'none' || (id === 'custom' && !fileName);
    // 「自分の音」を選んだときだけ、ファイルの行を出す
    els.fileRow.hidden = id !== 'custom';
    els.fileName.textContent = fileName || 'まだ選んでいません';
    els.fileName.classList.toggle('on', Boolean(fileName));
    els.choose.disabled = busy;
  }
  fillSelect(soundVolumeEl, sound.volumeChoices, sound.volume);
  soundVolumeEl.disabled = busy;
}

// 「キーをここに貼る」を選んだけれど、まだ保存していない間だけ 'saved'（それ以外は保存されている方に合わせる）
let apiKeyModeWanted = null;

/** API キーの欄。選んでいない方の欄は押せなくして、両方に書かないようにする */
function renderApiKey(apiKey) {
  const mode = apiKeyModeWanted ?? apiKey.mode;
  apiKeyModeEls.env.checked = mode === 'env';
  apiKeyModeEls.saved.checked = mode === 'saved';
  for (const el of Object.values(apiKeyModeEls)) el.disabled = busy;

  const envOn = mode === 'env';
  // 打っている途中の名前は消さない
  if (document.activeElement !== apiKeyEnvNameEl) apiKeyEnvNameEl.value = apiKey.envName;
  apiKeyEnvListEl.replaceChildren(...apiKey.suggestions.map((name) => Object.assign(document.createElement('option'), { value: name })));
  apiKeyEnvNameEl.disabled = busy || !envOn;
  apiKeyEnvUseEl.disabled = busy || !envOn;
  apiKeyEnvStatusEl.hidden = !envOn;
  apiKeyEnvStatusEl.textContent = apiKey.envHint
    ? `${apiKey.envName} を使っています（最後の4文字: ${apiKey.envHint.slice(1)}）`
    : `${apiKey.envName} という環境変数が見つかりません`;
  apiKeyEnvStatusEl.classList.toggle('on', Boolean(apiKey.envHint));

  const savedOn = mode === 'saved';
  apiKeyInputEl.disabled = busy || !savedOn;
  apiKeySaveEl.disabled = busy || !savedOn;
  apiKeyClearEl.disabled = busy || !apiKey.savedHint;
  apiKeySavedStatusEl.textContent = apiKey.savedHint
    ? `保存してあるキー（最後の4文字: ${apiKey.savedHint.slice(1)}）${apiKey.mode === 'saved' ? ' を使っています' : ''}`
    : 'まだ貼っていません';
  apiKeySavedStatusEl.classList.toggle('on', apiKey.mode === 'saved' && Boolean(apiKey.savedHint));
}

function showApiKeyMessage(message) {
  apiKeyMessageEl.textContent = message;
  apiKeyMessageEl.hidden = !message;
}

/** 上のタブ。押した方の中身だけを出す */
function selectTab(panelId) {
  for (const tab of tabEls) {
    const on = tab.dataset.panel === panelId;
    tab.setAttribute('aria-selected', String(on));
    document.getElementById(tab.dataset.panel).hidden = !on;
  }
}

/** 選択肢。中身が同じなら作り直さない（選んでいる所が飛ばないように） */
function fillSelect(select, choices, selected) {
  // 名前も見る。プリセットの名前を変えたときに、選択肢の字も変わるようにするため
  const wanted = choices.map((choice) => `${choice.id}:${choice.name}`).join(',');
  if (select.dataset.choices !== wanted) {
    select.dataset.choices = wanted;
    select.replaceChildren(...choices.map((choice) => new Option(choice.name, String(choice.id))));
  }
  select.value = String(selected);
}

/** 音のファイルを選んでもらい、選べたらそのまま鳴らしてみる */
async function chooseSoundFile(slot) {
  const state = await window.settingsApi.chooseSoundFile(slot);
  if (state.sound[slot].fileName) await testSound(slot);
}

/** 今の設定の音を、そのまま鳴らしてみる */
async function testSound(slot) {
  const state = await window.settingsApi.getSounds();
  playSound(state[slot], state.volume);
}

/** 読み直す間隔の選択肢。中身が同じなら作り直さない（選んでいる所が飛ばないように） */
function renderRefreshChoices(choices, minutes) {
  fillSelect(
    calendarRefreshEl,
    choices.map((choice) => ({ id: choice, name: choice < 60 ? `${choice}分ごと` : `${choice / 60}時間ごと` })),
    minutes,
  );
}

/**
 * 操作が終わるまでボタンを押せないようにしてから呼ぶ（2回押しを防ぐ）。
 * action は、画面を描き直す前に始めること。あとにすると、描き直しでチェックや選択が
 * 元の値に戻ってしまい、選んだばかりの値ではなく古い値を保存してしまう
 */
async function run(action) {
  const running = (async () => action())();
  busy = true;
  render(lastState);
  try {
    await running;
  } finally {
    busy = false;
    render(await window.settingsApi.get());
  }
}

openAtLoginEl.addEventListener('change', () => run(() => window.settingsApi.setOpenAtLogin(openAtLoginEl.checked)));
mascotLookEl.addEventListener('change', () => run(() => window.settingsApi.setMascotLook(mascotLookEl.value)));
geminiModelEl.addEventListener('change', () => run(() => window.settingsApi.setModel(geminiModelEl.value)));
// 環境変数を使う名前にする（空なら GEMINI_API_KEY）
function useEnvName() {
  const name = apiKeyEnvNameEl.value.trim() || 'GEMINI_API_KEY';
  if (!/^\w+$/.test(name)) {
    showApiKeyMessage('環境変数の名前は、英数字と _ だけで書いてください。');
    return;
  }
  apiKeyModeWanted = null;
  run(() => window.settingsApi.setApiKeySource(`env:${name}`));
}
apiKeyEnvUseEl.addEventListener('click', useEnvName);
apiKeyEnvNameEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') useEnvName();
});
apiKeyModeEls.env.addEventListener('change', useEnvName);
apiKeyModeEls.saved.addEventListener('change', () => {
  if (lastState?.apiKey.savedHint) {
    apiKeyModeWanted = null;
    run(() => window.settingsApi.setApiKeySource('saved'));
  } else {
    // まだ貼っていなければ、欄を使えるようにするだけ。保存したときに切り替わる
    apiKeyModeWanted = 'saved';
    render(lastState);
    showApiKeyMessage('キーを貼って「確かめて保存」を押すと、こちらに切り替わります。');
    apiKeyInputEl.focus();
  }
});
apiKeySaveEl.addEventListener('click', () =>
  run(async () => {
    const { ok, message } = await window.settingsApi.saveApiKey(apiKeyInputEl.value);
    // 保存できたら、貼ったキーは欄に残さない
    if (ok) {
      apiKeyInputEl.value = '';
      apiKeyModeWanted = null;
    }
    showApiKeyMessage(message);
  }),
);
apiKeyClearEl.addEventListener('click', () =>
  run(async () => {
    const using = lastState?.apiKey.mode === 'saved';
    await window.settingsApi.clearApiKey();
    apiKeyModeWanted = null;
    showApiKeyMessage(using ? '貼ったキーを消しました。環境変数 GEMINI_API_KEY に戻します。' : '貼ったキーを消しました。');
  }),
);
// 使った量は話すたびに増えるので、設定ウィンドウに戻ってきたときに読み直す
window.addEventListener('focus', async () => {
  if (!busy) render(await window.settingsApi.get());
});
keepPastEl.addEventListener('change', () => run(() => window.settingsApi.setKeepPast(keepPastEl.checked)));
webSearchEl.addEventListener('change', () => run(() => window.settingsApi.setWebSearch(webSearchEl.checked)));

for (const [slot, els] of Object.entries(soundEls)) {
  // 選び直したらすぐ鳴らして、どんな音か分かるようにする
  els.select.addEventListener('change', () =>
    run(async () => {
      const chosen = els.select.value;
      const state = await window.settingsApi.setSound(slot, chosen);
      // 「自分の音」にしたのにファイルがまだなら、そのまま選んでもらう
      if (chosen === 'custom' && !state.sound[slot].fileName) await chooseSoundFile(slot);
      else if (chosen !== 'none') await testSound(slot);
    }),
  );
  els.test.addEventListener('click', () => testSound(slot));
  els.choose.addEventListener('click', () => run(() => chooseSoundFile(slot)));
}
soundVolumeEl.addEventListener('change', () =>
  run(async () => {
    await window.settingsApi.setSoundVolume(soundVolumeEl.value);
    // 変えた大きさで、その場で鳴らして確かめられるようにする
    await testSound('notify');
  }),
);
for (const tab of tabEls) tab.addEventListener('click', () => selectTab(tab.dataset.panel));

shareChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseShareFolder()));
shareStopEl.addEventListener('click', () => run(() => window.settingsApi.stopSharing()));
calendarModeEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarMode(calendarModeEl.value)));
calendarRefreshEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarRefreshMinutes(Number(calendarRefreshEl.value))));
calendarSignInEl.addEventListener('click', () => run(() => window.settingsApi.signInCalendar()));
calendarSignOutEl.addEventListener('click', () => run(() => window.settingsApi.signOutCalendar()));
calendarClientChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseCalendarClient()));

window.settingsApi.onChanged(render);
window.settingsApi.get().then(render);
