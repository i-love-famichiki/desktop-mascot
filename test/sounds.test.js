'use strict';

// 音の設定のテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { soundChoices, findSound, isSoundId, isVolumeId, volumeById, safeFileName, importSoundFile, playable, SoundError } = require('../sounds');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-sounds-'));
}

test('選べる音は「鳴らさない」で始まり「自分の音」で終わる', () => {
  const ids = soundChoices().map((choice) => choice.id);
  assert.equal(ids[0], 'none');
  assert.equal(ids.at(-1), 'custom');
  assert.ok(ids.includes('chime'));
  // 名前が重なっていない
  assert.equal(new Set(ids).size, ids.length);
  for (const { name } of soundChoices()) assert.ok(name.length > 0);
});

test('設定に書ける音の名前かどうかを見分ける', () => {
  for (const id of ['none', 'custom', 'chime', 'bell', 'pop', 'knock', 'piro']) assert.ok(isSoundId(id), id);
  for (const id of ['', 'ポロン', 'CHIME', null, undefined, 1]) assert.ok(!isSoundId(id), String(id));
});

test('音の大きさ。知らない名前ならふつう', () => {
  assert.ok(isVolumeId('small') && isVolumeId('medium') && isVolumeId('large'));
  assert.ok(!isVolumeId('ちいさい'));
  assert.equal(volumeById('こわれた値').id, 'medium');
  // その場で作る音より、自分の音のほうを大きめに鳴らす
  for (const id of ['small', 'medium', 'large']) assert.ok(volumeById(id).file > volumeById(id).notes);

  for (const kind of ['notes', 'file']) {
    const [small, medium, large] = ['small', 'medium', 'large'].map((id) => volumeById(id)[kind]);
    // 耳で分かるよう、1段ごとに2倍より大きく変える
    assert.ok(medium / small >= 2, `${kind} の小さめ→ふつう`);
    assert.ok(large / medium >= 2, `${kind} の ふつう→大きめ`);
    // 大きすぎると音が割れる（重なって鳴る音があるので、内蔵の音は 0.6 まで）
    assert.ok(large <= (kind === 'notes' ? 0.6 : 1), `${kind} の大きめ`);
  }
});

test('内蔵の音は、鳴らせる楽譜になっている', () => {
  for (const { id } of soundChoices().filter((choice) => choice.id !== 'none' && choice.id !== 'custom')) {
    const sound = findSound(id);
    assert.ok(['sine', 'triangle', 'square', 'sawtooth'].includes(sound.wave), id);
    assert.ok(sound.notes.length > 0, id);
    for (const note of sound.notes) {
      assert.ok(note.hz > 20 && note.hz < 20000, `${id} の高さ`);
      assert.ok(note.at >= 0 && note.dur > 0, `${id} の長さ`);
    }
    // 長すぎる音は、お知らせに使いにくい
    const last = Math.max(...sound.notes.map((note) => note.at + note.dur));
    assert.ok(last <= 1.5, `${id} は ${last} 秒`);
  }
});

test('ファイル名に使えない字は置き換え、長い名前は短くする', () => {
  assert.equal(safeFileName('ぽよん.MP3'), 'ぽよん.mp3');
  assert.equal(safeFileName('あa?b*c<d>.wav'), 'あa_b_c_d_.wav');
  assert.equal(safeFileName(`${'あ'.repeat(200)}.ogg`), `${'あ'.repeat(60)}.ogg`);
});

test('選ばれた音のファイルはアプリの中にコピーし、選び直したら前のは消す', () => {
  const dir = path.join(tempDir(), 'notify');
  const source = path.join(tempDir(), 'ぽよん.mp3');
  fs.writeFileSync(source, 'おとのなかみ');

  const copied = importSoundFile(dir, source);
  assert.equal(path.basename(copied), 'ぽよん.mp3');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'おとのなかみ');

  // 選び直すと、前のファイルは残らない
  const other = path.join(tempDir(), 'ちりん.wav');
  fs.writeFileSync(other, 'べつのおと');
  const next = importSoundFile(dir, other);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(next)]);

  // 元のファイルを消しても、コピーは残る
  fs.rmSync(other);
  assert.equal(fs.readFileSync(next, 'utf8'), 'べつのおと');
});

test('鳴らせないファイルは断る', () => {
  const dir = path.join(tempDir(), 'notify');
  const source = path.join(tempDir(), 'メモ.txt');
  fs.writeFileSync(source, 'おと');
  assert.throws(() => importSoundFile(dir, source), SoundError);

  const empty = path.join(tempDir(), 'から.mp3');
  fs.writeFileSync(empty, '');
  assert.throws(() => importSoundFile(dir, empty), SoundError);

  assert.throws(() => importSoundFile(dir, path.join(tempDir(), '無い.mp3')), SoundError);
  // 断ったときに、前に選んであった音を消してしまわない
  assert.ok(!fs.existsSync(dir));
});

test('鳴らすものを作る（内蔵の音・自分の音・鳴らさない）', () => {
  assert.deepEqual(playable('none', ''), null);
  assert.deepEqual(playable('しらない名前', ''), null);

  const chime = playable('chime', '');
  assert.equal(chime.kind, 'notes');
  assert.equal(chime.wave, 'sine');

  // 自分の音は、ファイルの中身をそのまま渡す
  const source = path.join(tempDir(), 'ぽよん.mp3');
  fs.writeFileSync(source, 'おと');
  const custom = playable('custom', source);
  assert.equal(custom.kind, 'file');
  assert.equal(custom.dataUrl, `data:audio/mpeg;base64,${Buffer.from('おと').toString('base64')}`);

  // ファイルを選ぶ前や、消えてしまったときは鳴らさない
  assert.equal(playable('custom', ''), null);
  assert.equal(playable('custom', path.join(tempDir(), '無い.mp3')), null);
});
