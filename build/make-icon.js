'use strict';

// exe とインストーラーのアイコン（build/icon.png、256px）を、index.html の豆の絵から作る。
// 使い方: npm run icon（Electron で動かす。画像変換のためのパッケージは入れない）
// 画面の豆は CSS で色を付けているので、ここでは色を SVG に直接書いている。
// 豆の形を変えたら、ここの path も合わせて変えること。

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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

// 見えないウィンドウに SVG を描き、その画面をそのまま PNG にする
async function main() {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`;
  // 描き終わった画面は paint で届く。読み込み後に届いた最初の1枚を使う
  const painted = new Promise((resolve) => {
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (loaded && !image.isEmpty()) resolve(image);
    });
  });
  let loaded = false;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  loaded = true;
  win.webContents.invalidate();
  const image = await painted;
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log('アイコンを作りました:', out);
}

app.whenReady()
  .then(main)
  .catch((err) => {
    console.error('アイコンを作れませんでした:', err.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
