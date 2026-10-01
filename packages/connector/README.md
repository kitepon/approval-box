# approval-box

Approval Box connector. When an AI coding agent needs a human decision, it files a request to Approval Box instead of asking in chat. You answer from the Approval Box app or web, and the answer is delivered straight back into the same agent session — mid-turn if the agent is working, as a new turn if it is idle. The agent never polls.

Supported agents: Claude Code, Codex, Cursor, Grok — on macOS, Windows and Linux.

AIが「人間の判断が要る」と思った時に、チャットで聞く代わりにApproval Boxへ申請します。アプリかWeb版で答えると、その答えが申請したAIの会話へそのまま届きます。

## Setup / 使い方

```sh
npx -y approval-box@latest setup
```

1. `setup` finds the agents on this machine and registers Approval Box (MCP server and hooks). It shows the files it will change and keeps a backup (`*.approval-box-backup`) before writing.
   PCにあるAIを見つけて登録します。書き換えるファイルを先に見せ、控えを残してから書き換えます。
2. Scan the QR code or enter the code in “Add device” in the app or web.
   画面のQRコードかコードを、アプリかWeb版の「端末を追加」で読み取ります。
3. Tell your agent: `Approval Boxのsetup_testを実行して` (or “run Approval Box setup_test”). Answer the test request; when the answer reaches the agent, you are ready.
   AIに「Approval Boxのsetup_testを実行して」と言い、テストの申請に答えます。答えがAIまで届けば準備完了です。

## Commands / コマンド

```sh
npx approval-box test        # connection test / 接続テスト
npx approval-box status      # connection, registrations, checks / 状態
npx approval-box doctor      # find why answers do not arrive / 届かない時の原因
npx approval-box uninstall   # remove everything and unlink this device / 全部外す
```

Self-hosted server: `npx -y approval-box@latest setup --server https://your-server`.

Requires Node.js 20 or later. License: MIT.
