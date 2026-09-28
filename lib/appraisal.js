'use strict';

// 感情の評価（Appraisal）。OCC 模型の考え方で、相手の発言を毎回その場で見てから、
// 感情と強さを決める。口調のつまみ（tone.js）は「ここまでなら出してよい」という上限で、
// 実際にどこまで出すかは、この評価が決める。
// Electron に依存しないので、node だけでテストできる（test/appraisal.test.js）。
//
// なぜ要るか: 毒舌強度 6 のプリセットを選んでいるだけで、相手が何を言っても同じ強さで
// 刺してしまうのが不自然だったため。何も悪いことをされていない回は、毒舌を出さない。
//
// なぜ2回に分けて呼ぶか:
//   はじめは、判定と返事を同じ呼び出しで作らせていた（コストを増やさないため）。
//   しかし「毒舌 0」と判定した回でも、返事だけは毒舌のままだった。
//   （例:「こんばんは」→ 判定 neutral なのに「挨拶だけとは、また一段と中身のない入り方だね」）
//   口調の指示にある「毒舌強度9 = 見下しも隠さない」が、同じプロンプトの中で強く効いてしまい、
//   何が毒舌に当たるかを具体例で並べても直らなかった（3通り試して全部だめ）。
//   そこで、先に判定だけを取り、その結果で毒舌の指示文そのものを差し替えてから返事を書かせる。
//   判定の呼び出しは口調も検索も渡さないので小さく、増える分は1〜2割で済む。
//
// ファイル（mood.json）の形:
//   { "version": 1, "turns": [ { "at": 1758..., "emotion": "anger", "intensity": 4, ... } ] }

const fs = require('fs');
const path = require('path');
const { TONE_NG_ITEMS } = require('./tone');

// 感情の種類。OCC 模型で名前が付いているもののうち、まめに要るものだけ
const EMOTIONS = Object.freeze({
  anger: '怒り',
  joy: '喜び',
  distress: '悲しみ',
  admiration: '感心',
  pride: '誇らしさ',
  shame: '気まずさ',
  neutral: 'ふつう',
});

// 何が原因か。user=ユーザーの言動、self=まめ自身、external=どちらでもない外のこと
const AGENTS = Object.freeze(['user', 'self', 'external', 'none']);

// 基準違反・実害の程度の上限（0〜3）
const SEVERITY_MAX = 3;
// 感情の強さの上限（0〜10）。口調のつまみと同じ目盛りにしてある
const INTENSITY_MAX = 10;
// 「感情の起伏」のつまみの標準値。ここを 1 倍とし、上下で振れ幅が変わる
const EMOTION_AXIS_STANDARD = 5;

// 判定の呼び出しに返してもらう形（generationConfig.responseSchema）。
// 返事はここでは作らせない（作らせると、口調の指示に引っぱられて判定を無視するため）
const APPRAISAL_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    appraisal: {
      type: 'OBJECT',
      properties: {
        standard_violation: { type: 'BOOLEAN', description: 'ユーザーの発言が、まめの許容基準を超えたか' },
        violation_severity: { type: 'INTEGER', description: '基準違反の程度（0〜3）' },
        distress_to_bean: { type: 'BOOLEAN', description: 'まめ自身に実害（嫌な思い）があったか' },
        distress_severity: { type: 'INTEGER', description: '実害の程度（0〜3）' },
        responsible_agent: { type: 'STRING', enum: [...AGENTS], description: '原因の所在' },
      },
      required: ['standard_violation', 'violation_severity', 'distress_to_bean', 'distress_severity', 'responsible_agent'],
    },
    emotion: {
      type: 'OBJECT',
      properties: {
        primary: { type: 'STRING', enum: Object.keys(EMOTIONS), description: '今わいた感情' },
        raw_intensity: { type: 'INTEGER', description: '感情の強さ（0〜10）' },
      },
      required: ['primary', 'raw_intensity'],
    },
  },
  required: ['appraisal', 'emotion'],
});

