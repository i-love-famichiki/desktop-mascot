'use strict';

// 感情の評価（Appraisal）のテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EMOTIONS,
  APPRAISAL_SCHEMA,
  MoodLog,
  MOOD_KEEP_TURNS,
  MOOD_MAX_AGE_MS,
  baseIntensity,
  scaledIntensity,
  normalizeAppraisal,
  effectiveSharpness,
  judgePromptLines,
  moodPromptLines,
  emotionPromptLines,
  withSharpness,
} = require('../appraisal');
const { TONE_NG_ITEMS } = require('../tone');

const AXES = { sharp: 6, academic: 5, honest: 5, kind: 5, cute: 5, emotion: 5 };

/** Gemini が返してきた形をまねる */
function raw({ violation = 0, distress = 0, primary = 'neutral', intensity = 0, agent = 'none' } = {}) {
  return {
    appraisal: {
      standard_violation: violation > 0,
      violation_severity: violation,
      distress_to_bean: distress > 0,
      distress_severity: distress,
      responsible_agent: agent,
    },
    emotion: { primary, raw_intensity: intensity },
  };
}

test('判定の呼び出しでは、返事を作らせない', () => {
  // reply を同じ呼び出しで作らせると、口調の指示に引っぱられて判定を無視した（appraisal.js の頭を参照）
  assert.deepEqual(Object.keys(APPRAISAL_SCHEMA.properties), ['appraisal', 'emotion']);
  assert.deepEqual(APPRAISAL_SCHEMA.required, ['appraisal', 'emotion']);
  assert.ok(!('reply' in APPRAISAL_SCHEMA.properties));
  assert.deepEqual(APPRAISAL_SCHEMA.properties.emotion.properties.primary.enum, Object.keys(EMOTIONS));
});

test('程度から出す強さは 0〜10 に収まる', () => {
  assert.equal(baseIntensity(0, 0), 0);
  assert.equal(baseIntensity(3, 3), 10);
  assert.equal(baseIntensity(2, 1), 5);
});

test('感情の起伏が低いと、同じことを言われても振れ幅が小さい', () => {
  const base = baseIntensity(3, 3);
  assert.equal(scaledIntensity(base, 5), 10); // 標準
  assert.equal(scaledIntensity(base, 1), 2); // 淡々
  assert.equal(scaledIntensity(base, 9), 10); // 上限で止まる
  assert.equal(scaledIntensity(baseIntensity(1, 1), 1), 1);
});

test('怒りは、基準違反と実害が両方そろったときだけ', () => {
  const both = normalizeAppraisal(raw({ violation: 3, distress: 3, primary: 'anger' }), 5);
  assert.equal(both.emotion.primary, 'anger');

  // 違反だけ（呆れ）で anger と言ってきても、anger にはしない
  const onlyViolation = normalizeAppraisal(raw({ violation: 2, primary: 'anger' }), 5);
  assert.notEqual(onlyViolation.emotion.primary, 'anger');

  const onlyDistress = normalizeAppraisal(raw({ distress: 2, primary: 'anger' }), 5);
  assert.notEqual(onlyDistress.emotion.primary, 'anger');
});

test('怒りの強さは Gemini の言い値ではなく、程度から計算し直す', () => {
  const result = normalizeAppraisal(raw({ violation: 1, distress: 1, primary: 'anger', intensity: 10 }), 5);
  assert.equal(result.emotion.raw_intensity, baseIntensity(1, 1));
  assert.equal(result.emotion.model_intensity, 10); // 食い違いを見るために残してある
});

test('喜びの強さは 0 にならない（違反も実害も無いので、言い値を使う）', () => {
  // 違反・実害から計算すると必ず 0 になってしまう感情
  for (const primary of ['joy', 'admiration', 'pride', 'shame']) {
    const result = normalizeAppraisal(raw({ primary, intensity: 8 }), 5);
    assert.equal(result.emotion.primary, primary);
    assert.equal(result.emotion.raw_intensity, 8, `${primary} の強さ`);
  }
  // 起伏が低いプリセットでは、喜びも小さくなる
  assert.equal(normalizeAppraisal(raw({ primary: 'joy', intensity: 8 }), 1).emotion.raw_intensity, 2);
  // ふつうのときは、いつも 0
  assert.equal(normalizeAppraisal(raw({ primary: 'neutral', intensity: 8 }), 5).emotion.raw_intensity, 0);
});

