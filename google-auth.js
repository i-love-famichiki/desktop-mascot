'use strict';

// Google アカウントでログインして、カレンダーを使うための鍵（アクセストークン）をもらう。
// パッケージは使わず、Google が決めている「パソコンのアプリ向けのログイン方法」で行う:
//   1. この PC の中だけで待ち受ける小さなサーバー（127.0.0.1）を立てる
//   2. 既定のブラウザで Google のログイン画面を開く
//   3. 許可されると、ブラウザが 1 のサーバーへ戻ってくるので、受け取った番号を鍵に取り替える
//
// 長く使える鍵（リフレッシュトークン）は、Windows の仕組み（safeStorage）で暗号化してファイルに置く。
// Electron の部品（shell や safeStorage、通信の fetch）は呼び出す側から渡してもらうので、
// 読み込むだけなら node でも動く（test/google-auth.test.js）。

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
// メールアドレス（どのアカウントか表示する）と、カレンダーの予定の読み書き
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const SCOPES = ['openid', 'email', CALENDAR_SCOPE];
// ブラウザでログインし終わるのを待つ時間
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// 鍵の期限が切れる少し前に取り替える
const EXPIRY_MARGIN_MS = 60 * 1000;

class GoogleAuthError extends Error {
  /** @param {'no-client' | 'bad-client' | 'signed-out' | 'canceled' | 'no-scope' | 'timeout' | 'failed'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Google Cloud でダウンロードした JSON（client_secret_….json）から、クライアント ID と秘密の値を取り出す。
 * デスクトップ アプリ用は "installed"、まちがえて作ったウェブ用は "web" の下に入っている
 */
function parseClientFile(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new GoogleAuthError('bad-client', 'JSON として読めませんでした');
  }
  if (data?.web) throw new GoogleAuthError('bad-client', '「ウェブ アプリケーション」用のファイルです。「デスクトップ アプリ」で作り直してください');
  const client = data?.installed;
  if (typeof client?.client_id !== 'string' || typeof client?.client_secret !== 'string') {
    throw new GoogleAuthError('bad-client', 'クライアント ID が入っていないファイルです');
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

/** ログインの途中で横取りされないための合言葉（PKCE）。verifier は手元に残し、challenge だけ送る */
function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // 長く使える鍵をもらう。アカウントを選び直せるよう、毎回アカウント選びから始める
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Google から届いた id_token の中のメールアドレス（Google と直接やりとりして受け取ったものなので、署名は確かめない） */
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : '';
  } catch {
    return '';
  }
}

/** ブラウザに見せる、ログインの結果のページ */
function resultPage(message) {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>Desktop Mascot</title>
<body style="font-family:'Yu Gothic UI',Meiryo,sans-serif;text-align:center;padding:48px;color:#2b2b2b;background:#fbfaf6">
<p style="font-size:18px">${escaped}</p><p style="color:#777">このタブは閉じて大丈夫です。</p></body>`;
}

/**
 * この PC の中だけで待ち受けて、Google のログイン画面から戻ってくるのを待つ。
 * @returns {Promise<{ redirectUri: string, code: Promise<string>, close: () => void }>}
 */
async function listenForCode(state) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // ブラウザが戻ってくるのが、待ち始めるより先になることもある。そのときの失敗も、あとで受け取る
  code.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const send = (message) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(message));
    if (url.searchParams.get('state') !== state) {
      send('ログインの確認に失敗しました。豆の設定画面からもう一度試してください。');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      send('ログインを取りやめました。');
      settle.reject(new GoogleAuthError('canceled', error));
      return;
    }
    send('ログインできました。豆のところに戻ってください。');
    settle.resolve(url.searchParams.get('code'));
  });
  // 外からはつながらないよう、この PC の中（127.0.0.1）だけで、空いている番号を使う
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => settle.reject(new GoogleAuthError('timeout', 'ログインが時間内に終わりませんでした')), SIGN_IN_TIMEOUT_MS);
  return {
    redirectUri: `http://127.0.0.1:${server.address().port}`,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    },
  };
}

class GoogleAuth {
  /**
   * @param {{ clientFile: string, tokenFile: string, fetch: typeof fetch, openExternal: (url: string) => Promise<void>,
   *           safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} options
   */
  constructor({ clientFile, tokenFile, fetch, openExternal, safeStorage }) {
    this.clientFile = clientFile;
    this.tokenFile = tokenFile;
    this.fetch = fetch;
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    /** @type {{ refreshToken: string, email: string } | null} */
    this.account = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.signingIn = null;
  }

