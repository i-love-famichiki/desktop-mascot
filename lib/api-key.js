'use strict';

// Gemini の API キー。どれを使うかは設定画面で選ぶ:
//   ・環境変数のキー（名前は自由。初期値は GEMINI_API_KEY）
//   ・設定画面で入れたキー（Windows の仕組み safeStorage で暗号化してファイルに置く）
// Electron に依存しないので、node だけでテストできる（test/api-key.test.js）。
//
// なぜ設定画面で入れられるようにするか: コマンド プロンプトで setx を打つのは、慣れていない人には一番の壁だったため。
// なぜ環境変数を選べるか: 有料枠のキーと無料枠のキーを、環境変数に分けて入れておき、切り替えて使うため。
// 環境変数の名前は自由に入れられる。ただ候補として出すのは、名前に GEMINI が付くものだけ
// （ほかのアプリの秘密かもしれない名前を、こちらから見せない）。
//
// ファイル（gemini-key.json）の形:  { "key": "<safeStorage で暗号化して base64 にしたもの>" }
// 共有フォルダには置かない（暗号化はこの PC のこの Windows ユーザーでしか解けないので、置いても使えない）。

const fs = require('fs');
const path = require('path');

// 選び方の名前。環境変数は 'env:GEMINI_API_KEY' の形
const SAVED_SOURCE = 'saved';
const DEFAULT_SOURCE = 'env:GEMINI_API_KEY';
const GEMINI_NAME = /GEMINI/i;
const ENV_NAME = /^\w+$/;

class ApiKeyStore {
  /**
   * @param {{ file: string, env: Record<string, string | undefined>,
   *           safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} options
   */
  constructor({ file, env, safeStorage }) {
    this.file = file;
    this.env = env;
    this.safeStorage = safeStorage;
    /** 設定画面で入れたキー（無ければ空） */
    this.saved = '';
  }

  /** ファイルから読む。無い・壊れている・この PC では解けないときは、入れていない扱いにする */
  load() {
    this.saved = '';
    let box;
    try {
      box = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[api-key] キーのファイルが読めませんでした:', err.message);
      return;
    }
    try {
      this.saved = this.safeStorage.decryptString(Buffer.from(String(box?.key ?? ''), 'base64')).trim();
    } catch (err) {
      console.error('[api-key] キーを解けませんでした（ほかの PC や Windows ユーザーで保存したもの？）:', err.message);
    }
  }

  /** 候補に出す環境変数の名前（名前に GEMINI が付き、中身があるもの）。GEMINI_API_KEY を先頭にする */
  envNames() {
    return Object.keys(this.env)
      .filter((name) => GEMINI_NAME.test(name) && ENV_NAME.test(name) && (this.env[name] ?? '').trim())
      .sort((a, b) => (a === 'GEMINI_API_KEY' ? -1 : b === 'GEMINI_API_KEY' ? 1 : a.localeCompare(b)));
  }

  /** 選んだところのキー。無ければ空 */
  get(source) {
    if (source === SAVED_SOURCE) return this.saved;
    const name = ApiKeyStore.envName(source);
    return name ? (this.env[name] ?? '').trim() : '';
  }

  /** 'env:名前' から環境変数の名前を取り出す。形が違えば空 */
  static envName(source) {
    const name = String(source ?? '').startsWith('env:') ? String(source).slice(4) : '';
    return ENV_NAME.test(name) ? name : '';
  }

  /** 画面に出す短い目印（最後の4文字だけ）。キーが無ければ空 */
  hint(source) {
    const key = this.get(source);
    return key ? `…${key.slice(-4)}` : '';
  }

  /** 設定画面で入れたキーを保存する。暗号化できない PC では、平文で置かずに失敗させる */
  save(key) {
    const text = String(key ?? '').trim();
    if (!text) throw new Error('キーが空です');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('この PC ではキーを暗号化して保存できません');
    const body = JSON.stringify({ key: this.safeStorage.encryptString(text).toString('base64') }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 書きかけで壊れないよう、別名に書いてから置き換える
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, this.file);
    this.saved = text;
  }

  /** 設定画面で入れたキーを消す */
  clear() {
    fs.rmSync(this.file, { force: true });
    this.saved = '';
  }
}

module.exports = { ApiKeyStore, SAVED_SOURCE, DEFAULT_SOURCE };
