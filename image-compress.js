'use strict';

// 豆にドロップした画像（JPEG・PNG）を、話しかけた大きさまで小さくしてデスクトップに置く。
// Electron の nativeImage は呼び出す側から渡してもらうので、読み込むだけなら node でも動く
// （test/image-compress.test.js）。
//
// ・JPEG … 画質を下げながら、目標のサイズに収まるいちばん高い画質を探す
// ・PNG  … nativeImage の toPNG には画質の指定が無いので、色の段階を減らしてから（ポスタリゼーション）
//          保存し直す。似た色がそろうと、PNG の中の圧縮が効いて小さくなる

const fs = require('fs');
const path = require('path');

const KB = 1024;
const MB = 1024 * KB;

// 「メール添付用にして」などの決まった大きさ。増やすときはここに足す
const PRESETS = [
  { name: 'mail', label: 'メール添付用', words: ['メール'], bytes: 1 * MB },
];

// JPEG の画質の範囲。上は 100 まで使う（「80%にして」のような軽い指定で、必要以上に小さくしない）。
// 下は、これより下げるとほとんど見られない画像になる
const JPEG_QUALITY_MAX = 100;
const JPEG_QUALITY_MIN = 10;
// PNG の色の細かさ（1色あたりのビット数）。8 はそのまま、2 は赤緑青それぞれ4段階
const PNG_BITS_MAX = 8;
const PNG_BITS_MIN = 2;

const IMAGE_EXTENSIONS = /\.(jpe?g|png)$/i;

/**
 * 話しかけられた言葉から、どれくらい小さくするかを読み取る。
 * 読み取れなければ null、やめたいときは { kind: 'cancel' }
 * @returns {{ kind: 'size', bytes: number, label: string }
 *   | { kind: 'ratio', ratio: number, label: string }
 *   | { kind: 'cancel' } | null}
 */
function parseCompressCommand(text) {
  // 全角の数字や「％」「ＫＢ」も読めるようにそろえる
  const t = String(text).normalize('NFKC').toLowerCase().replace(/,/g, '');

  const percent = t.match(/(\d+(?:\.\d+)?)\s*(?:%|パーセント)/);
  if (percent) return ratioCommand(Number(percent[1]) / 100, `元の${percent[1]}%以下`);
  if (t.includes('半分')) return ratioCommand(0.5, '元の半分以下');
  const fraction = t.match(/(\d+)\s*分の\s*(\d+)/);
  if (fraction) return ratioCommand(Number(fraction[2]) / Number(fraction[1]), `元の${fraction[1]}分の${fraction[2]}以下`);

  const size = t.match(/(\d+(?:\.\d+)?)\s*(kib|kb|キロバイト|キロ|k|mib|mb|メガバイト|メガ|m)(?![a-z])/);
  if (size) {
    const mega = /^(m|メ)/.test(size[2]);
    const bytes = Math.floor(Number(size[1]) * (mega ? MB : KB));
    if (bytes > 0) return { kind: 'size', bytes, label: `${size[1]}${mega ? 'MB' : 'KB'}以下` };
  }

  const preset = PRESETS.find((p) => p.words.some((word) => t.includes(word)));
  if (preset) return { kind: 'size', bytes: preset.bytes, label: `${preset.label}（${formatBytes(preset.bytes)}以下）` };

  if (/やめ|キャンセル|中止|いらない/.test(t)) return { kind: 'cancel' };
  return null;
}

function ratioCommand(ratio, label) {
  return ratio > 0 && ratio < 1 ? { kind: 'ratio', ratio, label } : null;
}

/** そのファイルの目標のバイト数。割合のときは、ファイルごとの元の大きさをもとにする */
function targetBytes(command, originalBytes) {
  return command.kind === 'ratio' ? Math.floor(originalBytes * command.ratio) : command.bytes;
}