/** 数として読めるものだけ数にする */
function toInt(value, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/**
 * 違反の程度と実害の程度から、感情の素の強さ（0〜10）を出す。
 * 両方 3（最大）なら 10、両方 0 なら 0 になる
 */
function baseIntensity(violationSeverity, distressSeverity) {
  return Math.round(((violationSeverity + distressSeverity) / (SEVERITY_MAX * 2)) * INTENSITY_MAX);
}

// 違反の程度・実害の程度から強さを計算できる感情。
// 喜びや感心には「違反」も「実害」も無いので、この式では必ず 0 になってしまう。
// そちらは Gemini が付けた強さをそのまま使う（代わりになる目安が無いため）
const SEVERITY_BASED = Object.freeze(['anger', 'distress']);

/**
 * 「感情の起伏」のつまみをかけた強さ。
 * 起伏が低いプリセットでは、同じことを言われても反応の振れ幅が小さくなる
 */
function scaledIntensity(base, emotionAxis) {
  const axis = Number.isFinite(emotionAxis) ? emotionAxis : EMOTION_AXIS_STANDARD;
  return Math.max(0, Math.min(INTENSITY_MAX, Math.round((base * axis) / EMOTION_AXIS_STANDARD)));
}

/**
 * Gemini が返した判定を、そのまま信じずに整える。
 * OCC 模型では、怒り（anger）は「非難（基準違反）」と「苦痛（実害）」が両方そろったときの感情なので、
 * 片方しかないのに anger と言ってきたら、片方だけの感情に直す。
 * @param {object} raw Gemini が返した { appraisal, emotion }
 * @param {number} emotionAxis 「感情の起伏」のつまみの値
 */
function normalizeAppraisal(raw, emotionAxis = EMOTION_AXIS_STANDARD) {
  const source = raw?.appraisal ?? {};
  const appraisal = {
    standard_violation: source.standard_violation === true,
    violation_severity: toInt(source.violation_severity, SEVERITY_MAX),
    distress_to_bean: source.distress_to_bean === true,
    distress_severity: toInt(source.distress_severity, SEVERITY_MAX),
    responsible_agent: AGENTS.includes(source.responsible_agent) ? source.responsible_agent : 'none',
  };
  // 「そう判定した」のに程度が 0、という食い違いは、程度のほうを最小の 1 に寄せる
  if (appraisal.standard_violation && appraisal.violation_severity === 0) appraisal.violation_severity = 1;
  if (!appraisal.standard_violation) appraisal.violation_severity = 0;
  if (appraisal.distress_to_bean && appraisal.distress_severity === 0) appraisal.distress_severity = 1;
  if (!appraisal.distress_to_bean) appraisal.distress_severity = 0;

  let primary = Object.keys(EMOTIONS).includes(raw?.emotion?.primary) ? raw.emotion.primary : 'neutral';
  // 怒りは、基準違反と実害が両方そろったときだけ。片方だけなら、呆れか悲しみに直す
  if (primary === 'anger' && !(appraisal.standard_violation && appraisal.distress_to_bean)) {
    primary = appraisal.standard_violation || appraisal.distress_to_bean ? 'distress' : 'neutral';
  }

  // 怒り・悲しみは、程度から計算し直す（Gemini の言い値は同じ場面でもぶれるため）。
  // ただし程度が両方 0 のときは計算できない。喜びに違反も実害も無いのと同じで、
  // 外のこと（原因が external）で悲しいときも 0 に潰れてしまうので、そのときは言い値を使う。
  // どちらにも「感情の起伏」の係数はかける
  const modelIntensity = toInt(raw?.emotion?.raw_intensity, INTENSITY_MAX);
  const fromSeverity =
    SEVERITY_BASED.includes(primary) && (appraisal.violation_severity > 0 || appraisal.distress_severity > 0);
  const base = fromSeverity
    ? baseIntensity(appraisal.violation_severity, appraisal.distress_severity)
    : modelIntensity;
  return {
    appraisal,
    emotion: {
      primary,
      raw_intensity: primary === 'neutral' ? 0 : scaledIntensity(base, emotionAxis),
      // Gemini が言ってきた値も、食い違いを見るために残す
      model_intensity: modelIntensity,
    },
  };
}

/**
 * 実際に出してよい毒舌の強さ。怒っていないときは毒舌を出さない（0）。
 * 怒っているときも、プリセットの毒舌強度（上限）を超えない
 * @returns {number} 0〜10
 */
function effectiveSharpness(result, axes) {
  if (result?.emotion?.primary !== 'anger') return 0;
  const limit = Number.isFinite(axes?.sharp) ? axes.sharp : 0;
  return Math.max(0, Math.min(result.emotion.raw_intensity, limit));
}

/** 判定つきの結果に、実際に出してよい毒舌の強さを足す */
function withSharpness(raw, axes) {
  const result = normalizeAppraisal(raw, axes?.emotion);
  return { ...result, sharpness: effectiveSharpness(result, axes) };
}

/**
 * 判定だけをしてもらう呼び出しの、システムプロンプト。
 * ここには口調の指示を入れない（入れると、判定まで口調に引っぱられる）。
 * NG ラインの確認を1番目に置いてあるので、判定しだいで NG ラインを回り込むことはない
 */
function judgePromptLines(turns = [], now = Date.now()) {
  return [
    'あなたは、デスクトップマスコット「まめ」の感情を判定する係です。',
    '返事は書きません。ユーザーの最後の発言に対する判定だけを返してください。',
    '',
    '1. まず、次のどれかに当たる話題かを確かめる。',
    ...TONE_NG_ITEMS.map((item) => `   - ${item}`),
    '   当たるときは、emotion.primary を neutral、appraisal はすべて false / 0 にして終わり。',
    '',
    '2. 当たらないときだけ、ユーザーの最後の発言を次の2点で見る。',
    '   - standard_violation: 言い方や中身が、まめとして見過ごせない線を超えたか',
    '   - distress_to_bean: それでまめ自身が嫌な思いをしたか',
    '   それぞれの程度を 0〜3 で付ける（0=まったく、1=わずか、2=はっきり、3=ひどい）。',
    '',
    '   両方 true にする（＝怒ってよい）のは、まめに向けた次のようなとき:',
    '   - 侮辱・ののしり（「ばか」「役立たず」「使えない」「黙れ」「きもい」）',
    '   - 能力や存在の否定（「お前に聞いた俺がバカだった」「いる意味ある？」）',
    '   - しつこい嫌がらせ（同じ煽りを繰り返す、わざと困らせる）',
    '',
    '   まめが直前にきつい返事をしていても、「仕返しだから仕方ない」とは考えないでください。',
    '   ユーザーの最後の発言そのものだけを見て決めます。',
    '',
    '   どちらも false / 0 にするのは:',
    '   - ふつうの雑談・質問・相談・あいさつ・お礼',
    '   - そっけない相づちや短い返事（「はいはい」「別に」「ふーん」「で？」「いやない」）',
    '   - ユーザー自身を責める言葉（「僕は馬鹿だ」）。まめへの攻撃ではありません',
    '   - まめの様子への感想（「怒りっぽいな」「とげがあるね」）。事実の指摘です',
    '',
    '3. 感情を決める。',
    '   - 2つとも true のときだけ anger。片方だけなら distress。',
    '   - お礼・褒め言葉・良い知らせには、必ず joy を付けてください（neutral にしない）。',
    '   - 良い知らせ・褒められた → joy、相手の行いに感心 → admiration、',
    '     自分の出来に誇り → pride、自分の失敗 → shame、どれでもない → neutral。',
    '   - raw_intensity は 0〜10。joy などはここで付けた値がそのまま使われます。',
    ...moodPromptLines(turns, now),
  ];
}

/**
 * 直前の何ターンかの感情。判定の呼び出しに渡して、感情の引きずりを出す。
 * 会話の要約（7日ルール）とは別で、短い期間の感情だけを持つ
 */
function moodPromptLines(turns, now = Date.now()) {
  const recent = (turns ?? []).slice(-MOOD_PROMPT_TURNS).filter((turn) => turn?.emotion);
  if (recent.length === 0) return [];
  return [
    '',
    '直前のやりとりで、まめは次のように感じていました。判定の参考にしてください。',
    ...recent.map((turn) => `- ${describeAgo(now - turn.at)}: ${EMOTIONS[turn.emotion] ?? EMOTIONS.neutral}（強さ ${turn.intensity ?? 0}）`),
    'ただし、直前が怒りでも、今の発言に悪いところが無ければ false / 0 にしてください。',
  ];
}

/**
 * 返事を書く呼び出しに足す、今の感情の伝え方。
 * 毒舌の強さは口調の指示のほうで差し替えるので、ここでは向きだけを伝える
 */
function emotionPromptLines(result) {
  const { primary, raw_intensity: intensity } = result.emotion;
  if (primary === 'neutral') return [];
  const lines = ['', `【今の気持ち】いまのまめは ${EMOTIONS[primary]}（強さ ${intensity}／10）を感じています。`];
  if (primary === 'anger') {
    lines.push('この気持ちを、上の毒舌強度の範囲で返事に出してください。');
  } else if (primary === 'distress') {
    lines.push('ただし毒舌にはしないでください。少しトーンを落として答えます。');
  } else {
    lines.push('この気持ちを返事のテンションに出してください。毒舌は使いません。');
  }
  return lines;
}

/** どれくらい前か。プロンプトに入れるので短く */
function describeAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}時間前` : `${Math.floor(hours / 24)}日前`;
}

// 残しておく感情の数と、判定に渡す数
const MOOD_KEEP_TURNS = 5;
const MOOD_PROMPT_TURNS = 4;
// これより古い感情は引きずらない（寝て起きたら忘れる）
const MOOD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

class MoodLog {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
  }

  /** 直近の感情。古すぎるものは外す */
  load(now = Date.now()) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const turns = Array.isArray(raw?.turns) ? raw.turns : [];
      return turns
        .filter((turn) => Number.isFinite(turn?.at) && now - turn.at <= MOOD_MAX_AGE_MS && EMOTIONS[turn.emotion])
        .slice(-MOOD_KEEP_TURNS);
    } catch {
      return [];
    }
  }

  /** 1ターンぶんを書き足す。書けなくても会話は止めない */
  record(turn, now = Date.now()) {
    const turns = [...this.load(now), turn].slice(-MOOD_KEEP_TURNS);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, turns }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[appraisal] 気分を記録できませんでした:', err.message);
    }
    return turns;
  }

  /** 口調を変えたときは、前の口調で出た感情を引きずらせない */
  clear() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, turns: [] }, null, 2), 'utf8');
    } catch {
      // 消せなくても会話は止めない
    }
  }
}

module.exports = {
  EMOTIONS,
  AGENTS,
  SEVERITY_MAX,
  INTENSITY_MAX,
  EMOTION_AXIS_STANDARD,
  SEVERITY_BASED,
  MOOD_KEEP_TURNS,
  MOOD_PROMPT_TURNS,
  MOOD_MAX_AGE_MS,
  APPRAISAL_SCHEMA,
  MoodLog,
  baseIntensity,
  scaledIntensity,
  normalizeAppraisal,
  effectiveSharpness,
  withSharpness,
  judgePromptLines,
  moodPromptLines,
  emotionPromptLines,
};
