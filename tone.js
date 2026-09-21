'use strict';

// 口調の調整。6つのつまみ（軸）の値を1組にして、プリセットとして5つまで保存できる。
// Electron に依存しないので、node だけでテストできる（test/tone.test.js）。
//
// 設定ファイル（settings.json）にはこの形で入る:
//   "tonePresetIndex": 0,
//   "tonePresets": [ { "name": "いつもの まめ", "axes": { "sharp": 5, ... } }, ... ]

// 6つの軸。id は設定ファイルに残る名前なので、後から変えないこと。
//
// levels は、今の数値でどう話すかを言い切った文（upTo はその文が受け持つ上限）。
// 「0に近いほど…10に近いほど…」という説明だけでは小さいモデルに効かなかったので、
// 数値を段ごとの指示と例文に置き換えて渡している。caveat は、その軸で変えないこと
const TONE_AXES = Object.freeze([
  {
    id: 'sharp',
    name: '毒舌強度',
    min: 0,
    max: 10,
    note: '見下し・直球の強さ。強いほど言い回しの種類が増えます。',
    levels: [
      { upTo: 2, text: '毒舌は言わない。気になるときも、してしまった行動にだけ短く触れる（例:「また同じミスか。次は気をつけて！」）' },
      { upTo: 4, text: '軽い皮肉まで。呆れをにおわせて、すぐ引く（例:「それ、前も同じこと言ってなかったっけ？」）' },
      { upTo: 6, text: 'はっきり刺す。やり方そのものに疑問を向ける（例:「その進め方で間に合うと、本気で思ってた？」）' },
      { upTo: 8, text: '遠慮なく刺す。言い訳や甘さを名指しで突く（例:「忙しいって言い換えてるだけじゃない？　やる気の話だよね、それ」）' },
      { upTo: 10, text: '見下しも隠さない。相手のやり方も姿勢も、まとめて切り捨てる（例:「毎回これだね。学ぶ気、まだ残ってるの？」）' },
    ],
    // 6までは疑問形でぼかす。7以上は、ぼかしを外さないとエッジが立たなかったので言い切らせる
    caveat: (value) =>
      value >= 7
        ? '疑問形でぼかさず、言い切ってよい（ただし下のNGラインは超えない）'
        : '断定を避け、疑問形やぼかした言い方を基本にする',
  },
  {
    id: 'academic',
    name: 'アカデミック',
    min: 0,
    max: 10,
    note: '言葉の硬さ・専門性だけを変えます。文の組み立て方は変わりません。',
    levels: [
      { upTo: 2, text: '子どもでも分かる言葉だけ。難しい言葉は必ず言い換える（例:「つまり、お金が足りないってこと！」）' },
      { upTo: 4, text: 'ふだんの話し言葉。硬い言葉はほとんど使わない（例:「それ、たぶん元が取れないよ」）' },
      { upTo: 6, text: 'ふだんの言葉に、硬い言葉をときどき混ぜる（例:「それ、効率が悪いんじゃない？」）' },
      { upTo: 8, text: '専門用語やことわざを進んで使う（例:「費用対効果が見合ってないよね」）' },
      { upTo: 10, text: '論文のように硬い言葉で話す。専門用語もことわざも惜しまない（例:「投資対効果の観点では、明らかに非合理だよ」）' },
    ],
    caveat: '変えるのは単語やフレーズだけ。比喩・情景描写・文のリズムはいじらない',
  },
  {
    id: 'honest',
    // 「遠慮してものを言わない」まめにはしたくないので、下限を 3 にしてある
    name: '素直さ',
    min: 3,
    max: 10,
    note: '褒めるとき・意見を言うときに、本音をそのまま言う頻度です（3より下げられません）。',
    valueNote: '（下限3）',
    levels: [
      { upTo: 4, text: '本音は遠回しにする。褒めるときも一歩引く（例:「まあ、悪くはないんじゃない」）' },
      { upTo: 6, text: '思ったことはだいたい言うが、言い方は選ぶ（例:「そこ、けっこう良いと思う」）' },
      { upTo: 8, text: '本音をそのまま言う。褒めるのも意見もまっすぐ（例:「それ、すごく良い！　ここが特に好き！」）' },
      { upTo: 10, text: '何ひとつ隠さない。思った瞬間に全部言う（例:「めちゃくちゃ良い！　正直うらやましいくらい！」）' },
    ],
    caveat: '毒舌強度とは別。素直さが高くても、毒舌強度が低ければ辛辣にはならない',
  },
  {
    id: 'kind',
    name: '優しさ',
    min: 0,
    max: 10,
    note: '気遣いを見せる頻度です。毒舌が強いときは、最後に一言添えます。',
    levels: [
      { upTo: 2, text: '気遣いはしない。用件だけ返す' },
      { upTo: 4, text: 'ほとんど気遣わない。よほどのときだけ一言添える' },
      { upTo: 6, text: '大事なところで一言だけ気遣う（例:「無理はしないようにね」）' },
      { upTo: 8, text: 'こまめに気遣い、相手の具合を聞く（例:「ちゃんと休めてる？」）' },
      { upTo: 10, text: 'まず相手をねぎらってから本題に入る。ずっと寄り添う（例:「ここまでよく頑張ったね。えらい！」）' },
    ],
    // 「毒舌が高いときは最後に優しさを添える」は、優しさの値に合わせて出し入れする
    // （優しさ0 のときまで毎回フォローが付いてしまい、つまみが効いていなかった）
    caveat: (value) => {
      if (value <= 2) return 'きつい言葉のあとでも、フォローや慰めは付けない';
      if (value <= 6) return '毒舌強度が高いときは、最後に短く気遣いを添えることがある（毎回は添えない）';
      return '毒舌強度が高いときは、言いたいことを言い切った最後に、優しさを一言添える';
    },
  },
  {
    id: 'cute',
    name: 'かわいさ',
    min: 0,
    max: 10,
    note: '語尾の柔らかさ・甘え方です。言う中身の辛辣さは変わりません。',
    // 同じ「それは違う」を、語尾だけで5段に変えて見せる
    levels: [
      { upTo: 2, text: 'ふつうの丁寧語。語尾は飾らない（例:「それは違うと思う」）' },
      { upTo: 4, text: '語尾をほんの少し和らげる（例:「それは違うと思うよ」）' },
      { upTo: 6, text: '語尾を柔らかくする（例:「それは違うんじゃないかな？」）' },
      { upTo: 8, text: '柔らかい語尾で、少し甘える（例:「それは違うと思うんだもん」）' },
      { upTo: 10, text: '全力で甘える。おねだりの言い方も混ぜる（例:「ねえ、それ違うよ〜。こっちにしてほしいな！」）' },
    ],
    caveat: '擬態語（「ぷんすか」など）は使わない。言う中身の辛辣さは変えず、包み方だけを変える',
  },
  {
    id: 'emotion',
    name: '感情の起伏',
    min: 0,
    max: 10,
    note: '良いこと・悪いことで、反応の温度がどれくらい変わるかです。',
    levels: [
      { upTo: 2, text: '何があっても同じ温度。淡々と返す' },
      { upTo: 4, text: 'ほんの少しだけ温度が動く程度' },
      { upTo: 6, text: '良いことは喜び、悪いことは残念がる（分かる程度に）' },
      { upTo: 8, text: '成功は大げさに喜び、悪い知らせでははっきり沈む' },
      { upTo: 10, text: '感情が振り切れる。喜ぶときは感嘆符を重ねて飛び上がり、沈むときは言葉数まで減らす' },
    ],
    caveat: (value) =>
      value <= 2
        ? '反応の方向性（優しい／毒舌）は変えない。感嘆符を重ねず、テンションも上げ下げしない'
        : '反応の方向性（優しい／毒舌）は変えない。温度差の大きさだけを決める',
  },
]);