  /** 保存してあるログイン情報を読む。無い・読めないときはログインしていない扱い */
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      const refreshToken = this.safeStorage.decryptString(Buffer.from(saved.refreshToken, 'base64'));
      this.account = { refreshToken, email: String(saved.email ?? '') };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[google] ログイン情報が読めなかったので、ログインしていない扱いにします:', err.message);
      this.account = null;
    }
  }

  hasClient() {
    return fs.existsSync(this.clientFile);
  }

  /** 設定画面で選んだ JSON を確かめてから、アプリの保存場所に写す */
  importClientFile(sourcePath) {
    const text = fs.readFileSync(sourcePath, 'utf8');
    parseClientFile(text);
    fs.mkdirSync(path.dirname(this.clientFile), { recursive: true });
    fs.writeFileSync(this.clientFile, text, 'utf8');
  }

  readClient() {
    let text;
    try {
      text = fs.readFileSync(this.clientFile, 'utf8');
    } catch {
      throw new GoogleAuthError('no-client', 'クライアント ID のファイルが選ばれていません');
    }
    return parseClientFile(text);
  }

  get email() {
    return this.account?.email ?? '';
  }

  /** ブラウザで Google にログインする。前のアカウントがあれば、新しいアカウントに置き換える */
  signIn() {
    // 2回押されても、ログイン画面は1つだけ
    this.signingIn ??= this.#signIn().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  async #signIn() {
    const client = this.readClient();
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new GoogleAuthError('failed', 'この PC ではログイン情報を暗号化して保存できません');
    }
    const { verifier, challenge } = createPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    const listener = await listenForCode(state);
    try {
      await this.openExternal(buildAuthUrl({ clientId: client.clientId, redirectUri: listener.redirectUri, challenge, state }));
      const code = await listener.code;
      const tokens = await this.#requestToken(client, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
      });
      if (!tokens.refresh_token) throw new GoogleAuthError('failed', '長く使える鍵がもらえませんでした');
      // Google のログイン画面では、許可する項目を1つずつ選べる。カレンダーの項目が外されていたら使えない
      if (!String(tokens.scope ?? '').split(' ').includes(CALENDAR_SCOPE)) {
        await this.#revoke(tokens.refresh_token);
        throw new GoogleAuthError(
          'no-scope',
          'カレンダーへのアクセスが許可されていませんでした。もう一度ログインして、Google の画面でカレンダーの項目にチェックを入れてください。',
        );
      }

      const previous = this.account;
      this.account = { refreshToken: tokens.refresh_token, email: emailFromIdToken(tokens.id_token) };
      this.#keepAccessToken(tokens);
      this.#save();
      // 切り替える前のアカウントの鍵は、もう使わないので取り消しておく
      if (previous && previous.refreshToken !== tokens.refresh_token) this.#revoke(previous.refreshToken);
      return this.email;
    } finally {
      listener.close();
    }
  }

  /** ログアウト。Google 側の鍵も取り消す */
  async signOut() {
    const previous = this.account;
    this.account = null;
    this.accessToken = null;
    fs.rmSync(this.tokenFile, { force: true });
    if (previous) await this.#revoke(previous.refreshToken);
  }

  /** カレンダーを呼ぶための鍵。期限が近ければ取り替える */
  async getAccessToken() {
    if (!this.account) throw new GoogleAuthError('signed-out', 'Google にログインしていません');
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - EXPIRY_MARGIN_MS) return this.accessToken;
    let tokens;
    try {
      tokens = await this.#requestToken(this.readClient(), { grant_type: 'refresh_token', refresh_token: this.account.refreshToken });
    } catch (err) {
      // 取り消された・期限切れのときは、ログインし直してもらう
      if (err.invalidGrant) {
        this.account = null;
        fs.rmSync(this.tokenFile, { force: true });
        throw new GoogleAuthError('signed-out', 'Google のログインが切れました');
      }
      throw err;
    }
    this.#keepAccessToken(tokens);
    return this.accessToken;
  }

  #keepAccessToken(tokens) {
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + Number(tokens.expires_in ?? 0) * 1000;
  }

  async #requestToken(client, params) {
    let res;
    try {
      res = await this.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }).toString(),
        signal: AbortSignal.timeout(30 * 1000),
      });
    } catch (err) {
      throw new GoogleAuthError('failed', `Google につながりませんでした: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new GoogleAuthError('failed', `鍵をもらえませんでした: ${data.error ?? res.status} ${data.error_description ?? ''}`);
      error.invalidGrant = data.error === 'invalid_grant';
      throw error;
    }
    return data;
  }

  async #revoke(token) {
    try {
      await this.fetch(`${REVOKE_ENDPOINT}?${new URLSearchParams({ token })}`, { method: 'POST', signal: AbortSignal.timeout(10 * 1000) });
    } catch (err) {
      console.warn('[google] 古い鍵を取り消せませんでした:', err.message);
    }
  }

  #save() {
    const data = {
      email: this.account.email,
      refreshToken: this.safeStorage.encryptString(this.account.refreshToken).toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.tokenFile);
  }
}

module.exports = { GoogleAuth, GoogleAuthError, parseClientFile, createPkce, buildAuthUrl, emailFromIdToken, listenForCode, SCOPES };
