'use strict';

// タスクトレイのアイコン（assets/tray.png など）を、index.html の豆の絵から作る。
// 使い方: npm run tray-icon（Electron で動かす。画像変換のためのパッケージは入れない）
// トレイは 16px と小さいので、exe 用（make-icon.js）より豆を大きく置き、線を太くし、
// 小さいつやは省く。豆の形を変えたら、ここの path も合わせて変えること。
//
// 画面の拡大率（125%、150% など）に合わせて、Electron が tray@1.5x.png などを自動で選ぶ

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// 拡大率 → 大きさ（px）。Windows のトレイは 100% で 16px
const SIZES = [
  { suffix: '', size: 16 },
  { suffix: '@1.25x', size: 20 },
  { suffix: '@1.5x', size: 24 },
  { suffix: '@2x', size: 32 },
];

// 豆のまわりの余白を詰めて、四角いっぱいに置く（viewBox の1辺は 164）
const VIEW = 164;

function svg(size) {
  // 線の太さは px で決め、viewBox の単位に直す（小さくても線が消えないように）
  const unit = VIEW / size;
  const outline = 1.3 * unit;
  const hilum = 1.1 * unit;
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="22 -12 ${VIEW} ${VIEW}" width="${size}" height="${size}">
  <defs>
    <radialGradient id="beanGrad" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#c9ef8a" />
      <stop offset="0.5" stop-color="#8fd14f" />
      <stop offset="1" stop-color="#5aa832" />
    </radialGradient>
  </defs>
  <g transform="rotate(-10 100 80)">
    <path d="M30 80 C26 40 70 18 110 22 C156 26 182 52 178 88 C174 122 140 138 104 132 C88 129 80 118 66 120 C44 124 32 108 30 80 Z"
      fill="url(#beanGrad)" stroke="#2f5718" stroke-width="${outline}" stroke-linejoin="round" />
    <path d="M78 116 Q92 125 108 124" fill="none" stroke="#2f5718" stroke-opacity="0.8" stroke-width="${hilum}" stroke-linecap="round" />
    <ellipse cx="78" cy="52" rx="26" ry="12" transform="rotate(-18 78 52)" fill="#fff" fill-opacity="0.6" />
    ${size >= 32 ? '<ellipse cx="150" cy="60" rx="7" ry="5" fill="#fff" fill-opacity="0.35" />' : ''}
  </g>
</svg>`;
}

// 画面の拡大率に左右されず、ちょうどの px で描く
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// 大きさごとにウィンドウを作って閉じるので、閉じても終了しないようにする
app.on('window-all-closed', () => {});

/** 見えないウィンドウに SVG を描き、その画面を PNG にする */
async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  let loaded = false;
  const painted = new Promise((resolve) => {
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (loaded && !image.isEmpty()) resolve(image);
    });
  });
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg(size)}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  loaded = true;
  win.webContents.invalidate();
  const image = await painted;
  win.destroy();
  // ウィンドウが指定より大きく作られることがあるので、左上の size 四方だけを使う
  return image.crop({ x: 0, y: 0, width: size, height: size }).toPNG();
}

async function main() {
  for (const { suffix, size } of SIZES) {
    const out = path.join(__dirname, '..', 'assets', `tray${suffix}.png`);
    fs.writeFileSync(out, await render(size));
    console.log(`トレイのアイコンを作りました（${size}px）:`, out);
  }
}

app.whenReady()
  .then(main)
  .catch((err) => {
    console.error('トレイのアイコンを作れませんでした:', err.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