test('外のことで悲しいときも、強さは 0 にならない', () => {
  // 実機で出た。原因が external だと違反も実害も 0 なので、程度から計算すると潰れる
  const 外の悲しみ = { appraisal: { standard_violation: false, violation_severity: 0, distress_to_bean: false, distress_severity: 0, responsible_agent: 'external' }, emotion: { primary: 'distress', raw_intensity: 7 } };
  assert.equal(normalizeAppraisal(外の悲しみ, 5).emotion.raw_intensity, 7);

  // ユーザーのせいで悲しいときは、今までどおり程度から計算し直す
  const 呆れ = normalizeAppraisal(raw({ violation: 2, primary: 'distress', intensity: 10 }), 5);
  assert.equal(呆れ.emotion.raw_intensity, baseIntensity(2, 0));
});

test('判定と程度が食い違うときは、程度のほうを直す', () => {
  const contradiction = { appraisal: { standard_violation: true, violation_severity: 0, distress_to_bean: false, distress_severity: 3, responsible_agent: 'user' }, emotion: { primary: 'anger', raw_intensity: 5 } };
  const { appraisal } = normalizeAppraisal(contradiction, 5);
  assert.equal(appraisal.violation_severity, 1); // true なのに 0 → 1 に寄せる
  assert.equal(appraisal.distress_severity, 0); // false なのに 3 → 0 にする
});

test('おかしな値でも落ちない', () => {
  for (const value of [null, undefined, {}, { appraisal: 'いいえ', emotion: 7 }, { emotion: { primary: 'ぷんすか' } }]) {
    const result = normalizeAppraisal(value, 5);
    assert.ok(Object.keys(EMOTIONS).includes(result.emotion.primary));
    assert.ok(result.emotion.raw_intensity >= 0 && result.emotion.raw_intensity <= 10);
  }
});

test('毒舌は、怒っているときだけ・プリセットの上限まで', () => {
  const angry = normalizeAppraisal(raw({ violation: 3, distress: 3, primary: 'anger' }), 5);
  assert.equal(angry.emotion.raw_intensity, 10);
  assert.equal(effectiveSharpness(angry, AXES), 6); // 上限 6 で止まる
  assert.equal(effectiveSharpness(angry, { ...AXES, sharp: 0 }), 0);

  // 怒っていないなら、毒舌強度がいくつでも毒舌は出さない
  const happy = normalizeAppraisal(raw({ primary: 'joy' }), 5);
  assert.equal(effectiveSharpness(happy, { ...AXES, sharp: 10 }), 0);
  assert.equal(effectiveSharpness(normalizeAppraisal(raw(), 5), { ...AXES, sharp: 10 }), 0);
});

test('判定の指示は、NGラインの確認が1番目で、口調を含まない', () => {
  const text = judgePromptLines([]).join('\n');

  const ngAt = text.indexOf(TONE_NG_ITEMS[0]);
  const judgeAt = text.indexOf('standard_violation');
  assert.ok(ngAt >= 0 && judgeAt >= 0);
  assert.ok(ngAt < judgeAt, 'NGラインの確認が、判定より前に書かれていること');
  // 口調の指示は入れない（入れると判定まで口調に引っぱられる）
  assert.ok(!text.includes('【まめの口調設定】'));
  assert.ok(!text.includes('毒舌強度'));
  assert.ok(text.includes('返事は書きません'));
});

