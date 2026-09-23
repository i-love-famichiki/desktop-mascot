'use strict';

// 口調（6つのつまみと5つのプリセット）のテスト。実行:  npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TONE_AXES,
  toneSteps,
  clampAxisValue,
  TONE_NG_ITEMS,
  TONE_PRESET_COUNT,
  TONE_NAME_MAX_CHARS,
  PLAIN_TONE_PRESET_INDEX,
  DEFAULT_TONE_PRESETS,
  normalizeToneName,
  normalizeTonePresets,
  normalizeTonePresetIndex,
  tonePromptLines,
} = require('../tone');

test('つまみは6つ。素直さだけ下限が3', () => {
  assert.deepEqual(TONE_AXES.map((axis) => axis.id), ['sharp', 'academic', 'honest', 'kind', 'cute', 'emotion']);
  for (const axis of TONE_AXES) {
    assert.equal(axis.max, 10);
    assert.equal(axis.min, axis.id === 'honest' ? 3 : 0);
  }
});

test('プリセットは5つで、初期値はどれも まん中の5', () => {
  assert.equal(DEFAULT_TONE_PRESETS.length, TONE_PRESET_COUNT);
  for (const preset of DEFAULT_TONE_PRESETS) {
    assert.deepEqual(Object.values(preset.axes), [5, 5, 5, 5, 5, 5]);
  }
});

test('手で書き換えられていても使える形にする（足りない分は初期値、範囲の外は丸める）', () => {
  const presets = normalizeTonePresets([
    { name: '  毒舌  まめ  ', axes: { sharp: 99, academic: -3, honest: 0, kind: '7', cute: null } },
  ]);

  assert.equal(presets.length, TONE_PRESET_COUNT);
  assert.equal(presets[0].name, '毒舌 まめ');
  // 99 も -3 も、いちばん近い段（9 と 1）に寄る
  assert.deepEqual(presets[0].axes, { sharp: 9, academic: 1, honest: 3, kind: 7, cute: 5, emotion: 5 });
  // 足りなかった2つ目以降は初期値
  assert.deepEqual(presets[1], { name: 'プリセット2', axes: { sharp: 5, academic: 5, honest: 5, kind: 5, cute: 5, emotion: 5 } });

  // 配列ですらないときも、まるごと初期値
  assert.deepEqual(normalizeTonePresets(null), normalizeTonePresets(undefined));
  assert.deepEqual(normalizeTonePresets(null)[2], { name: 'プリセット3', axes: { sharp: 5, academic: 5, honest: 5, kind: 5, cute: 5, emotion: 5 } });
});

test('名前は空なら元に戻り、長すぎるときは切る', () => {
  assert.equal(normalizeToneName('   ', 1), 'プリセット2');
  assert.equal(normalizeToneName(123, 1), 'プリセット2');
  assert.equal(normalizeToneName('あ'.repeat(50), 1), 'あ'.repeat(TONE_NAME_MAX_CHARS));
});

test('最後に使っていたプリセットの番号。おかしければ1番目に戻す', () => {
  assert.equal(normalizeTonePresetIndex(3), 3);
  for (const bad of [-1, 5, 1.5, 'にばんめ', null, undefined, NaN]) {
    assert.equal(normalizeTonePresetIndex(bad), PLAIN_TONE_PRESET_INDEX);
  }
});

test('1番目のプリセットは、システムプロンプトに何も足さない（今までの口調のまま）', () => {
  assert.deepEqual(tonePromptLines(DEFAULT_TONE_PRESETS, PLAIN_TONE_PRESET_INDEX), []);
  // 番号がおかしいときも、1番目として扱う
  assert.deepEqual(tonePromptLines(DEFAULT_TONE_PRESETS, 99), []);
});

test('2番目以降は、6つの数値と NG ラインが入った指示になる', () => {
  const presets = normalizeTonePresets([null, { name: '毒舌', axes: { sharp: 5, honest: 1 } }]);
  const text = tonePromptLines(presets, 1).join('\n');

  assert.match(text, /【まめの口調設定】/);
  assert.match(text, /1\. 毒舌強度: 5\n/);
  // 数値そのものではなく、その段の言い切った指示が入る
  assert.match(text, /はっきり刺す。/);
  // 下限3まで上げてから入れる
  assert.match(text, /3\. 素直さ: 3（下限3）/);
  for (const axis of TONE_AXES) assert.match(text, new RegExp(`${axis.name}: \\d`));
  // NG ラインは、上書きされにくいよう一番最後に置く
  for (const item of TONE_NG_ITEMS) assert.ok(text.includes(`- ${item}`));
  assert.match(text, /この4つは、6軸の数値がいくつであっても必ず守ってください。$/);
});

