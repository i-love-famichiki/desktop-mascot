'use strict';

// ドロップされた画像を小さくする（中身は image-compress.js）

const { app, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { parseCompressCommand, compressImages, describeResult } = require('../image-compress');

// 置き場所はいつもデスクトップ。テストのときは MASCOT_OUTPUT_DIR で差し替えられる
function compressOutputDir() {
  return process.env.MASCOT_OUTPUT_DIR ? path.resolve(process.env.MASCOT_OUTPUT_DIR) : app.getPath('desktop');
}

ipcMain.handle('image:compress', async (event, paths, text) => {
  const command = parseCompressCommand(text);
  if (!command || command.kind === 'cancel') return { status: command ? 'cancel' : 'unknown' };

  const files = (Array.isArray(paths) ? paths : []).filter((file) => typeof file === 'string' && file);
  const sender = event.sender;
  const result = await compressImages({
    paths: files,
    command,
    outDir: compressOutputDir(),
    nativeImage,
    onProgress: (index, total) => {
      if (sender.isDestroyed()) return;
      sender.send('image:progress', total > 1 ? `${total}枚のうち${index}枚目を処理中…` : '画像を処理中…');
    },
  });
  return { status: 'done', text: describeResult(result, command) };
});
