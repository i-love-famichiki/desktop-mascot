'use strict';

// Gemini API で返事をもらう。キーは設定で選んだ環境変数か、設定画面で入れたもの（api-key.js）。
// どのモデルを使うかは設定で選ぶ（settings.geminiModel、選択肢は settings.js の GEMINI_MODELS）

const { net } = require('electron');
const state = require('./state');
const { GEMINI_MODELS } = require('../lib/settings');
const { tonePromptLines } = require('../lib/tone');
const { createSseParser } = require('../lib/sse');
const { localDateKey } = require('../lib/calendar');

function currentModel() {
  return GEMINI_MODELS.find((model) => model.id === state.settings.geminiModel) ?? GEMINI_MODELS[0];
}

/** 話しかけるさきの URL。会話の返事は、できた分から少しずつ受け取る（alt=sse で Server-Sent Events の形になる） */
function geminiEndpoint(stream) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel().id}`;
  return stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
}

// 無料枠のキーは後回しにされるようで、検索なしでも 20〜30 秒かかった（2026-09-24 に測定。有料枠は 1 秒前後）。
// 30 秒だとときどき時間切れになったので、60 秒まで待つ
const GEMINI_TIMEOUT_MS = 60 * 1000;

// 吹き出しに添える出典の数の上限（小さい吹き出しなので少なめに）
const SOURCES_MAX = 3;

class GeminiError extends Error {
  /** @param {'no-key' | 'bad-key' | 'rate-limit' | 'blocked' | 'network' | 'timeout' | 'failed'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// 使ったトークンを数える（課金の内訳を確かめるとき用）
// ---------------------------------------------------------------------------
// 請求の画面に回数や内訳が出ないので、日ごと・モデルごとの合計をいつも token-log.json に残しておく。
// 画面に出すのは、MASCOT_DEBUG_TOKENS=1 を付けて起動したときだけ
const DEBUG_TOKENS = process.env.MASCOT_DEBUG_TOKENS === '1';

/** 1回ぶんを記録する。検索（グラウンディング）が走ったかも数える */
function logTokens(chunks) {
  const usage = chunks.findLast((chunk) => chunk?.usageMetadata)?.usageMetadata;
  if (!usage) return;
  const model = currentModel().id;
  const searched = chunks.some((chunk) => chunk?.candidates?.[0]?.groundingMetadata);
  const total = state.tokenLog.record({ date: localDateKey(Date.now()), model, usage, searched });
  if (!DEBUG_TOKENS) return;

  console.log(
    `[tokens] ${model} 入力 ${usage.promptTokenCount ?? 0} / 出力 ${usage.candidatesTokenCount ?? 0} / 考えた分 ${usage.thoughtsTokenCount ?? 0}${searched ? ' / 検索あり' : ''}`,
    `｜今日このモデルで ${total.requests}回 入力 ${total.prompt} / 出力 ${total.output} / 考えた分 ${total.thoughts} / 検索 ${total.searches}回`,
  );
}

/** 入力の何が長いのかを、文字数で見る（トークンではないが、削る所を探すには十分） */
function logPromptParts(systemPrompt, contents) {
  // 要約のときは口調を入れないので、入っている回だけ数える
  const tone = tonePromptLines(state.settings.tonePresets, state.settings.tonePresetIndex).join('\n');
  const toneChars = systemPrompt.includes('【まめの口調設定】') ? tone.length : 0;
  const talkChars = JSON.stringify(contents).length;
  console.log(
    `[tokens] 入力の中身（文字数）: システム ${systemPrompt.length}`,
    `（うち口調 ${toneChars}）／ 送った会話 ${talkChars}`,
  );
}

// タイマーの登録や昔の会話探しで、道具を使う → 結果を返す、を繰り返す回数の上限
// （探して見つからず、言葉を変えてもう一度探すこともあるので少し余裕を持たせる）
const MAX_TOOL_ROUNDS = 4;

/**
 * Gemini API を呼んで、返事の本文と出典を返す。
 * 会話では Google 検索を道具として渡しておき、検索するかどうかはモデルが決める。
 * 要約のときは tools を空にして検索させない。
 * onDelta を渡すと、返事をできた分から少しずつ受け取り、届くたびに本文の続きを渡す。
 * functions を渡すと、モデルがそれを呼んだときに実行して結果を返し、続きの返事をもらう。
 * @param {{ declarations: object[], call: (functionCall: { name: string, args?: object }) => object } | null} [options.functions]
 * @returns {Promise<{ text: string, sources: { title: string, uri: string }[] }>}
 */
async function askGemini(
  contents,
  {
    systemPrompt,
    tools = [{ google_search: {} }],
    onDelta = null,
    functions = null,
    schema = null,
    // 検索つきの1回目が 429 で断られたとき、検索なしでやり直すための指示文を返す関数（会話だけで使う）
    searchRefusedPrompt = null,
  } = {},
) {
  const apiKey = state.apiKeys.get(state.settings.apiKeySource);
  if (!apiKey) throw new GeminiError('no-key', `API キーが見つかりません（${state.settings.apiKeySource}）`);

  let allTools = functions ? [...tools, { functionDeclarations: functions.declarations }] : tools;
  if (DEBUG_TOKENS) logPromptParts(systemPrompt, contents);
  const texts = [];
  let finishReason;
  let groundingMetadata;

  const config = generationConfig(schema);

  for (let round = 1; ; round++) {
    let chunks;
    try {
      chunks = await requestGemini(apiKey, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(allTools.length > 0 && { tools: allTools }),
        // Google 検索と自作の道具を一緒に渡すときは、この指定が要る
        ...(functions && tools.length > 0 && { toolConfig: { includeServerSideToolInvocations: true } }),
        ...(config && { generationConfig: config }),
      }, onDelta);
    } catch (err) {
      // 無料枠のキーは、検索つきだと毎回 429 で断られる（断られるのは 0.4 秒ほどで、すぐ分かる）。
      // 1回目なら道具はまだ何も動かしていないので、検索だけ外してやり直しても二重にならない
      const searching = tools.some((tool) => tool.google_search);
      if (!(err instanceof GeminiError && err.kind === 'rate-limit' && round === 1 && searching && searchRefusedPrompt)) throw err;
      console.warn('[gemini] 検索つきで断られたので、検索なしでやり直します');
      tools = tools.filter((tool) => !tool.google_search);
      allTools = functions ? [...tools, { functionDeclarations: functions.declarations }] : tools;
      systemPrompt = searchRefusedPrompt();
      searchRefusedPrompt = null;
      round -= 1;
      continue;
    }

    logTokens(chunks);

    // 少しずつ受け取ったときは、本文をつなげ、終わり方と検索の情報は最後に来たものを使う
    const blockReason = chunks.find((chunk) => chunk?.promptFeedback?.blockReason)?.promptFeedback.blockReason;
    if (blockReason) {
      throw new GeminiError('blocked', `blockReason=${blockReason}`);
    }

    const candidates = chunks.map((chunk) => chunk?.candidates?.[0]).filter(Boolean);
    texts.push(candidates.map(candidateText).join(''));
    finishReason = candidates.findLast((candidate) => candidate.finishReason)?.finishReason ?? finishReason;
    groundingMetadata = candidates.findLast((candidate) => candidate.groundingMetadata)?.groundingMetadata ?? groundingMetadata;

    const parts = candidates.flatMap((candidate) => candidate.content?.parts ?? []);
    const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
    if (!functions || calls.length === 0 || round >= MAX_TOOL_ROUNDS) break;

    // モデルの発言（thoughtSignature も含めてそのまま）と道具の結果を足して、続きをもらう
    contents = [
      ...contents,
      { role: 'model', parts },
      {
        role: 'user',
        parts: await Promise.all(
          calls.map(async (call) => ({
            functionResponse: { name: call.name, ...(call.id && { id: call.id }), response: await functions.call(call) },
          })),
        ),
      },
    ];
  }

  const text = texts.join('').trim();
  if (!text) {
    throw new GeminiError(
      finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' ? 'blocked' : 'failed',
      `返事が空でした finishReason=${finishReason}`,
    );
  }

  return {
    text,
    sources: extractSources(groundingMetadata),
    searchSuggestions: extractSearchSuggestions(groundingMetadata),
  };
}

/**
 * 1回のリクエストに付ける generationConfig。要らないときは null。
 * 内部で考えた分も出力として課金されるので、雑談では考えさせない。
 * 止められないモデル（lite や Pro）に thinkingConfig を送ると 400 になるので、止められるモデルにだけ付ける
 */
function generationConfig(schema) {
  const config = {
    ...(currentModel().stopThinking && { thinkingConfig: { thinkingBudget: 0 } }),
    // 決まった形で返してもらう。Google 検索や自作の道具と一緒に使っても問題ないことは確認済み
    ...(schema && { responseMimeType: 'application/json', responseSchema: schema }),
  };
  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Gemini API に1回リクエストして、届いた塊（JSON）を順に並べて返す。
 * 少しずつ受け取るときは、本文が届くたびに onDelta へ渡す。
 */
async function requestGemini(apiKey, body, onDelta) {
  let res;
  let chunks;
  try {
    // Chromium の通信機能を使う（OS の証明書ストアを使うので、セキュリティソフトの割り込みにも強い）
    // 時間切れは、返事を最後まで受け取り終わるまでを数える
    res = await net.fetch(geminiEndpoint(Boolean(onDelta)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });

    // 失敗のときは、少しずつ受け取る形でもふつうの JSON が1つ返ってくる
    if (!res.ok || !onDelta) {
      chunks = [await res.json().catch(() => null)];
    } else {
      chunks = await readStream(res, onDelta);
    }
  } catch (err) {
    throw err.name === 'TimeoutError'
      ? new GeminiError('timeout', `${GEMINI_TIMEOUT_MS}ms 以内に応答がありませんでした`)
      : new GeminiError('network', err.message);
  }

  if (!res.ok) {
    const error = chunks[0]?.error;
    const detail = `status=${res.status} ${error?.status ?? ''} ${error?.message ?? ''}`;
    const reason = error?.details?.find((d) => d.reason)?.reason;
    if (reason === 'API_KEY_INVALID' || res.status === 401 || res.status === 403) {
      throw new GeminiError('bad-key', detail);
    }
    if (res.status === 429) throw new GeminiError('rate-limit', detail);
    throw new GeminiError('failed', detail);
  }
  return chunks;
}

/** 返事の本文（考えている途中の文は除く） */
function candidateText(candidate) {
  return (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('');
}

/** 少しずつ届く返事を最後まで読み、届いた塊（JSON）を順に並べて返す。本文は届くたびに onDelta へ */
async function readStream(res, onDelta) {
  const chunks = [];
  const parser = createSseParser((data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // 読めない塊は飛ばす
    }
    chunks.push(chunk);
    const delta = candidateText(chunk?.candidates?.[0]);
    if (delta) onDelta(delta);
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
  return chunks;
}

/**
 * 検索を使った返事なら、Google の規約で表示が求められている「検索候補」を取り出す。
 * html は Google が作った表示用の HTML（そのまま使う）、queries は実際に検索した言葉。
 * 検索しなかった返事では null。
 */
function extractSearchSuggestions(groundingMetadata) {
  const html = groundingMetadata?.searchEntryPoint?.renderedContent;
  const queries = (groundingMetadata?.webSearchQueries ?? []).filter((q) => typeof q === 'string' && q.trim());
  if (!html && queries.length === 0) return null;
  return { html: typeof html === 'string' ? html : '', queries };
}

/** Google 検索の結果ページの URL か（検索候補のリンクはこれだけを開く） */
function isGoogleSearchUrl(url) {
  try {
    const { protocol, hostname, pathname } = new URL(url);
    return protocol === 'https:' && /^(www\.)?google\.[a-z.]+$/.test(hostname) && pathname === '/search';
  } catch {
    return false;
  }
}

/**
 * 検索を使った返事なら、groundingMetadata から出典（サイト名とリンク）を取り出す。
 * 同じサイトが何度も出てくるので名前でまとめ、先頭から数件だけにする。
 * リンクは Google の転送用 URL で、開くと元のページに移る。
 */
function extractSources(groundingMetadata) {
  const sources = [];
  for (const chunk of groundingMetadata?.groundingChunks ?? []) {
    const { title, uri } = chunk.web ?? {};
    if (!uri || sources.some((source) => source.title === title)) continue;
    sources.push({ title: title || 'リンク', uri });
    if (sources.length >= SOURCES_MAX) break;
  }
  return sources;
}

function describeError(err) {
  console.error('[gemini]', err.message);
  switch (err instanceof GeminiError && err.kind) {
    case 'no-key':
      return 'APIキーが見つからないみたい。設定の「KEY」タブで、キーを選ぶか入れてね。';
    case 'bad-key':
      return 'APIキーが正しくないみたい。設定の「KEY」タブで、キーを確かめてね。';
    case 'rate-limit':
      // 無料枠のキーでは、検索つきの呼び出しが毎回ここに来る
      return state.settings.webSearch
        ? '喋りすぎたか、検索の利用上限に達したかもしれない。少し待ってからまた話しかけて。無料枠のキーなら、設定で「Google 検索を使う」を切ると話せるよ。'
        : '喋りすぎたみたい。少し待ってからまた話しかけて。';
    case 'blocked':
      return 'ごめん、その話にはうまく答えられないみたい。';
    case 'network':
      return 'ネットにつながらないみたい。';
    case 'timeout':
      return '考えこみすぎちゃったみたい。もう一回話しかけて。';
    default:
      return 'エラーが起きたみたい。ちょっと待ってからまた話しかけて。';
  }
}

module.exports = { currentModel, askGemini, describeError, isGoogleSearchUrl, DEBUG_TOKENS };
