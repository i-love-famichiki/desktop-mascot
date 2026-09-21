'use strict';

// 設定ウィンドウの表示と操作。設定の保存はメインプロセス（main.js の settings:* ）が行う

const $ = (id) => document.getElementById(id);
const openAtLoginEl = $('open-at-login');
const openAtLoginNoteEl = $('open-at-login-note');
const shareStatusEl = $('share-status');
const shareChooseEl = $('share-choose');
const shareStopEl = $('share-stop');
const mascotLookEl = $('mascot-look');
const geminiModelEl = $('gemini-model');
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
const tonePresetEl = $('tone-preset');
const toneNameEl = $('tone-name');
const tonePlainNoteEl = $('tone-plain-note');
const toneAxesEl = $('tone-axes');
const toneNgEl = $('tone-ng');

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

  renderSound(state.sound);
  renderTone(state.tone);

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

// ---------------------------------------------------------------------------
// 口調（6つのつまみと、5つのプリセット）
// ---------------------------------------------------------------------------
// つまみ（スライダー）は state から作る。軸が増えても、ここは直さなくてよい。
// スライダーが持つのは段の番号（0,1,2…）で、保存する値は state の steps から引く。
// 段と段の間には止まれない（止まっても、まめに渡す指示が隣と同じになるため）
const toneAxisEls = new Map();

function renderTone(tone) {
  if (!tone) return;
  buildToneAxes(tone);

  fillSelect(
    tonePresetEl,
    tone.presets.map((preset, index) => ({ id: index, name: `${index + 1}. ${preset.name}` })),
    tone.index,
  );
  tonePresetEl.disabled = busy;

  toneNameEl.maxLength = tone.nameMaxChars;
  // 名前を打っている途中なら、書き換えない（打った字が消えてしまうため）
  if (document.activeElement !== toneNameEl) toneNameEl.value = tone.presets[tone.index].name;
  toneNameEl.disabled = busy;

  // 1番目のプリセットは今までの口調そのまま。つまみは出すが、押せなくする
  const plain = tone.index === tone.plainIndex;
  tonePlainNoteEl.hidden = !plain;
  const { axes } = tone.presets[tone.index];
  for (const [id, els] of toneAxisEls) {
    els.range.value = String(stepIndex(els.steps, axes[id]));
    els.range.disabled = busy || plain;
    showStep(els);
  }
}

/** その値がどの段か。手で書き換えられていても、いちばん近い段を出す */
function stepIndex(steps, value) {
  let best = 0;
  steps.forEach((step, index) => {
    if (Math.abs(step.value - value) < Math.abs(steps[best].value - value)) best = index;
  });
  return best;
}

/** 今の段の番号と、その段の話し方を出す */
function showStep(els) {
  const index = Number(els.range.value);
  els.value.textContent = `${index + 1}/${els.steps.length}`;
  els.note.textContent = els.steps[index].label;
}

/** つまみの行と、NG の一覧を1回だけ作る */
function buildToneAxes(tone) {
  if (toneAxisEls.size > 0) return;
  for (const axis of tone.axes) {
    const row = document.createElement('div');
    row.className = 'axis';

    const name = document.createElement('label');
    name.className = 'axis-name';
    name.htmlFor = `tone-axis-${axis.id}`;
    name.textContent = axis.name;

    // 段の番号を持たせる（0 から段の数-1 まで）。つまみは段ごとにしか止まらない
    const range = document.createElement('input');
    range.type = 'range';
    range.id = `tone-axis-${axis.id}`;
    range.min = '0';
    range.max = String(axis.steps.length - 1);
    range.step = '1';

    const value = document.createElement('span');
    value.className = 'axis-value';

    // 今の段の話し方。軸そのものの説明は、名前にかざしたときに出す
    const note = document.createElement('p');
    note.className = 'axis-note';
    name.title = axis.note;

    const els = { range, value, note, steps: axis.steps };

    // 動かしている間は表示だけ変える。手を離したとき（change）に保存する
    range.addEventListener('input', () => showStep(els));
    range.addEventListener('change', () =>
      run(() => window.settingsApi.setToneAxis(Number(tonePresetEl.value), axis.id, axis.steps[Number(range.value)].value)),
    );

    row.append(name, range, value, note);
    toneAxesEl.append(row);
    toneAxisEls.set(axis.id, els);
  }
  toneNgEl.replaceChildren(
    ...tone.ngItems.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
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
tonePresetEl.addEventListener('change', () => run(() => window.settingsApi.selectTonePreset(Number(tonePresetEl.value))));
// 名前は、ほかの所を押したときか Enter を押したときに保存する（1文字ごとには保存しない）
toneNameEl.addEventListener('change', () => run(() => window.settingsApi.renameTonePreset(Number(tonePresetEl.value), toneNameEl.value)));

shareChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseShareFolder()));
shareStopEl.addEventListener('click', () => run(() => window.settingsApi.stopSharing()));
calendarModeEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarMode(calendarModeEl.value)));
calendarRefreshEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarRefreshMinutes(Number(calendarRefreshEl.value))));
calendarSignInEl.addEventListener('click', () => run(() => window.settingsApi.signInCalendar()));
calendarSignOutEl.addEventListener('click', () => run(() => window.settingsApi.signOutCalendar()));
calendarClientChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseCalendarClient()));

window.settingsApi.onChanged(render);
window.settingsApi.get().then(render);
