'use strict';

// 豆が鳴らす音。内蔵の音は、その場で作る（音のファイルを持たないので、アプリが太らない）。
// 「自分の音」を選んだときだけ、選んだファイルをアプリの中にコピーして鳴らす。
// 鳴らすのはレンダラー（sound-player.js）で、ここは「何を鳴らすか」を決めるだけ。
// Electron に依存しないので、node だけでテストできる（test/sounds.test.js）。

const fs = require('fs');
const path = require('path');

// 内蔵の音の楽譜。at = 鳴り始め（秒）、dur = 消えるまで（秒）、hz = 音の高さ
const BUILT_IN_SOUNDS = Object.freeze([
  {
    id: 'chime',
    name: 'ポロン♪（今までの音）',
    wave: 'sine',
    notes: [
      { hz: 1047, at: 0, dur: 0.5 },
      { hz: 1568, at: 0.12, dur: 0.5 },
      { hz: 1047, at: 0.6, dur: 0.5 },
      { hz: 1568, at: 0.72, dur: 0.5 },
    ],
  },
  {
    id: 'bell',
    name: 'ちりん（鈴）',
    wave: 'sine',
    notes: [
      { hz: 2093, at: 0, dur: 0.9 },
      { hz: 2637, at: 0.05, dur: 0.9 },
    ],
  },
  {
    id: 'pop',
    name: 'ぽこっ（短め）',
    wave: 'triangle',
    notes: [
      { hz: 660, at: 0, dur: 0.14 },
      { hz: 988, at: 0.07, dur: 0.16 },
    ],
  },
  {
    id: 'knock',
    name: 'こつん（低め）',
    wave: 'triangle',
    notes: [
      { hz: 392, at: 0, dur: 0.2 },
      { hz: 523, at: 0.09, dur: 0.28 },
    ],
  },
  {
    id: 'piro',
    name: 'ぴろりん（上がる）',
    wave: 'sine',
    notes: [
      { hz: 784, at: 0, dur: 0.3 },
      { hz: 1047, at: 0.09, dur: 0.3 },
      { hz: 1319, at: 0.18, dur: 0.45 },
    ],
  },
]);

// 内蔵の音のほかに選べるもの
const SILENT = 'none';
const CUSTOM = 'custom';

// 音の大きさ。notes = その場で作る音、file = 自分の音（どちらも 0〜1）。
// 短くて消えていく音は、2倍くらいでは耳で差が分かりにくいので、段の差を大きくとる。
// notes が 0.6 より大きいと、重なって鳴る音（ポロン♪など）で音が割れる
const SOUND_VOLUMES = Object.freeze([
  { id: 'small', name: '小さめ', notes: 0.04, file: 0.1 },
  { id: 'medium', name: 'ふつう', notes: 0.2, file: 0.45 },
  { id: 'large', name: '大きめ', notes: 0.6, file: 1 },
]);

// 選べる音のファイル（Chromium がそのまま鳴らせる形）
const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const AUDIO_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
});
// 大きすぎるファイルは、起動のたびに読むには重いので断る
const SOUND_FILE_MAX_BYTES = 5 * 1024 * 1024;

class SoundError extends Error {}

/** 設定の画面に出す、選べる音（画面に並べる順） */
function soundChoices() {
  return [
    { id: SILENT, name: '鳴らさない' },
    ...BUILT_IN_SOUNDS.map(({ id, name }) => ({ id, name })),
    { id: CUSTOM, name: '自分の音（ファイルを選ぶ）' },
  ];
}

function findSound(id) {
  return BUILT_IN_SOUNDS.find((sound) => sound.id === id) ?? null;
}

/** 設定に書ける音の名前か（設定ファイルを手で書き換えられていても大丈夫なように） */
function isSoundId(id) {
  return id === SILENT || id === CUSTOM || Boolean(findSound(id));
}

/** 音の大きさ。知らない名前なら「ふつう」 */
function volumeById(id) {
  return SOUND_VOLUMES.find((volume) => volume.id === id) ?? SOUND_VOLUMES[1];
}

function isVolumeId(id) {
  return SOUND_VOLUMES.some((volume) => volume.id === id);
}

// ファイル名に使えない字（Windows）。パスの区切りは basename が外すので、ここには入らない
const BAD_FILE_CHARS = '<>:"|?*';

/** ファイル名に使えない字を置き換える。長すぎる名前は短くする */
function safeFileName(name) {
  const ext = path.extname(name).toLowerCase();
  const base = [...path.basename(name, path.extname(name))]
    .map((char) => (BAD_FILE_CHARS.includes(char) || char.codePointAt(0) < 0x20 ? '_' : char))
    .join('')
    .slice(0, 60)
    .trim();
  return `${base || 'sound'}${ext}`;
}

/**
 * 選ばれた音のファイルを、アプリの中（dir）にコピーする。
 * 元のファイルが動いたり消えたりしても鳴るように、コピーを持っておく。
 * 選び直したときは、前のファイルを消してから入れる。戻り値はコピー先の場所
 */
function importSoundFile(dir, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new SoundError(`この形の音は鳴らせません。${AUDIO_EXTENSIONS.join(' / ')} のどれかを選んでください`);
  }
  let size = 0;
  try {
    ({ size } = fs.statSync(filePath));
  } catch (err) {
    throw new SoundError(`ファイルを読めませんでした: ${err.message}`);
  }
  if (size > SOUND_FILE_MAX_BYTES) throw new SoundError('音のファイルが大きすぎます（5MB までにしてください）');
  if (size === 0) throw new SoundError('中身が空のファイルです');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, safeFileName(path.basename(filePath)));
  fs.copyFileSync(filePath, to);
  return to;
}

/**
 * 鳴らすものを作る（レンダラーはこれをそのまま鳴らす）。
 * 「鳴らさない」や、ファイルが読めないときは null
 */
function playable(id, filePath) {
  if (id === CUSTOM) {
    if (!filePath) return null;
    try {
      const data = fs.readFileSync(filePath);
      const type = AUDIO_TYPES[path.extname(filePath).toLowerCase()] ?? 'audio/mpeg';
      return { kind: 'file', dataUrl: `data:${type};base64,${data.toString('base64')}` };
    } catch (err) {
      console.error('[sound] 音のファイルを読めませんでした:', err.message);
      return null;
    }
  }
  const sound = findSound(id);
  return sound ? { kind: 'notes', wave: sound.wave, notes: sound.notes } : null;
}

module.exports = {
  BUILT_IN_SOUNDS,
  SOUND_VOLUMES,
  AUDIO_EXTENSIONS,
  SOUND_FILE_MAX_BYTES,
  SoundError,
  soundChoices,
  findSound,
  isSoundId,
  isVolumeId,
  volumeById,
  safeFileName,
  importSoundFile,
  playable,
};
