'use strict';

/**
 * 少しずつ届く Server-Sent Events（"data: ..." の行が空行で区切られた形）を読み、
 * 1件そろうごとに data の中身を onData に渡す。
 * 届く切れ目は行の途中や改行コード（\r\n）の途中にもなるので、行が完成するまでためておく。
 * @param {(data: string) => void} onData
 */
function createSseParser(onData) {
  let buffer = '';
  let dataLines = [];

  function handleLine(line) {
    if (line === '') {
      if (dataLines.length > 0) onData(dataLines.join('\n'));
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return; // コメント行
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  }

  return {
    push(text) {
      buffer += text;
      // 末尾の \r は、次に \n が続くかもしれないので区切りにしない
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop();
      lines.forEach(handleLine);
    },
    end() {
      if (buffer) handleLine(buffer.replace(/\r$/, ''));
      buffer = '';
      handleLine('');
    },
  };
}

module.exports = { createSseParser };
