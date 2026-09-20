'use strict';

// 設定ウィンドウの表示と操作。設定の保存はメインプロセス（main.js の settings:* ）が行う

const $ = (id) => document.getElementById(id);
const openAtLoginEl = $('open-at-login');
const openAtLoginNoteEl = $('open-at-login-note');
const shareStatusEl = $('share-status');
const shareChooseEl = $('share-choose');
const shareStopEl = $('share-stop');
const mascotLookEl = $('mascot-look');
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
const calendarEnabledEl = $('calendar-enabled');
const calendarAccountEl = $('calendar-account');
const calendarSignInEl = $('calendar-sign-in');
const calendarSignOutEl = $('calendar-sign-out');
const calendarRefreshEl = $('calendar-refresh');
const calendarClientEl = $('calendar-client');
const calendarClientChooseEl = $('calendar-client-choose');

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

  renderSound(state.sound);

  const sharing = Boolean(state.historyFolder);
  shareStatusEl.textContent = sharing ? `共有中: ${state.historyFolder}` : '共有していません';
  shareStatusEl.classList.toggle('on', sharing);
  shareChooseEl.disabled = busy;
  shareStopEl.disabled = busy || !sharing;

  const { enabled, hasClient, email, signingIn } = state.calendar;
  const signedIn = Boolean(email);
  calendarEnabledEl.checked = enabled;
  calendarEnabledEl.disabled = busy || !signedIn;

  calendarAccountEl.classList.toggle('on', signedIn && !signingIn);
  if (signingIn) calendarAccountEl.textContent = 'ブラウザで Google にログインしてください…';
  else if (signedIn) calendarAccountEl.textContent = `ログイン中: ${email}`;
  else if (!hasClient) calendarAccountEl.textContent = 'ログインしていません（先に、下のクライアント ID のファイルを選んでください）';
  else calendarAccountEl.textContent = 'ログインしていません';
  calendarSignInEl.textContent = signedIn ? 'アカウントを切り替える' : 'Google でログイン';
  calendarSignInEl.disabled = busy || !hasClient;
  calendarSignOutEl.disabled = busy || !signedIn;

  renderRefreshChoices(state.calendar.refreshChoices, state.calendar.refreshMinutes);
  calendarRefreshEl.disabled = busy || !enabled;

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

/** 選択肢。中身が同じなら作り直さない（選んでいる所が飛ばないように） */
function fillSelect(select, choices, selected) {
  const wanted = choices.map((choice) => choice.id).join(',');
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
shareChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseShareFolder()));
shareStopEl.addEventListener('click', () => run(() => window.settingsApi.stopSharing()));
calendarEnabledEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarEnabled(calendarEnabledEl.checked)));
calendarRefreshEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarRefreshMinutes(Number(calendarRefreshEl.value))));
calendarSignInEl.addEventListener('click', () => run(() => window.settingsApi.signInCalendar()));
calendarSignOutEl.addEventListener('click', () => run(() => window.settingsApi.signOutCalendar()));
calendarClientChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseCalendarClient()));

window.settingsApi.onChanged(render);
window.settingsApi.get().then(render);
