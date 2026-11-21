import { useState } from "preact/hooks";
import { t } from "./i18n.ts";

/** コマンドの1行と「コマンドをコピー」。クリップボードが使えない時は、選んでコピーできる入力欄を出す。 */
export function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="copyline">
      <code>{text}</code>
      <button class="ghost small" onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { prompt(t("コピーしてください"), text); }
      }}>{copied ? t("コピーしました") : t("コマンドをコピー")}</button>
    </div>
  );
}
