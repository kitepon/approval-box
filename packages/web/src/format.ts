import { labels, locale, relative, t } from "./i18n.ts";
export const CLIENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok", "claude.ai": "Claude", chatgpt: "ChatGPT",
};
export const clientLabel = (client: string) => CLIENT_LABEL[client] ?? t("その他");
export const URGENCY_LABEL = labels({ high: "急ぎ", normal: "通常", low: "低" });
export const DELIVERY_LABEL = labels({ waiting: "AIへの配送待ち", delivered: "AIへ届いた", unknown: "届いたか不明", fetched: "AIが受け取った" });
export const FIELD_LABEL = labels({ title: "件名", context: "背景", request_attachment_ids: "AIの添付画像", options: "選択肢", recommendation: "推奨", urgency: "急ぎ度", deadline: "期限" });
export const CHECK_LABEL = labels({ untested: "未テスト", waiting_answer: "答え待ち", waiting_ai: "AIへ配送中", passed: "確認済み", failed: "失敗" });
export const FAILED_STEP = labels({
  request: "AIにApproval Boxが登録されていません。PCで npx -y approval-box@latest setup をやり直し、AIを再起動してください。",
  notify: "通知が届いていません。通知の許可を確かめてください。",
  delivery: "答えがAIへ届きませんでした。PCで approval-box doctor を実行して原因を確かめてください。",
});
export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return t("たった今");
  if (seconds < 3600) return relative(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return relative(-Math.floor(seconds / 3600), "hour");
  return relative(-Math.floor(seconds / 86400), "day");
}
export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function deadlineText(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms < 0) return t("期限切れ（{date}）", { date: dateTime(iso) });
  if (ms < 3600_000) return relative(Math.ceil(ms / 60_000), "minute");
  if (ms < 86400_000) return relative(Math.floor(ms / 3600_000), "hour");
  return t("期限 {date}", { date: dateTime(iso) });
}
