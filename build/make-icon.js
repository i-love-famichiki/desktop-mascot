'use strict';

// exe とインストーラーのアイコン（build/icon.png、256px）を、index.html の豆の絵から作る。
// 使い方: npm run icon
// 画面の豆は CSS で色を付けているので、ここでは色を SVG に直接書いている。
// 豆の形を変えたら、ここの path も合わせて変えること。

const path = require('path');
const sharp = require('sharp');

const SIZE = 256;

// 影は付けず、豆だけを正方形の真ん中に置く（viewBox で余白を調整）
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 -10 180 180" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="beanGrad" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#c9ef8a" />
      <stop offset="0.5" stop-color="#8fd14f" />
      <stop offset="1" stop-color="#5aa832" />
    </radialGradient>
  </defs>
  <g transform="rotate(-10 100 80)">
    <path d="M30 80 C26 40 70 18 110 22 C156 26 182 52 178 88 C174 122 140 138 104 132 C88 129 80 118 66 120 C44 124 32 108 30 80 Z"
      fill="url(#beanGrad)" stroke="#3d6b1f" stroke-width="8" stroke-linejoin="round" />
    <path d="M78 116 Q92 125 108 124" fill="none" stroke="#3d6b1f" stroke-opacity="0.6" stroke-width="6" stroke-linecap="round" />
    <ellipse cx="76" cy="50" rx="24" ry="11" transform="rotate(-18 76 50)" fill="#fff" fill-opacity="0.45" />
    <ellipse cx="150" cy="60" rx="6" ry="4" fill="#fff" fill-opacity="0.3" />
  </g>
</svg>`;

const out = path.join(__dirname, 'icon.png');
sharp(Buffer.from(svg))
  .png()
  .toFile(out)
  .then(() => console.log('アイコンを作りました:', out))
  .catch((err) => {
    console.error('アイコンを作れませんでした:', err.message);
    process.exitCode = 1;
  });