function formatBytes(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))}KB`;
  return `${Math.round((bytes / MB) * 10) / 10}MB`;
}

/** ファイルの先頭を見て形式を決める（拡張子は信用しない） */
function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return null;
}

/**
 * 「元の名前_圧縮.拡張子」で保存する。同じ名前があれば「元の名前_圧縮(2).拡張子」のように番号を付ける。
 * 'wx' で開くので、ほかのファイルを上書きすることは無い
 */
function writeUnique(dir, sourcePath, data) {
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${base}_圧縮${n > 1 ? `(${n})` : ''}${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/**
 * encode(level) の結果が target 以下に収まる、いちばん大きい level を探す（level が大きいほど高画質で大きい）。
 * min まで下げても収まらなければ null
 */
async function encodeToFit(encode, target, min, max) {
  let best = null;
  let lo = min;
  let hi = max;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    // 大きい画像だと1回の変換に時間がかかるので、合間に進み具合の知らせを送れるようにする
    await new Promise((resolve) => setImmediate(resolve));
    const data = encode(mid);
    if (data.length <= target) {
      best = data;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 色の段階を bits ビットに減らす（toBitmap の並びは B, G, R, A）。
 * 色の値は透明度を掛けた後の値なので、透明度を超えないようにする
 */
function posterize(bitmap, bits) {
  const out = Buffer.from(bitmap);
  const step = 1 << (8 - bits);
  const mask = 0xff & ~(step - 1);
  const half = step >> 1;
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3];
    for (let c = 0; c < 3; c++) {
      const low = out[i + c] & mask;
      out[i + c] = low + half <= alpha ? low + half : low;
    }
  }
  return out;
}

/** JPEG の EXIF にある向き（1〜8）。無ければ 1 */
function readJpegOrientation(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xda || marker === 0xd9) break; // 画像の本体が始まった
    if (marker === 0xe1 && buffer.toString('binary', offset + 4, offset + 10) === 'Exif\0\0') {
      const orientation = tiffOrientation(buffer.subarray(offset + 10, offset + 2 + length));
      if (orientation) return orientation;
    }
    offset += 2 + length;
  }
  return 1;
}

function tiffOrientation(tiff) {
  try {
    const little = tiff.toString('binary', 0, 2) === 'II';
    const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch {
    // 壊れた EXIF は向きなしとして扱う
  }
  return null;
}

/**
 * nativeImage は EXIF を読まず、保存し直すと EXIF が消える（スマホの写真が横倒しになる）。
 * 向きだけを持つ小さな EXIF を足す。位置情報などは付け直さない
 */
function withOrientation(jpeg, orientation) {
  if (orientation === 1) return jpeg;
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // ビッグエンディアン、最初の IFD は 8 バイト目
    0, 1, // 項目は1つ
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation (SHORT, 1個)
    0, 0, 0, 0, // 次の IFD は無し
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), header, body, jpeg.subarray(2)]);
}

/**
 * 1枚を小さくする。
 * @returns {{ data: Buffer, copied: boolean } | { tooBig: true } | { error: string }}
 */
async function compressOne(source, target, nativeImage) {
  const type = detectImageType(source);
  if (!type) return { error: 'unsupported' };
  const image = nativeImage.createFromBuffer(source);
  if (image.isEmpty()) return { error: 'broken' };

  // もう目標より小さいときは、画質を落とさずそのまま置く
  if (source.length <= target) return { data: source, copied: true };

  let data;
  if (type === 'jpeg') {
    const orientation = readJpegOrientation(source);
    data = await encodeToFit(
      (quality) => withOrientation(image.toJPEG(quality), orientation),
      target,
      JPEG_QUALITY_MIN,
      JPEG_QUALITY_MAX,
    );
  } else {
    const size = image.getSize();
    const bitmap = image.toBitmap();
    data = await encodeToFit(
      (bits) =>
        bits === PNG_BITS_MAX
          ? image.toPNG()
          : nativeImage.createFromBitmap(posterize(bitmap, bits), size).toPNG(),
      target,
      PNG_BITS_MIN,
      PNG_BITS_MAX,
    );
  }
  return data ? { data, copied: false } : { tooBig: true };
}

/**
 * ドロップされたファイルを順に小さくして outDir に置く。
 * 読めない・対応していないファイルは飛ばし、目標に届かないファイルがあったらそこで止める。
 * @param {{ paths: string[], command: object, outDir: string, nativeImage: object,
 *           onProgress?: (index: number, total: number) => void }} options
 */
async function compressImages({ paths, command, outDir, nativeImage, onProgress = () => {} }) {
  const result = { total: paths.length, saved: [], failed: [], tooBig: null, remaining: 0 };
  for (const [index, file] of paths.entries()) {
    onProgress(index + 1, paths.length);
    const name = path.basename(file);
    let outcome;
    try {
      const source = await fs.promises.readFile(file);
      const target = targetBytes(command, source.length);
      outcome = await compressOne(source, target, nativeImage);
      if (outcome.tooBig) {
        result.tooBig = { name, target };
        result.remaining = paths.length - index - 1;
        break;
      }
      if (outcome.data) {
        result.saved.push({
          name,
          output: writeUnique(outDir, file, outcome.data),
          originalBytes: source.length,
          bytes: outcome.data.length,
          copied: outcome.copied,
        });
        continue;
      }
    } catch (err) {
      console.warn('[image] 処理できませんでした:', file, err.message);
    }
    result.failed.push(name);
  }
  return result;
}

/** 結果を吹き出しで伝える文にする */
function describeResult(result, command) {
  const lines = [];
  const savedCount = result.saved.length;

  if (result.tooBig) {
    const { name, target } = result.tooBig;
    lines.push(`${name} は画質を一番下げても ${formatBytes(target)} に届かなくて、これ以上は難しかった。そこで止めたよ。`);
    if (savedCount > 0) lines.push(`それまでの${savedCount}枚はデスクトップに置いたよ。`);
    if (result.remaining > 0) lines.push(`残りの${result.remaining}枚はそのままだよ。`);
  } else if (savedCount > 0) {
    const count = result.total === 1 ? '' : savedCount === result.total ? `${savedCount}枚とも` : `${savedCount}枚を`;
    // 1枚のときは、どれくらい小さくなったかも添える
    const [only] = result.saved;
    const sizes = result.total === 1 && !only.copied ? `（${formatBytes(only.originalBytes)} → ${formatBytes(only.bytes)}）` : '';
    lines.push(`${count}${command.label}にしてデスクトップに置いたよ。${sizes}`);
    const copied = result.saved.filter((item) => item.copied).map((item) => item.name);
    if (copied.length > 0) lines.push(`（${copied.join('、')} はもともと小さかったから、そのまま置いたよ）`);
  }

  if (result.failed.length > 0) lines.push(`${result.failed.join('、')} は処理できなかったよ。`);
  return lines.join('\n');
}

module.exports = {
  PRESETS,
  IMAGE_EXTENSIONS,
  JPEG_QUALITY_MIN,
  parseCompressCommand,
  targetBytes,
  formatBytes,
  detectImageType,
  writeUnique,
  encodeToFit,
  posterize,
  readJpegOrientation,
  withOrientation,
  compressImages,
  describeResult,
};
