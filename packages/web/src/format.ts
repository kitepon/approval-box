export const CLIENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok", "claude.ai": "Claude", chatgpt: "ChatGPT", other: "その他",
};
export const clientLabel = (client: string) => CLIENT_LABEL[client] ?? "その他";

export const URGENCY_LABEL: Record<string, string> = { high: "急ぎ", normal: "通常", low: "低" };

export const DELIVERY_LABEL: Record<string, string> = {
  waiting: "AIへの配送待ち", delivered: "AIへ届いた", unknown: "届いたか不明", fetched: "AIが受け取った",
};

export const FIELD_LABEL: Record<string, string> = {
  title: "件名", context: "背景", options: "選択肢", recommendation: "推奨", urgency: "急ぎ度", deadline: "期限",
};

export const CHECK_LABEL: Record<string, string> = {
  untested: "未テスト", waiting_answer: "答え待ち", waiting_ai: "AIへ配送中", passed: "確認済み", failed: "失敗",
};

export const FAILED_STEP: Record<string, string> = {
  request: "AIにApproval Boxが登録されていません。PCで npx -y approval-box@latest setup をやり直し、AIを再起動してください。",
  notify: "通知が届いていません。通知の許可を確かめてください。",
  delivery: "答えがAIへ届きませんでした。PCで approval-box doctor を実行して原因を確かめてください。",
};

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function deadlineText(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms < 0) return `期限切れ（${dateTime(iso)}）`;
  if (ms < 3600_000) return `あと${Math.ceil(ms / 60_000)}分`;
  if (ms < 86400_000) return `あと${Math.floor(ms / 3600_000)}時間`;
  return `期限 ${dateTime(iso)}`;
}
