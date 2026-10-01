# Approval Box（approval-box）

AIが「人間の判断が要る」と思った時に、チャットで聞く代わりにApproval Boxへ申請します。申請はスマホのアプリやWeb版に集まり、答えるとその答えが申請したAIの会話へそのまま届きます。AIが作業中なら割り込み、止まっていれば新しいターンとして届きます。AIは答えを待ってポーリングしません。

対応するAI: Claude Code・Codex・Cursor・Grok（macOS・Windows・Linux）

## 使い方

```sh
npx -y approval-box@latest setup
```

1. `setup` が、PCにあるAIを見つけてApproval Boxを登録します。書き換えるファイルを先に見せ、控えを残してから書き換えます。
2. 画面に出るQRコードかコードを、アプリかWeb版の「端末を追加」で読み取ります。
3. AIに「Approval Boxのsetup_testを実行して」と言います。テストの申請に答え、その答えがAIまで届けば準備完了です。

元に戻すには `npx approval-box uninstall`。届かない時は `npx approval-box doctor`。

## 構成

| パッケージ | 中身 | ライセンス |
|---|---|---|
| `packages/connector` | npm `approval-box`。AIの端末で動くMCPと配送デーモン、setup | MIT |
| `packages/server` | サーバー（API・SQLite）。Web版も配る | AGPL-3.0 |
| `packages/web` | Web版（スマホ幅対応・PWA） | AGPL-3.0 |

答えをAIの会話へ届ける部分は [aiterm-steer-delivery](https://github.com/kitepon/aiterm-steer-delivery) を使っています。

## 自分でサーバーを立てる

```sh
npm install && npm run build
PUBLIC_URL=https://Approval Boxを置くURL node packages/server/dist/main.js
node packages/server/dist/main.js admin create-user   # Web版にログインするキーを発行
npx -y approval-box@latest setup --server https://Approval Boxを置くURL
```

自分で立てたサーバーは無料で、課金の仕組みは止まっています（`BILLING=off`）。iPhone・Androidアプリは公式サーバー専用です。自分のサーバーではWeb版をホーム画面に追加して使ってください。

## 開発

```sh
npm install
npm test                                   # サーバーのAPI試験
npm run build -w packages/connector
node tools/e2e/parent-e2e.mjs claude-code  # 本物のAIで配送を確かめる（codex-cli・cursor-cli・grok-cli も）
```

`parent-e2e.mjs` は試験用のフォルダの中だけにAIを登録し、利用者の設定には触れません。`approval-box setup` を試す時は、使い捨てのHOMEに加えて `CODEX_HOME`・`GROK_HOME`・`CLAUDE_CONFIG_DIR`・`CURSOR_HOME` も使い捨て側へ向けてください。
