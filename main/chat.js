'use strict';

// Gemini との会話（話しかけられたときの返事と、古い会話の要約）

const { ipcMain, shell } = require('electron');
const state = require('./state');
const { askGemini, describeError } = require('./gemini');
const { buildSystemPrompt, buildContents } = require('./prompt');
const { toolGroups, chatFunctions } = require('./tools');
const { usingAppraisal, judgeAppraisal, recordMood } = require('./mood');
const { clip } = require('./format');

// 1回の発言も長すぎると文脈を圧迫するので上限を設けておく
const USER_TEXT_MAX_CHARS = 2000;

// 古い会話の要約。1日分の会話ログは長すぎる分を切ってから送り、要約も短く切る
const SUMMARY_SOURCE_MAX_CHARS = 8000;
const SUMMARY_MAX_CHARS = 150;
const SUMMARY_PROMPT = [
  'あなたは会話ログを短くまとめる係です。',
  'ユーザーとデスクトップマスコットの1日分の会話ログを、日本語で1〜2文（100文字程度まで）に要約してください。',
  '話題と、ユーザーについて分かったこと（名前、好み、予定、困っていることなど）を優先して残してください。',
  'あいさつや短い雑談だけの日は「軽い雑談のみ」のように短く書いてください。',
  '後から読んでも分かるよう、「明日」「来週の月曜」などは会話の日付をもとに「9月14日」のような日付に直してください。',
  '前置きや箇条書きは使わず、要約の文だけを返してください。',
].join('\n');

// 返事を待っている間に次の発言が来ても、1つずつ順番に処理する
let chatQueue = Promise.resolve();

ipcMain.handle('chat:send', (event, userText) => {
  // 届いた分の返事を、その都度レンダラーへ送って吹き出しに流す
  const sender = event.sender;
  const onDelta = (delta) => {
    if (!sender.isDestroyed()) sender.send('chat:delta', delta);
  };
  const reply = chatQueue.then(() => chat(clip(String(userText), USER_TEXT_MAX_CHARS), onDelta));
  chatQueue = reply.catch(() => {});
  return reply;
});

// 履歴の表示用。古い会話の要約と、直近7日の詳しい会話を渡す
ipcMain.handle('chat:history', () => ({
  summaries: state.store.summaries.map(({ date, summary }) => ({ date, summary })),
  messages: state.store.messages.map(({ role, content, at }) => ({ role, content, at })),
}));

async function chat(userText, onDelta) {
  try {
    const groups = toolGroups(userText);
    // 先に感情だけを判定し、その結果で毒舌の指示を差し替えてから返事を書かせる。
    // 同じ呼び出しで両方やらせると、判定が 0 でも口調の指示に引っぱられて刺してしまう（appraisal.js）
    const appraisal = usingAppraisal() ? await judgeAppraisal(userText) : null;
    const { text, sources, searchSuggestions } = await askGemini(buildContents(state.store.messages, userText), {
      onDelta,
      systemPrompt: buildSystemPrompt(groups, appraisal),
      tools: state.settings.webSearch ? [{ google_search: {} }] : [],
      searchRefusedPrompt: () => buildSystemPrompt(groups, appraisal, 'refused'),
      functions: chatFunctions(groups),
    });
    if (appraisal && !appraisal.failed) recordMood(appraisal);
    // 返事を表示するのに保存の完了は待たない（失敗しても store 側でログに出す）
    state.store.append(
      { role: 'user', content: userText, at: Date.now() },
      { role: 'assistant', content: text, at: Date.now() },
    ).catch(() => {});

    return { ok: true, text, sources, searchSuggestions };
  } catch (err) {
    return { ok: false, text: describeError(err), sources: [], searchSuggestions: null };
  }
}

// 出典のリンクは既定のブラウザで開く。http(s) 以外は開かない
ipcMain.on('link:open', (_event, url) => {
  try {
    const { protocol } = new URL(String(url));
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(String(url));
  } catch {
    // URL として読めないものは無視する
  }
});

/**
 * 1日分の会話を Gemini で1〜2文に要約する（検索は使わない）。
 * @param {string} date
 * @param {{ role: string, content: string }[]} messages
 */
async function summarizeDay(date, messages) {
  const log = messages
    .map((message) => `${message.role === 'user' ? 'ユーザー' : 'マスコット'}: ${message.content}`)
    .join('\n');
  // 「来週の月曜」などを日付に直せるよう、曜日も添える
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(year, month - 1, day).toLocaleDateString('ja-JP', { weekday: 'short' });
  const { text } = await askGemini(
    [{ role: 'user', parts: [{ text: `${date}（${weekday}）の会話ログ:\n${clip(log, SUMMARY_SOURCE_MAX_CHARS)}` }] }],
    { systemPrompt: SUMMARY_PROMPT, tools: [] },
  );
  // 吹き出しや一覧で扱いやすいよう1行にまとめる
  return clip(text.replace(/\s*\n\s*/g, ' '), SUMMARY_MAX_CHARS);
}

module.exports = { summarizeDay };
