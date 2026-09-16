'use strict';

// 返事を少しずつ受け取るときの読み取りのテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSseParser } = require('../sse');

function parseAll(pieces) {
  const events = [];
  const parser = createSseParser((data) => events.push(data));
  pieces.forEach((piece) => parser.push(piece));
  parser.end();
  return events;
}

test('空行ごとに1件ずつ取り出す', () => {
  assert.deepEqual(parseAll(['data: {"a":1}\n\ndata: {"a":2}\n\n']), ['{"a":1}', '{"a":2}']);
});

test('行の途中で切れて届いても、そろってから渡す', () => {
  assert.deepEqual(parseAll(['da', 'ta: {"a"', ':1}\n', '\ndata: x\n\n']), ['{"a":1}', 'x']);
});

test('改行（CR LF）の途中で切れても1件を2件に分けない', () => {
  assert.deepEqual(parseAll(['data: a\r', '\ndata: b\r\n\r\n']), ['a\nb']);
});

test('最後に空行が無くても、終わりで残りを渡す', () => {
  assert.deepEqual(parseAll(['data: last']), ['last']);
});

test('コメント行や data 以外の行は無視する', () => {
  assert.deepEqual(parseAll([': ping\nevent: message\ndata: ok\n\n']), ['ok']);
});