test('判定の指示は、怒ってよい場面とだめな場面を両方 例で示す', () => {
  const text = judgePromptLines([]).join('\n');

  // 例を片側しか書かないと、判定が寄ってしまった（怒りすぎ／怒らなすぎ）
  assert.ok(text.includes('役立たず'), '怒ってよい例');
  assert.ok(text.includes('「はいはい」「別に」「ふーん」'), '怒らない例');
  // 自分を責める言葉は、まめへの攻撃ではない
  assert.ok(text.includes('僕は馬鹿だ'));
  // 直前に自分がきつく返していると「仕返しだから仕方ない」と判断して怒らなくなった
  assert.ok(text.includes('仕返しだから仕方ない'));
  // お礼を neutral にしてしまうので、念を押す
  assert.ok(text.includes('必ず joy を付けて'));
});

test('判定の指示は短い（返事の呼び出しより、ずっと小さい）', () => {
  // 1回の会話で2回叩くので、判定のほうは小さく保つ（実測 約570トークン）
  assert.ok(judgePromptLines([]).join('\n').length < 1400);
});

test('今の気持ちは、怒りのときだけ毒舌を許す言い方になる', () => {
  const at = (primary) => emotionPromptLines({ emotion: { primary, raw_intensity: 5 } }).join('\n');

  assert.match(at('anger'), /毒舌強度の範囲で返事に出して/);
  assert.match(at('distress'), /毒舌にはしないで/);
  assert.match(at('joy'), /毒舌は使いません/);
  // ふつうのときは、何も足さない
  assert.deepEqual(emotionPromptLines({ emotion: { primary: 'neutral', raw_intensity: 0 } }), []);
});

test('少し前の気分は、感情があるときだけ出す', () => {
  assert.deepEqual(moodPromptLines([]), []);
  assert.deepEqual(moodPromptLines(null), []);
  const now = Date.now();
  const lines = moodPromptLines([{ at: now - 5 * 60000, emotion: 'anger', intensity: 7 }], now);
  assert.ok(lines.join('\n').includes('5分前: 怒り（強さ 7）'));
});

// --- 判定から、その回の毒舌強度へ ---------------------------------------------

test('判定から、その回の毒舌強度が決まる', () => {
  const 怒り = withSharpness(raw({ violation: 3, distress: 3, primary: 'anger' }), AXES);
  assert.equal(怒り.sharpness, 6); // 上限 6 で止まる

  const 呆れ = withSharpness(raw({ violation: 2, primary: 'distress' }), AXES);
  assert.equal(呆れ.sharpness, 0);

  // 判定できなかったとき（null）は、毒舌なしに倒す
  const 失敗 = withSharpness(null, AXES);
  assert.equal(失敗.sharpness, 0);
  assert.equal(失敗.emotion.primary, 'neutral');
});

// --- 感情の引きずりの保存 -----------------------------------------------------

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-mood-')), 'mood.json');
}

test('直近の感情だけを残す', () => {
  const log = new MoodLog(tempFile());
  for (let i = 0; i < MOOD_KEEP_TURNS + 3; i++) {
    log.record({ at: Date.now(), emotion: 'joy', intensity: i });
  }
  const turns = log.load();
  assert.equal(turns.length, MOOD_KEEP_TURNS);
  assert.equal(turns.at(-1).intensity, MOOD_KEEP_TURNS + 2);
});

test('古すぎる感情は引きずらない', () => {
  const log = new MoodLog(tempFile());
  const now = Date.now();
  log.record({ at: now - MOOD_MAX_AGE_MS - 60000, emotion: 'anger', intensity: 9 }, now);
  assert.deepEqual(log.load(now), []);
});

test('口調を変えたら、気分は消える', () => {
  const log = new MoodLog(tempFile());
  log.record({ at: Date.now(), emotion: 'anger', intensity: 9 });
  log.clear();
  assert.deepEqual(log.load(), []);
});

test('ファイルが無くても、壊れていても落ちない', () => {
  assert.deepEqual(new MoodLog(path.join(os.tmpdir(), 'mascot-mood-ない.json')).load(), []);
  const file = tempFile();
  fs.writeFileSync(file, 'これは JSON ではない');
  assert.deepEqual(new MoodLog(file).load(), []);
});
