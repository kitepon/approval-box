// クライアント別の登録手順（GET /v1/onboarding）。文面はアプリに焼き込まず、ここから配る。

export const SETUP_PHRASE = "Approval Boxのsetup_testを実行して";

type Step = { text: string; copy?: string };
type Guide = { client: string; title: string; steps: Step[] };

const CLIENTS: { client: string; name: string; note?: string }[] = [
  { client: "claude-code", name: "Claude Code" },
  { client: "codex", name: "Codex", note: "作業中にも答えを割り込ませるには、開いているCodexをすべて閉じて開き直します。" },
  { client: "cursor", name: "Cursor", note: "Cursorは、答えを受け取るコマンドの実行を一度だけ確かめてくることがあります。許可してください。" },
  { client: "grok", name: "Grok" },
];

export function onboarding(publicUrl: string, locale: "ja" | "en" = "ja"): Guide[] {
  const command = `npx -y approval-box@latest setup --server ${publicUrl}`;
  if (locale === "en") return CLIENTS.map(({ client, name }) => ({
    client, title: `Set up ${name}`,
    steps: [
      { text: "Run this command in a terminal on your computer. It registers Approval Box with Claude Code, Codex, Cursor, and Grok (Node.js 20 or later required).", copy: command },
      { text: "Scan the QR code or enter the code under Add a device on this screen. On a headless computer, use the command from Issue token." },
      { text: `Restart ${name} and ask:`, copy: "Run Approval Box setup_test" },
      { text: `Answer the test request. Setup is complete when your answer reaches ${name}.${client === "codex" ? " To receive answers while working, close all open Codex windows and reopen them." : client === "cursor" ? " Cursor may ask once for permission to run the command that receives your answer. Allow it to continue." : ""}` },
    ],
  }));
  return CLIENTS.map(({ client, name, note }) => ({
    client,
    title: `${name}を登録する`,
    steps: [
      { text: `PCの端末で次の1行を実行します。PCにあるClaude Code・Codex・Cursor・Grokへまとめて登録します（Node.js 20以上が要ります）。`, copy: command },
      { text: "端末に出たQRコードかコードを、この画面の「端末を追加」で読み取ります。画面の無い端末では「トークンを発行」で出る1行を使います。" },
      { text: `${name}を開き直して、こう言います。`, copy: SETUP_PHRASE },
      { text: `届いたテストの申請に答えます。答えが${name}に届けば準備完了です。${note ? ` ${note}` : ""}` },
    ],
  }));
}
