'use strict';

// 音を鳴らす。豆の窓（renderer.js）と設定の窓（settings-window.js）の両方が読み込む。
// 「何を鳴らすか」はメイン側（sounds.js）が決めて渡してくる:
//   { kind: 'notes', wave, notes } … その場で音を作る（内蔵の音）
//   { kind: 'file', dataUrl }      … 選んでもらった音のファイル
//   null                           … 鳴らさない

let audioContext = null;
// 同じ音を何度も読み込み直さないよう、作った Audio を覚えておく
const audioForSound = new WeakMap();

/** @param {{ notes: number, file: number }} volume 音の大きさ（sounds.js の SOUND_VOLUMES） */
function playSound(sound, volume) {
  if (!sound) return;
  try {
    if (sound.kind === 'file') playSoundFile(sound, volume?.file ?? 0.6);
    else playNotes(sound, volume?.notes ?? 0.25);
  } catch (err) {
    // 音が出せなくても、吹き出しとはねるのは続ける
    console.warn('[sound] 音を鳴らせませんでした:', err.message);
  }
}

function playNotes({ wave, notes }, volume) {
  audioContext ??= new AudioContext();
  const start = audioContext.currentTime + 0.05;
  for (const note of notes) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.value = note.hz;
    const at = start + note.at;
    // すっと鳴って、鈴のように消えていく
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, at + note.dur);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + note.dur);
  }
}

function playSoundFile(sound, volume) {
  let audio = audioForSound.get(sound);
  if (!audio) {
    audio = new Audio(sound.dataUrl);
    audioForSound.set(sound, audio);
  }
  audio.volume = volume;
  // 続けて知らせたときは、鳴り終わっていなくても鳴らし直す
  audio.currentTime = 0;
  audio.play().catch((err) => console.warn('[sound] 音を鳴らせませんでした:', err.message));
}
