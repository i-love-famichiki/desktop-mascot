'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { GoogleAuth, GoogleAuthError, parseClientFile, createPkce, emailFromIdToken } = require('../lib/google-auth');

const CLIENT_JSON = JSON.stringify({ installed: { client_id: 'id-123.apps.googleusercontent.com', client_secret: 'secret-xyz' } });

// Windows の暗号化の代わり（中身が平文で残らないことだけ確かめる）
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('hex')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'hex').toString(),
};

// Google が「許可された項目」として返す値
const GRANTED = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events';

const idToken = (email) =>`x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-google-'));
}

/** ブラウザの代わり: ログイン画面の URL を受け取ったら、Google から戻ってきたように 127.0.0.1 へつなぐ */
function fakeBrowser(result = { code: 'the-code' }) {
  const opened = [];
  const openExternal = async (url) => {
    const auth = new URL(url);
    opened.push(auth);
    const back = new URL(auth.searchParams.get('redirect_uri'));
    back.searchParams.set('state', auth.searchParams.get('state'));
    for (const [key, value] of Object.entries(result)) back.searchParams.set(key, value);
    await new Promise((resolve, reject) => http.get(back, (res) => res.resume().on('end', resolve)).on('error', reject));
  };
  return { opened, openExternal };
}

/** Google の鍵の窓口の代わり。送られてきた中身を覚えておく */
function fakeGoogle(responses) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null;
    calls.push({ url: String(url), body });
    const next = typeof responses === 'function' ? responses(String(url), body) : responses.shift();
    return { ok: next.status === undefined || next.status < 400, status: next.status ?? 200, json: async () => next.json ?? {} };
  };
  return { calls, fetch };
}

function setup({ responses, browser = fakeBrowser() } = {}) {
  const dir = tempDir();
  const google = fakeGoogle(responses);
  const auth = new GoogleAuth({
    clientFile: path.join(dir, 'google-client.json'),
    tokenFile: path.join(dir, 'google-token.json'),
    fetch: google.fetch,
    openExternal: browser.openExternal,
    safeStorage: fakeSafeStorage,
  });
  const source = path.join(dir, 'client_secret_download.json');
  fs.writeFileSync(source, CLIENT_JSON);
  auth.importClientFile(source);
  return { dir, auth, google, browser };
}

test('クライアント ID のファイルを読める。ウェブ用や壊れたファイルは理由つきで断る', () => {
  assert.deepEqual(parseClientFile(CLIENT_JSON), { clientId: 'id-123.apps.googleusercontent.com', clientSecret: 'secret-xyz' });
  assert.throws(() => parseClientFile('{ こわれている'), /JSON として読めません/);
  assert.throws(() => parseClientFile(JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } })), /デスクトップ アプリ/);
  assert.throws(() => parseClientFile('{}'), /クライアント ID が入っていない/);
});

test('PKCE の challenge は verifier の SHA-256', () => {
  const { verifier, challenge } = createPkce();
  const expected = require('crypto').createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.equal(emailFromIdToken(idToken('a@example.com')), 'a@example.com');
  assert.equal(emailFromIdToken('こわれている'), '');
});

test('ブラウザでログイン → 鍵を暗号化して保存 → 読み直してもログインしたまま', async () => {
  const { dir, auth, google, browser } = setup({
    responses: [{ json: { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', id_token: idToken('me@gmail.com'), scope: GRANTED } }],
  });
  assert.equal(await auth.signIn(), 'me@gmail.com');

  // ログイン画面には、合言葉（PKCE）と長く使える鍵の指定が付いている
  const opened = browser.opened[0];
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('access_type'), 'offline');
  assert.match(opened.searchParams.get('scope'), /calendar\.events/);
  assert.match(opened.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);

  // 受け取った番号を、合言葉と一緒に鍵へ取り替えている
  const exchange = google.calls[0].body;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.code, 'the-code');
  assert.ok(exchange.code_verifier);
  assert.equal(exchange.redirect_uri, opened.searchParams.get('redirect_uri'));

  // 保存したファイルに、鍵がそのままの形では入っていない
  const saved = fs.readFileSync(path.join(dir, 'google-token.json'), 'utf8');
  assert.ok(!saved.includes('refresh-1'));
  assert.equal(await auth.getAccessToken(), 'access-1');

  const again = new GoogleAuth({ ...auth, clientFile: auth.clientFile, tokenFile: auth.tokenFile, fetch: google.fetch, safeStorage: fakeSafeStorage });
  again.load();
  assert.equal(again.email, 'me@gmail.com');
  assert.equal(again.account.refreshToken, 'refresh-1');
});

test('Google の画面でカレンダーのチェックを外されたら、ログインさせずに理由を伝える', async () => {
  const { auth, google } = setup({
    responses: [
      { json: { access_token: 'a', expires_in: 3600, refresh_token: 'r-no-cal', id_token: idToken('me@gmail.com'), scope: 'openid email' } },
      { json: {} },
    ],
  });
  await assert.rejects(auth.signIn(), (err) => err.kind === 'no-scope' && /チェック/.test(err.message));
  assert.equal(auth.account, null);
  assert.ok(!fs.existsSync(auth.tokenFile));
  // もらってしまった鍵は取り消す
  assert.ok(google.calls[1].url.includes('/revoke'));
});

test('ブラウザで取りやめたら canceled。ログインしていない状態のまま', async () => {
  const { auth } = setup({ responses: [], browser: fakeBrowser({ error: 'access_denied' }) });
  await assert.rejects(auth.signIn(), (err) => err instanceof GoogleAuthError && err.kind === 'canceled');
  assert.equal(auth.account, null);
});

test('期限が切れた鍵は取り替える。取り消されていたらログアウトの扱い', async () => {
  const { auth, google } = setup({
    responses: [
      { json: { access_token: 'old', expires_in: 0, refresh_token: 'refresh-1', id_token: idToken('me@gmail.com'), scope: GRANTED } },
      { json: { access_token: 'fresh', expires_in: 3600 } },
      { status: 400, json: { error: 'invalid_grant' } },
    ],
  });
  await auth.signIn();
  assert.equal(await auth.getAccessToken(), 'fresh');
  assert.equal(google.calls[1].body.grant_type, 'refresh_token');

  auth.accessTokenExpiresAt = 0;
  await assert.rejects(auth.getAccessToken(), (err) => err.kind === 'signed-out');
  assert.equal(auth.account, null);
  assert.ok(!fs.existsSync(auth.tokenFile));
});

test('アカウントを切り替えたら前の鍵を取り消す。ログアウトでも取り消す', async () => {
  const { auth, google } = setup({
    responses: (url) => {
      if (url.includes('/revoke')) return { json: {} };
      const n = google.calls.filter((call) => call.body?.grant_type === 'authorization_code').length;
      return { json: { access_token: `a${n}`, expires_in: 3600, refresh_token: `r${n}`, id_token: idToken(`user${n}@gmail.com`), scope: GRANTED } };
    },
  });
  assert.equal(await auth.signIn(), 'user1@gmail.com');
  assert.equal(await auth.signIn(), 'user2@gmail.com');
  const revoked = () => google.calls.filter((call) => call.url.includes('/revoke')).map((call) => new URL(call.url).searchParams.get('token'));
  assert.deepEqual(revoked(), ['r1']);

  await auth.signOut();
  assert.deepEqual(revoked(), ['r1', 'r2']);
  assert.equal(auth.email, '');
  assert.ok(!fs.existsSync(auth.tokenFile));
});

test('同じアカウントでログインし直したときは、前の鍵を取り消さない（許可ごと消えて、新しい鍵やほかの豆の鍵まで使えなくなるため）', async () => {
  const { auth, google } = setup({
    responses: (url) => {
      if (url.includes('/revoke')) return { json: {} };
      const n = google.calls.filter((call) => call.body?.grant_type === 'authorization_code').length;
      return { json: { access_token: `a${n}`, expires_in: 3600, refresh_token: `r${n}`, id_token: idToken('me@gmail.com'), scope: GRANTED } };
    },
  });
  await auth.signIn();
  await auth.signIn();
  assert.equal(google.calls.filter((call) => call.url.includes('/revoke')).length, 0);
  assert.equal(auth.account.refreshToken, 'r2');
});

test('クライアント ID のファイルを選ぶ前は、ログインできない', async () => {
  const dir = tempDir();
  const auth = new GoogleAuth({
    clientFile: path.join(dir, 'none.json'),
    tokenFile: path.join(dir, 't.json'),
    fetch: async () => assert.fail('通信しない'),
    openExternal: async () => assert.fail('ブラウザを開かない'),
    safeStorage: fakeSafeStorage,
  });
  assert.equal(auth.hasClient(), false);
  await assert.rejects(auth.signIn(), (err) => err.kind === 'no-client');
  await assert.rejects(auth.getAccessToken(), (err) => err.kind === 'signed-out');
});

test('クライアント ID は暗号化して保存する（生のままファイルに残さない）', () => {
  const { dir, auth } = setup();
  const clientFile = path.join(dir, 'google-client.json');
  const saved = fs.readFileSync(clientFile, 'utf8');

  assert.ok(!saved.includes('secret-xyz'), '秘密の値がそのまま残っている');
  assert.ok(!saved.includes('id-123'), 'クライアント ID がそのまま残っている');
  assert.ok(JSON.parse(saved).client.length > 0);
  // 暗号化してあっても、読み直せば元に戻る
  assert.deepEqual(auth.readClient(), { clientId: 'id-123.apps.googleusercontent.com', clientSecret: 'secret-xyz' });
});

test('前の版が平文で置いたファイルも読めて、読んだついでに暗号化に置き換わる', () => {
  const { dir, auth } = setup();
  const clientFile = path.join(dir, 'google-client.json');
  // 1.0.12 より前の置き方に戻す
  fs.writeFileSync(clientFile, CLIENT_JSON, 'utf8');

  assert.deepEqual(auth.readClient(), { clientId: 'id-123.apps.googleusercontent.com', clientSecret: 'secret-xyz' });
  assert.ok(!fs.readFileSync(clientFile, 'utf8').includes('secret-xyz'), '平文のまま残っている');
  // 置き換えたあとも読める
  assert.equal(auth.readClient().clientSecret, 'secret-xyz');
});

test('暗号化できない PC では平文で置く（読めなくなるよりよい）', () => {
  const dir = tempDir();
  const clientFile = path.join(dir, 'google-client.json');
  const auth = new GoogleAuth({
    clientFile,
    tokenFile: path.join(dir, 't.json'),
    fetch: async () => assert.fail('通信しない'),
    openExternal: async () => assert.fail('ブラウザを開かない'),
    safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false },
  });
  const source = path.join(dir, 'client_secret_download.json');
  fs.writeFileSync(source, CLIENT_JSON);
  auth.importClientFile(source);

  assert.equal(fs.readFileSync(clientFile, 'utf8'), CLIENT_JSON);
  assert.equal(auth.readClient().clientSecret, 'secret-xyz');
});

test('暗号化した中身が壊れていたら、選び直すよう伝える', () => {
  const { dir, auth } = setup();
  fs.writeFileSync(path.join(dir, 'google-client.json'), JSON.stringify({ client: 'こわれた値' }), 'utf8');
  assert.throws(() => auth.readClient(), (err) => err instanceof GoogleAuthError && /選び直して/.test(err.message));
});
