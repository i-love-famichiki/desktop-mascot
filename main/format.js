'use strict';

// 日時や文の長さをそろえる小さな関数（メインプロセスのあちこちで使う）

/** 経過時間を「5分前」「3時間前」「2日前」のように言い表す */
function describeElapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/** 発言の日時を「9月16日 21:33」の形にする */
function formatMessageTime(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 「2026-09-17T20:13:00+09:00」のような、この PC の時刻とタイムゾーンでの ISO 8601 */
function localIsoString(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

function clip(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

module.exports = { describeElapsed, formatMessageTime, localIsoString, clip };
