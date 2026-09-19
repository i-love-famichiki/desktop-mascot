'use strict';

// 設定ウィンドウの表示と操作。設定の保存はメインプロセス（main.js の settings:* ）が行う

const $ = (id) => document.getElementById(id);
const openAtLoginEl = $('open-at-login');
const openAtLoginNoteEl = $('open-at-login-note');
const shareStatusEl = $('share-status');
const shareChooseEl = $('share-choose');
const shareStopEl = $('share-stop');
const calendarEnabledEl = $('calendar-enabled');
const calendarAccountEl = $('calendar-account');
const calendarSignInEl = $('calendar-sign-in');
const calendarSignOutEl = $('calendar-sign-out');
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

  calendarClientEl.textContent = hasClient ? '選んであります' : 'まだ選んでいません';
  calendarClientEl.classList.toggle('on', hasClient);
  calendarClientChooseEl.disabled = busy;
}

/** 操作が終わるまでボタンを押せないようにしてから呼ぶ（2回押しを防ぐ） */
async function run(action) {
  busy = true;
  render(lastState);
  try {
    await action();
  } finally {
    busy = false;
    render(await window.settingsApi.get());
  }
}

openAtLoginEl.addEventListener('change', () => run(() => window.settingsApi.setOpenAtLogin(openAtLoginEl.checked)));
shareChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseShareFolder()));
shareStopEl.addEventListener('click', () => run(() => window.settingsApi.stopSharing()));
calendarEnabledEl.addEventListener('change', () => run(() => window.settingsApi.setCalendarEnabled(calendarEnabledEl.checked)));
calendarSignInEl.addEventListener('click', () => run(() => window.settingsApi.signInCalendar()));
calendarSignOutEl.addEventListener('click', () => run(() => window.settingsApi.signOutCalendar()));
calendarClientChooseEl.addEventListener('click', () => run(() => window.settingsApi.chooseCalendarClient()));

window.settingsApi.onChanged(render);
window.settingsApi.get().then(render);
