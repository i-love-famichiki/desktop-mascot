'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

class ClaudeCliError extends Error {
  /** @param {'not-found' | 'timeout' | 'exited' | 'failed'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * 起動したままの claude 1 プロセスとのやり取り。
 * CLI は起動に数十秒かかるので、`claude -p --input-format stream-json` で常駐させて
 * 発言を stdin に1行ずつ流し込み、stdout の result 行を返事として受け取る。
 * 会話の文脈はこのプロセスの中に溜まっていくので、区切りたいときは作り直す。
 * プロセスの起動と入出力は claude-process-worker.js（別スレッド）が受け持つ。
 */
class ClaudeSession {
  /**
   * @param {object} options
   * @param {string} options.command 実行する claude コマンド
   * @param {string[]} options.args モデルやシステムプロンプトなどの追加引数
   * @param {string} options.cwd
   * @param {NodeJS.ProcessEnv} options.env
   * @param {number} options.timeoutMs 1回の返事を待つ上限（起動待ちを含む）
   */
  constructor(options) {
    this.options = options;
    /** @type {Worker | null} */
    this.worker = null;
    this.alive = false;
    this.startedAt = 0;
    // このプロセスで返事をもらえた回数
    this.turns = 0;
    /** @type {{ resolve: (text: string) => void, reject: (err: Error) => void, timer: NodeJS.Timeout } | null} */
    this.pending = null;
  }

  get busy() {
    return this.pending !== null;
  }

  start() {
    const { command, args, cwd, env } = this.options;
    this.startedAt = Date.now();
    this.alive = true;

    this.worker = new Worker(path.join(__dirname, 'claude-process-worker.js'), {
      workerData: {
        command,
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...args],
        cwd,
        env,
      },
    });

    this.worker.on('message', (message) => {
      if (message.type === 'result') {
        this.handleResult(message.result);
      } else if (message.type === 'error') {
        this.alive = false;
        this.fail(
          message.code === 'ENOENT'
            ? new ClaudeCliError('not-found', `${command} が見つかりません`)
            : new ClaudeCliError('failed', message.message),
        );
      } else if (message.type === 'exit') {
        this.alive = false;
        this.fail(new ClaudeCliError('exited', `claude が終了しました exit=${message.code} ${message.stderr}`));
      }
    });

    this.worker.on('error', (err) => {
      this.alive = false;
      this.fail(new ClaudeCliError('failed', err.message));
    });
  }

  /** 発言を1つ送り、返事の本文を返す。起動直後に呼んでも、起動が終わるまで待ってから返る。 */
  ask(text) {
    if (!this.alive) {
      return Promise.reject(new ClaudeCliError('failed', 'claude が起動していません'));
    }
    if (this.pending) {
      return Promise.reject(new ClaudeCliError('failed', '前の返事を待っている途中です'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new ClaudeCliError('timeout', `${this.options.timeoutMs}ms 以内に応答がありませんでした`));
        // 固まっている可能性があるので、このプロセスはもう使わない
        this.stop();
      }, this.options.timeoutMs);

      this.pending = { resolve, reject, timer };
      const message = { type: 'user', message: { role: 'user', content: text } };
      this.worker.postMessage({ type: 'write', data: `${JSON.stringify(message)}\n` });
    });
  }

  stop() {
    this.alive = false;
    this.fail(new ClaudeCliError('failed', 'claude を停止しました'));
    if (this.worker) this.worker.postMessage({ type: 'stop' });
  }

  handleResult(message) {
    if (!this.pending) return;

    const result = typeof message.result === 'string' ? message.result.trim() : '';
    if (message.is_error || !result) {
      this.fail(new ClaudeCliError('failed', `subtype=${message.subtype} result=${message.result}`));
      return;
    }

    this.turns += 1;
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve(result);
  }

  fail(err) {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    reject(err);
  }
}

module.exports = { ClaudeSession, ClaudeCliError };
