'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseCompressCommand,
  targetBytes,
  detectImageType,
  writeUnique,
  encodeToFit,
  posterize,
  readJpegOrientation,
  withOrientation,
  describeResult,
} = require('../image-compress');

test('絶対値の指定を読める（大文字・小文字・全角・MB）', () => {
  assert.deepEqual(parseCompressCommand('500KBにして'), { kind: 'size', bytes: 500 * 1024, label: '500KB以下' });
  assert.deepEqual(parseCompressCommand('500kbにして'), { kind: 'size', bytes: 500 * 1024, label: '500KB以下' });
  assert.deepEqual(parseCompressCommand('５００ＫＢにして'), { kind: 'size', bytes: 500 * 1024, label: '500KB以下' });
  assert.deepEqual(parseCompressCommand('1.5MBにして'), { kind: 'size', bytes: 1.5 * 1024 * 1024, label: '1.5MB以下' });
  assert.equal(parseCompressCommand('300キロにして').bytes, 300 * 1024);
});

test('割合の指定を読める。ファイルごとの元の大きさが基準', () => {
  const half = parseCompressCommand('50%にして');
  assert.deepEqual(half, { kind: 'ratio', ratio: 0.5, label: '元の50%以下' });
  assert.equal(parseCompressCommand('半分にして').ratio, 0.5);
  assert.equal(parseCompressCommand('３０％にして').ratio, 0.3);
  assert.equal(parseCompressCommand('3分の1にして').ratio, 1 / 3);
  assert.equal(targetBytes(half, 1000), 500);
  assert.equal(targetBytes(half, 3000), 1500);
  // 100% 以上は小さくならないので分からない扱い
  assert.equal(parseCompressCommand('150%にして'), null);
});

test('プリセット「メール添付用」は 1MB 以下', () => {
  const mail = parseCompressCommand('メール添付用にして');
  assert.deepEqual(mail, { kind: 'size', bytes: 1024 * 1024, label: 'メール添付用（1MB以下）' });
  assert.equal(targetBytes(mail, 50 * 1024 * 1024), 1024 * 1024);
});

test('やめる・分からない', () => {
  assert.deepEqual(parseCompressCommand('やっぱりやめて'), { kind: 'cancel' });
  assert.equal(parseCompressCommand('いい感じにして'), null);
});

test('形式はファイルの先頭で決める', () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(detectImageType(Buffer.from('GIF89a')), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test('同じ名前があれば (2)、(3) と番号を付け、上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-compress-'));
  const a = writeUnique(dir, 'C:\\photos\\旅行.jpg', Buffer.from('1'));
  const b = writeUnique(dir, 'C:\\photos\\旅行.jpg', Buffer.from('2'));
  const c = writeUnique(dir, 'D:\\別の場所\\旅行.jpg', Buffer.from('3'));
  assert.deepEqual([a, b, c].map((file) => path.basename(file)), ['旅行_圧縮.jpg', '旅行_圧縮(2).jpg', '旅行_圧縮(3).jpg']);
  assert.equal(fs.readFileSync(a, 'utf8'), '1');
});

test('目標に収まる、いちばん高い画質を探す。届かなければ null', async () => {
  const encode = (level) => Buffer.alloc(level * 10);
  assert.equal((await encodeToFit(encode, 555, 10, 95)).length, 550);
  assert.equal(await encodeToFit(encode, 50, 10, 95), null);
});

test('色の段階を減らしても、透明度を超える値にはしない', () => {
  // B, G, R, A の順。1つ目は不透明、2つ目は半透明
  const out = posterize(Buffer.from([0x13, 0x57, 0xff, 0xff, 0x40, 0x3f, 0x10, 0x40]), 2);
  assert.deepEqual([...out], [0x20, 0x60, 0xe0, 0xff, 0x40, 0x20, 0x20, 0x40]);
});

test('JPEG の向き（EXIF）を読み書きできる', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(readJpegOrientation(jpeg), 1);
  const rotated = withOrientation(jpeg, 6);
  assert.equal(readJpegOrientation(rotated), 6);
  assert.equal(withOrientation(jpeg, 1), jpeg);
});

test('結果の報告文', () => {
  const size = parseCompressCommand('500KBにして');
  const item = (name, copied = false) => ({ name, output: name, originalBytes: 2048 * 1024, bytes: 400 * 1024, copied });

  assert.equal(
    describeResult({ total: 3, saved: [item('a.jpg'), item('b.jpg'), item('c.jpg')], failed: [], tooBig: null, remaining: 0 }, size),
    '3枚とも500KB以下にしてデスクトップに置いたよ。',
  );
  assert.equal(
    describeResult({ total: 1, saved: [item('a.jpg')], failed: [], tooBig: null, remaining: 0 }, size),
    '500KB以下にしてデスクトップに置いたよ。（2MB → 400KB）',
  );
  assert.equal(
    describeResult({ total: 3, saved: [item('a.jpg'), item('b.jpg', true)], failed: ['壊れた.jpg'], tooBig: null, remaining: 0 }, size),
    '2枚を500KB以下にしてデスクトップに置いたよ。\n（b.jpg はもともと小さかったから、そのまま置いたよ）\n壊れた.jpg は処理できなかったよ。',
  );
  assert.equal(
    describeResult(
      { total: 4, saved: [item('a.jpg')], failed: [], tooBig: { name: 'b.jpg', target: 10 * 1024 }, remaining: 2 },
      parseCompressCommand('10KBにして'),
    ),
    'b.jpg は画質を一番下げても 10KB に届かなくて、これ以上は難しかった。そこで止めたよ。\nそれまでの1枚はデスクトップに置いたよ。\n残りの2枚はそのままだよ。',
  );
});
