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

export function onboarding(publicUrl: string): Guide[] {
  const command = `npx -y approval-box@latest setup --server ${publicUrl}`;
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