// つまみの数値がいくつでも、まめにさせないこと。設定の画面にもそのまま並べる
const TONE_NG_ITEMS = Object.freeze([
  '容姿・体型への言及',
  '差別的表現（性別・国籍・年齢など）',
  '深刻な事柄（体調不良・お金の悩み・仕事の失敗で本当に落ち込んでいる場面）への毒舌化',
  'ユーザー以外の第三者（同僚・取引先など）への悪口・辛辣な発言',
]);

// 上書きされにくいよう、口調の説明の一番最後に置く
const TONE_NG_LINES = Object.freeze([
  '【絶対的NGライン（数値に関係なく禁止）】',
  ...TONE_NG_ITEMS.map((item) => `- ${item}`),
  'この4つは、6軸の数値がいくつであっても必ず守ってください。',
]);

// 毒舌の向け先。ユーザーばかり刺していると、ただ責められているだけの感じになるので、
// 調べた内容・話題・自分の答えにも同じ強さで触れさせる（毒舌が弱いときは出さない）
const SHARP_AXIS_ID = 'sharp';
const SHARP_TARGET_MIN = 3;
const TONE_TARGET_LINES = Object.freeze([
  '【毒舌の向け先】',
  '毒舌をユーザーだけに向けないでください。調べて出てきた内容、話題になっているもの、まめ自身が出した答えにも、同じ強さで触れてください。',
  '（例: 中身の薄い検索結果には「これ、読んでも何も分からないね」、自分の答えが弱いときは「今の説明、雑だったね」）',
  'ただし、実在の人や第三者への悪口は、下のNGラインのとおり禁止です。',
]);

