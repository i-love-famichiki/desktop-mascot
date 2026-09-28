'use strict';

// 口調（6つのつまみと、5つのプリセット）と、感情の評価（Appraisal）
// 変えた口調は、次の返事から効く（システムプロンプトは話しかけるたびに作り直すため）。
// 1番目のプリセットは今までの口調そのままなので、つまみは保存するだけで返事には使わない

const { ipcMain } = require('electron');
const state = require('./state');
const { askGemini, DEBUG_TOKENS } = require('./gemini');
const { settingsState, fromSettingsWindow } = require('./settings-panel');
const {
  TONE_AXES,
  TONE_PRESET_COUNT,
  PLAIN_TONE_PRESET_INDEX,
  clampAxisValue,
  normalizeToneName,
  normalizeTonePresetIndex,
} = require('../tone');
const { APPRAISAL_SCHEMA, SEVERITY_BASED, judgePromptLines, withSharpness } = require('../appraisal');

/** 6つのつまみを使うプリセットを選んでいるか（1番目は今までの口調そのまま） */
function usingTonePreset() {
  return state.settings.tonePresetIndex !== PLAIN_TONE_PRESET_INDEX;
}

/** 今使っているプリセットのつまみ */
function currentToneAxes() {
  return state.settings.tonePresets[normalizeTonePresetIndex(state.settings.tonePresetIndex)].axes;
}

/**
 * 感情の評価（Appraisal）を使うか。
 * 1番目のプリセット（今までの口調）のときは、口調の指示ごと足さないので使わない
 */
function usingAppraisal() {
  return usingTonePreset();
}

// 判定に渡す会話の数（往復）。直前の流れが分かれば足りるので短く切る
const JUDGE_HISTORY_TURNS = 2;

/**
 * 返事を書く前に、今の発言をどう受け取ったかだけを判定してもらう。
 * 口調も検索も道具も渡さないので、入力は 600 字ほどで済む。
 * 判定できなかったときは null を返し、呼び出し元は毒舌なしとして扱う
 * （通信が失敗したからといって、刺してよいことにはしないため）
 */
async function judgeAppraisal(userText) {
  const messages = state.store.messages.slice(-JUDGE_HISTORY_TURNS * 2);
  const contents = [
    ...messages.map((message) => ({
      role: message.role === 'user' ? 'user' : 'model',
      parts: [{ text: message.content }],
    })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  try {
    const { text } = await askGemini(contents, {
      systemPrompt: judgePromptLines(state.moodLog.load()).join('\n'),
      tools: [],
      schema: APPRAISAL_SCHEMA,
    });
    return withSharpness(JSON.parse(text), currentToneAxes());
  } catch (err) {
    console.warn('[appraisal] 判定できませんでした。この回は毒舌なしで返します:', err.message);
    // 判定なし = 毒舌なし。記録には残さない（本当に そう感じた わけではないため）
    return { ...withSharpness(null, currentToneAxes()), failed: true };
  }
}

/**
 * 1ターンぶんの感情を残す。
 * 上限（毒舌強度）で抑えた回は、どれくらい抑えたかを残しておく
 */
function recordMood(result) {
  const { appraisal, emotion, sharpness } = result;
  const limit = currentToneAxes().sharp;
  if (emotion.primary === 'anger' && emotion.raw_intensity > limit) {
    console.log(`[appraisal] 怒りの強さ ${emotion.raw_intensity} を、毒舌強度 ${limit} まで抑えて返事を書かせました`);
  }
  // 程度から計算し直している感情だけ、Gemini の言い値とのずれを見る
  // （喜びなどは言い値をそのまま使うので、比べても意味がない）
  if (SEVERITY_BASED.includes(emotion.primary) && Math.abs(emotion.model_intensity - emotion.raw_intensity) >= 4) {
    console.warn(`[appraisal] 強さの食い違い: Gemini ${emotion.model_intensity} / 計算 ${emotion.raw_intensity}`);
  }
  if (DEBUG_TOKENS) {
    console.log(
      `[appraisal] ${emotion.primary} 強さ ${emotion.raw_intensity} / 毒舌 ${sharpness}（上限 ${limit}）`,
      `｜違反 ${appraisal.violation_severity} 実害 ${appraisal.distress_severity} 原因 ${appraisal.responsible_agent}`,
    );
  }
  state.moodLog.record({ at: Date.now(), emotion: emotion.primary, intensity: emotion.raw_intensity, sharpness });
}

/** 今日、口調を変えた時刻。今日変えていなければ 0 */
function toneChangedToday() {
  const changedAt = state.settings.toneChangedAt;
  return changedAt && changedAt >= new Date().setHours(0, 0, 0, 0) ? changedAt : 0;
}

function saveTone(next) {
  state.updateSettings(next);
  // 口調を変えたら、前の口調で出た感情は引きずらせない（毒舌 9 で怒った気分を、優しいプリセットに持ち込まない）
  if (next.toneChangedAt) state.moodLog.clear();
  state.settingsChanged();
}

/** 画面から来た番号が、5つのプリセットのどれかであること */
function isTonePresetIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < TONE_PRESET_COUNT;
}

/** そのプリセットだけを差し替えた、新しい一覧 */
function tonePresetsWith(index, preset) {
  return state.settings.tonePresets.map((current, i) => (i === index ? preset : current));
}

// 使うプリセットを切り替える（次に起動したときも、ここで選んだものに戻る）
ipcMain.handle('settings:select-tone-preset', (event, index) => {
  const at = Number(index);
  if (fromSettingsWindow(event) && isTonePresetIndex(at) && at !== state.settings.tonePresetIndex) {
    saveTone({ tonePresetIndex: at, toneChangedAt: Date.now() });
  }
  return settingsState();
});

// つまみを1つ動かす。範囲の外の値は、その軸で選べる値に丸める
ipcMain.handle('settings:set-tone-axis', (event, index, axisId, value) => {
  const at = Number(index);
  const axis = TONE_AXES.find((item) => item.id === axisId);
  if (fromSettingsWindow(event) && isTonePresetIndex(at) && axis) {
    const preset = state.settings.tonePresets[at];
    saveTone({
      tonePresets: tonePresetsWith(at, { ...preset, axes: { ...preset.axes, [axis.id]: clampAxisValue(axis, value) } }),
      // 今使っているプリセットのつまみを動かしたときも、口調が変わったことになる
      ...(at === state.settings.tonePresetIndex && usingTonePreset() && { toneChangedAt: Date.now() }),
    });
  }
  return settingsState();
});

// プリセットの名前を付け替える。空にしたときは、もとの名前（「プリセット2」など）に戻す
ipcMain.handle('settings:rename-tone-preset', (event, index, name) => {
  const at = Number(index);
  if (fromSettingsWindow(event) && isTonePresetIndex(at)) {
    saveTone({ tonePresets: tonePresetsWith(at, { ...state.settings.tonePresets[at], name: normalizeToneName(name, at) }) });
  }
  return settingsState();
});

module.exports = { usingTonePreset, usingAppraisal, judgeAppraisal, recordMood, toneChangedToday };
