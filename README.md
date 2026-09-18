# Desktop Mascot（デスクトップマスコット）

デスクトップに住む、枝豆の豆1粒のマスコットです。クリックして話しかけると、
Gemini が吹き出しで返事をします。Windows 用・Electron 製。

- 背景が透明なウィンドウで、いつも一番手前にいます
- 豆の周りの透明な部分はクリックが素通りするので、後ろのアプリを普通に操作できます
- ときどき豆がコロンと転がります

## できること

**会話**
- 話しかけると 1 秒前後で返事（Google 検索を使ったときは 2〜3 秒）
- 今日の直近 20 往復を覚えていて、話の続きができる
- 昨日から 6 日前までの会話は、要約して返事に使う
- それより古い会話は月ごとの保管庫に残り、「去年の夏に話したこと」のように言葉で探せる

**タイマーとリマインダー**
- 「10 分後に教えて」「明日の 9 時に会議」のように話しかけて登録できる
- 時間になると音を鳴らして声をかける

**その他**
- 天気やニュースは Google 検索で調べて、出典のサイト名も出す
- 会話の履歴を Google ドライブなどの共有フォルダに置けば、複数の PC で同じ会話を続けられる
- Windows 起動時の自動起動（タスクトレイのメニューから ON / OFF）

## 使うために必要なもの

- Windows
- [Node.js](https://nodejs.org/) 20 以上（開発版を動かす場合）
- Gemini API キー（[Google AI Studio](https://aistudio.google.com/) で取得）

### API キーは有料枠が必要です

無料枠では Google 検索つきの返事が `429 RESOURCE_EXHAUSTED` になって使えません。
天気やニュースを調べさせたい場合は、Google Cloud で支払い設定をしてください。
検索を使った返事には、通常の返事とは別に検索の料金がかかります。

なお有料枠では、送った内容が Google のサービス改善に使われることはありません。

## 動かし方

```sh
git clone https://github.com/i-love-famichiki/desktop-mascot.git
cd desktop-mascot
npm install
```

API キーを環境変数に設定します（コマンドプロンプトで一度だけ実行。設定後は開き直してください）。

```sh
setx GEMINI_API_KEY "ここにキー"
```

起動します。

```sh
npm start
```

### exe を作る

```sh
npm run dist
```

`dist/DesktopMascot-Setup.exe` ができます。

## 操作

| したいこと | 方法 |
| --- | --- |
| 話しかける | 豆をクリック |
| 動かす | 豆をドラッグ |
| メニューを出す | 豆を右クリック、またはタスクトレイのアイコン |
| 吹き出しを閉じる | 右上の「×」 |
| 吹き出しを縮める | 右上の「－」 |

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `main.js` | Electron のメインプロセス。ウィンドウ、Gemini API 呼び出し、システムプロンプト、タスクトレイ |
| `preload.js` / `renderer.js` / `index.html` / `style.css` | 画面側。マスコットの SVG と吹き出し |
| `history-store.js` | 会話履歴の保存と、古い会話の要約 |
| `archive-store.js` | 会話の保管庫と、昔の会話を言葉で探す処理 |
| `reminder-store.js` | タイマーとリマインダー |
| `settings.js` | 設定の読み書き |
| `sse.js` | Gemini からの返事を少しずつ受け取る処理 |

会話の履歴や設定は `data/` に保存され、Git には含めません。

## テスト

```sh
npm test
```

Electron や Gemini API に依存しない部分（履歴・保管庫・リマインダー・設定・SSE）を
Node.js だけで確認します。

## 作りについて

- AI は Gemini API（`gemini-3.5-flash-lite`）。外部 SDK は使わず、Electron の
  `net.fetch` で `generateContent` を直接呼んでいます
- `tools: [{ google_search: {} }]` を付け、検索するかどうかはモデルに任せています
- マスコットの絵は自作の SVG です
- `.npmrc` で、npm のサプライチェーン攻撃への備え（インストール時のスクリプト実行を止める、
  公開から 7 日たっていないバージョンを入れない、など）をしています

より詳しい開発の記録は `開発メモ.txt`、使い方の詳細は `マニュアル.html` にあります。

## ライセンス

MIT