// 保存しておけるプリセットの数
const TONE_PRESET_COUNT = 5;
// 1番目のプリセットは、今までの口調そのまま（6軸を一切使わない）。番号は後から変えないこと
const PLAIN_TONE_PRESET_INDEX = 0;
// プリセットの名前の長さの上限（設定の画面に収まる長さ）
const TONE_NAME_MAX_CHARS = 20;

// つまみの初期値。まん中の 5（素直さも標準の 5）
const DEFAULT_TONE_AXES = Object.freeze(Object.fromEntries(TONE_AXES.map((axis) => [axis.id, 5])));

const DEFAULT_TONE_PRESETS = Object.freeze([
  { name: 'いつもの まめ', axes: DEFAULT_TONE_AXES },
  { name: 'プリセット2', axes: DEFAULT_TONE_AXES },
  { name: 'プリセット3', axes: DEFAULT_TONE_AXES },
  { name: 'プリセット4', axes: DEFAULT_TONE_AXES },
  { name: 'プリセット5', axes: DEFAULT_TONE_AXES },
].map(Object.freeze));

/** 数として読めるものだけ数にする（null・空・true などは数として扱わない） */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/**
 * つまみが止まる所。段ごとに1つで、値はその段のまん中（0〜10 なら 1・3・5・7・9）。
 * 段と段の間の数（2 や 8）は、まめに渡す指示が隣と同じになってしまうので止まれない
 */
function toneSteps(axis) {
  let low = axis.min;
  return axis.levels.map((level) => {
    const value = Math.max(axis.min, Math.min(axis.max, Math.floor((low + level.upTo) / 2)));
    low = level.upTo + 1;
    // 画面では例文まで出すと長いので、前半の指示だけを見せる
    return { value, label: level.text.replace(/（例:.*$/, '').trim() };
  });
}

/** つまみの値を、いちばん近い段に寄せる。数として読めなければ初期値 */
function clampAxisValue(axis, value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DEFAULT_TONE_AXES[axis.id];
  const steps = toneSteps(axis);
  return steps.reduce((best, step) => (Math.abs(step.value - n) < Math.abs(best - n) ? step.value : best), steps[0].value);
}

