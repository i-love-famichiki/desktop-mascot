'use strict';

const { dialog } = require('electron');
const state = require('./state');

/** ダイアログを載せる窓。設定ウィンドウから操作しているときは、そちらに載せる */
function dialogParent() {
  return state.settingsWin?.isFocused() ? state.settingsWin : state.win;
}

function showDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

module.exports = { dialogParent, showDialog };
