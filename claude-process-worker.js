'use strict';

// claude の起動（spawn）はウイルス対策ソフトの検査などで数秒ブロックすることがある。
// Electron のメインプロセスを固まらせないよう、起動と入出力はこのワーカースレッドで行う。
const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');
const readline = require('readline');

const { command, args, cwd, env } = workerData;

let finished = false;
function finish(message) {
  if (finished) return;
  finished = true;
  parentPort.postMessage(message);
  parentPort.close();
}

const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stderrTail = '';
// 落ちたプロセスへの書き込みエラーは exit 側でまとめて扱う
child.stdin.on('error', () => {});
child.stderr.setEncoding('utf8').on('data', (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-2000);
});

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // 途中経過（init や assistant の断片など）は使わず、ターンの最後に来る result だけを渡す
  if (message.type === 'result') parentPort.postMessage({ type: 'result', result: message });
});

child.on('error', (err) => finish({ type: 'error', code: err.code, message: err.message }));
child.on('exit', (code) => finish({ type: 'exit', code, stderr: stderrTail.trim() }));

parentPort.on('message', (message) => {
  if (message.type === 'write') {
    child.stdin.write(message.data);
  } else if (message.type === 'stop' && child.exitCode === null) {
    child.stdin.end();
    child.kill();
  }
});
