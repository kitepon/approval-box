# Approval Box（approval-box）

AIが人間の判断・承認・操作を求める時に、Approval Boxへも申請します。申請はスマホのアプリやWeb版に集まり、答えるとその答えが申請したAIの会話へそのまま届きます。AIが作業中なら割り込み、止まっていれば新しいターンとして届きます。AIは答えを待ってポーリングしません。

対応するAI: Claude Code・Codex・Cursor・Grok（macOS・Windows・Linux）

Cursor・Grokでは、申請道具が返すコマンドで背景の受信処理を起動します。Cursorのhookは受信口と会話を結び付け、答えは背景受信が届けます。受信処理が答えを返すまで動かしておきます。

## 使い方

```sh
npx -y approval-box@latest setup
```

1. `setup` が、PCにあるAIを見つけてApproval Boxを登録します。書き換えるファイルを先に見せ、控えを残してから書き換えます。
   AIが毎回読む全体の指示に「判断・承認・操作が要る時は request_decision でも申請する」という一節を足すかも聞きます（Cursor は会話の始まりのhookで渡す）。
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

ログインは、AppleかGoogleのどちらかが要ります（ログイン用のURLやパスワードはありません）。

- Apple: Apple Developerで Services ID を作り、ドメインと Return URL（`https://<あなたのURL>/auth/apple/callback`）を登録します。`APPLE_WEB_SERVICES_ID` にそのIDを入れます。
- Google: Google Cloudで「ウェブ アプリケーション」のOAuthクライアントを作り、承認済みのJavaScript生成元にあなたのURLを入れます。`GOOGLE_WEB_CLIENT_ID` にそのIDを入れます。

```sh
git clone https://github.com/kitepon/approval-box && cd approval-box
PUBLIC_URL=https://<あなたのURL> APPLE_WEB_SERVICES_ID=<Services ID> docker compose up -d --build
npx -y approval-box@latest setup --server https://<あなたのURL>
```

自分で立てたサーバーは無料で、課金の仕組みは止まっています（`BILLING=off`）。iPhone・Androidアプリは公式サーバー専用です。自分のサーバーではWeb版をホーム画面に追加して使ってください。

アプリ・Web版とサーバーの取り決めは [docs/api.md](docs/api.md) にあります。

### リモートMCP（端末にコネクタを置けないAI）

`https://<あなたのURL>/mcp` は Streamable HTTP のMCPです。アプリ・Web版で発行した接続トークンを `Authorization: Bearer <token>` で付けて登録します。答えは `get_decision` で取ります。利用者が答えに付けた添付（画像・書類）は `get_attachment` で取ります。

答えをAIへ通話で届けたい接続（GrokBotなど）は、[call-bridge](https://github.com/kitepon/grokbot-bridge) を使えます。`CALL_BRIDGE_CONNECTIONS`（接続のid、カンマ区切り）と `CALL_BRIDGE_HEADERS_FILE`（`Authorization: Bearer …` の行のファイル）を設定すると、その接続の `request_decision` は申請者のID（`requester_id`）を受け取り、答えが出たらサーバーがそのIDへ通話で送ります。発信元は `CALL_BRIDGE_LOCAL_SYSTEM`・`CALL_BRIDGE_LOCAL_ID`（既定 `local`・`approval-box`、トークンに結び付いた値に合わせる）、宛先の所属は `CALL_BRIDGE_MEMBER_SYSTEM`（既定 `grokbot`）、接続先は `CALL_BRIDGE_URL`（既定 `https://call.kitepon.dev/mcp`）です。

## 開発

```sh
npm install
npm test                                   # サーバーのAPI試験
npm run build -w packages/connector
node tools/e2e/parent-e2e.mjs claude-code  # 本物のAIで配送を確かめる（codex-cli・cursor-cli・grok-cli も）
```

`parent-e2e.mjs` は試験用のフォルダの中だけにAIを登録し、利用者の設定には触れません。`npx approval-box setup` を試す時は、使い捨てのHOMEに加えて `CODEX_HOME`・`GROK_HOME`・`CLAUDE_CONFIG_DIR`・`CURSOR_HOME` も使い捨て側へ向けてください。