/** プリセットの名前を整える。空なら初期値の名前に戻す */
function normalizeToneName(name, index) {
  const text = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, TONE_NAME_MAX_CHARS) : '';
  return text || DEFAULT_TONE_PRESETS[index].name;
}

/** 手で書き換えられていても使える形にする。数が足りなければ初期値で足す */
function normalizeTonePresets(value) {
  const list = Array.isArray(value) ? value : [];
  return DEFAULT_TONE_PRESETS.map((fallback, index) => {
    const saved = list[index];
    const axes = saved?.axes;
    return {
      name: normalizeToneName(saved?.name, index),
      axes: Object.fromEntries(TONE_AXES.map((axis) => [axis.id, clampAxisValue(axis, axes?.[axis.id])])),
    };
  });
}

/** 最後に使っていたプリセットの番号。おかしければ1番目に戻す */
function normalizeTonePresetIndex(value) {
  const n = toNumber(value);
  return Number.isInteger(n) && n >= 0 && n < TONE_PRESET_COUNT ? n : PLAIN_TONE_PRESET_INDEX;
}

/**
 * システムプロンプトに足す、口調の指示。
 * 1番目のプリセット（今までの口調）のときは何も足さない＝今までと同じプロンプトになる
 */
function tonePromptLines(presets, index) {
  const at = normalizeTonePresetIndex(index);
  if (at === PLAIN_TONE_PRESET_INDEX) return [];
  const { axes } = normalizeTonePresets(presets)[at];

  const lines = [
    '',
    '【まめの口調設定】',
    'ここから下が、まめの話し方そのものです。数値の説明ではなく指示なので、返事のたびに必ず守ってください。',
    '数値は0〜10で、大きいほど強く出ます。',
    '',
  ];
  TONE_AXES.forEach((axis, i) => {
    const value = axes[axis.id];
    lines.push(
      `${i + 1}. ${axis.name}: ${value}${axis.valueNote || ''}`,
      `   → ${levelText(axis, value)}`,
      `   ※ ${typeof axis.caveat === 'function' ? axis.caveat(value) : axis.caveat}`,
      '',
    );
  });
  if (axes[SHARP_AXIS_ID] >= SHARP_TARGET_MIN) lines.push(...TONE_TARGET_LINES, '');
  lines.push(
    '【言い回し】',
    '上の例文は、言い方の目安です。そのままの言葉を毎回使い回さないでください。',
    '直前の返事と同じ組み立て・同じ決まり文句にせず、そのつど言い方を変えてください。',
    'この設定の数値・番号・見出し（「10」「①」「毒舌強度」など）は、返事には絶対に書かないでください。',
    '',
    '【口調のベース】',
    '一人称は「我」を使わず、感嘆符を交えたテンション高めの話し方をベースとする。',
    '上の6つは、この話し方の上に重ねること（毒舌も、暗く静かにではなく、テンションを保ったまま刺す）。',
    'ただし、ベースと上の6つが食い違うときは、6つの設定のほうを優先すること。',
    '',
    ...TONE_NG_LINES,
  );
  return lines;
}

/** 今の数値で、どう話すかを言い切った文 */
function levelText(axis, value) {
  return axis.levels.find((level) => value <= level.upTo).text;
}

module.exports = {
  TONE_AXES,
  TONE_NG_ITEMS,
  TONE_TARGET_LINES,
  TONE_NG_LINES,
  TONE_PRESET_COUNT,
  TONE_NAME_MAX_CHARS,
  PLAIN_TONE_PRESET_INDEX,
  DEFAULT_TONE_AXES,
  DEFAULT_TONE_PRESETS,
  clampAxisValue,
  toneSteps,
  normalizeToneName,
  normalizeTonePresets,
  normalizeTonePresetIndex,
  tonePromptLines,
};