// 感情の評価が「この回は刺す理由がない」と出たとき、毒舌強度だけを差し替える。
// プリセットの値をそのまま書いておくと、判定が 0 でも「毒舌強度9 = 見下しも隠さない」に引っぱられた
test('その回だけ、毒舌強度を差し替えられる', () => {
  const presets = normalizeTonePresets([null, { name: 'きつめ', axes: { sharp: 9, kind: 9 } }]);
  const いつも = tonePromptLines(presets, 1).join('\n');
  const 刺さない = tonePromptLines(presets, 1, 0).join('\n');
  const 控えめ = tonePromptLines(presets, 1, 3).join('\n');

  assert.match(いつも, /1\. 毒舌強度: 9\n/);
  assert.match(刺さない, /1\. 毒舌強度: 0\n/);
  assert.match(控えめ, /1\. 毒舌強度: 3\n/);
  // 0 のときは、毒舌を言わない段の指示になる
  assert.match(刺さない, /毒舌は言わない。/);
  assert.doesNotMatch(刺さない, /見下しも隠さない/);
  // 何が毒舌に当たるかを具体的に並べる（「毒舌強度 0」だけでは止まらなかった）
  assert.match(刺さない, /【この回は毒舌を使いません】/);
  assert.match(刺さない, /暇を持て余している/);
  assert.match(刺さない, /そっけない相づちや短い返事を返されても/);
  // 0 のときは、毒舌の向け先の話も出さない
  assert.doesNotMatch(刺さない, /【毒舌の向け先】/);
  // 刺してよい回では、その注意書きは出さない
  assert.doesNotMatch(いつも, /【この回は毒舌を使いません】/);
  assert.doesNotMatch(控えめ, /【この回は毒舌を使いません】/);
  // ほかの軸は差し替えない
  assert.match(刺さない, /4\. 優しさ: 9\n/);
  // NG ラインは、どの回でも最後に残る
  assert.match(刺さない, /この4つは、6軸の数値がいくつであっても必ず守ってください。$/);
});

test('毒舌が7以上のときは、ぼかさず言い切らせる', () => {
  const at = (sharp) => tonePromptLines(normalizeTonePresets([null, { name: '毒舌', axes: { sharp } }]), 1).join('\n');

  assert.match(at(6), /断定を避け、疑問形やぼかした言い方を基本にする/);
  assert.match(at(7), /疑問形でぼかさず、言い切ってよい/);
  assert.match(at(10), /疑問形でぼかさず、言い切ってよい/);
  // どこまで上げても、NG ラインは外れない
  assert.match(at(10), /この4つは、6軸の数値がいくつであっても必ず守ってください。$/);
});

test('どの軸も、端から端まで言い切った指示になる（同じ文の使い回しが無い）', () => {
  for (const axis of TONE_AXES) {
    // つまみが止まる所は、そのまま指示に出る（段の取りこぼしが無い）
    for (const step of toneSteps(axis)) {
      const preset = normalizeTonePresets([null, { name: 'x', axes: { [axis.id]: step.value } }]);
      const text = tonePromptLines(preset, 1).join('\n');
      assert.match(text, new RegExp(`${axis.name}: ${step.value}(?![0-9])`));
      assert.ok(text.includes(step.label), `${axis.name} の ${step.value} の説明が指示と食い違っています`);
    }
    // 上と下で言っていることが違う（説明ではなく、その数値の指示になっている）
    const texts = axis.levels.map((level) => level.text);
    assert.equal(new Set(texts).size, texts.length);
    // 2〜3目盛りごとに文が変わる細かさ（素直さは3〜10なので4段で同じ細かさになる）
    assert.ok((axis.max - axis.min + 1) / texts.length <= 3, `${axis.name} の段が粗すぎます`);
  }
});

test('優しさが低いときは、毒舌のあとにフォローを付けさせない', () => {
  const at = (kind) => tonePromptLines(normalizeTonePresets([null, { name: 'x', axes: { sharp: 10, kind } }]), 1).join('\n');

  assert.match(at(0), /フォローや慰めは付けない/);
  assert.match(at(10), /最後に、優しさを一言添える/);
  // 感情の起伏が低いときは、ベースのテンションより つまみを優先させる
  const flat = tonePromptLines(normalizeTonePresets([null, { name: 'x', axes: { emotion: 0 } }]), 1).join('\n');
  assert.match(flat, /感嘆符を重ねず/);
});

test('設定の数値や見出しを、返事に書かないよう言い添える', () => {
  const text = tonePromptLines(normalizeTonePresets([null, { name: 'x', axes: { sharp: 10 } }]), 1).join('\n');
  assert.match(text, /返事には絶対に書かないでください/);
  // 「10 / 10」のような、まねされやすい書き方を残さない
  assert.ok(!text.includes('/ 10'));
});

test('つまみは段ごとにしか止まらない（0〜10 なら 1・3・5・7・9 の5段）', () => {
  for (const axis of TONE_AXES) {
    const steps = toneSteps(axis);
    assert.equal(steps.length, axis.levels.length);
    // 初期値の5は、どの軸でも止まれる所
    assert.ok(steps.some((step) => step.value === 5));
    // 間の数は、いちばん近い段に寄る
    for (let value = axis.min; value <= axis.max; value += 1) {
      assert.ok(steps.some((step) => step.value === clampAxisValue(axis, value)));
    }
    // 画面に出す説明には、例文を混ぜない（長すぎて読みにくいため）
    for (const step of steps) assert.ok(!step.label.includes('例:'));
  }
  assert.deepEqual(toneSteps(TONE_AXES[0]).map((step) => step.value), [1, 3, 5, 7, 9]);
  // 素直さは3〜10なので4段
  assert.deepEqual(toneSteps(TONE_AXES[2]).map((step) => step.value), [3, 5, 7, 9]);
});

test('毒舌が効いているときは、ユーザー以外（調べた内容・自分の答え）にも向けさせる', () => {
  const at = (sharp) => tonePromptLines(normalizeTonePresets([null, { name: 'x', axes: { sharp } }]), 1).join('\n');

  assert.match(at(5), /毒舌をユーザーだけに向けないでください/);
  assert.match(at(5), /まめ自身が出した答えにも/);
  // 毒舌を使わない設定のときは、向け先の話も出さない
  assert.doesNotMatch(at(1), /毒舌の向け先/);
  // 向け先が広がっても、第三者への悪口は禁止のまま
  assert.match(at(9), /実在の人や第三者への悪口は/);
  assert.match(at(9), /- ユーザー以外の第三者（同僚・取引先など）への悪口・辛辣な発言/);
});
