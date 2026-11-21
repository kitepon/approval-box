import { useEffect, useState } from "preact/hooks";
import { setSession } from "./api";
import { CopyLine } from "./copyline";
import { t } from "./i18n.ts";
import { IdLogin, loginConfig } from "./idlogin";
import { LanguagePicker } from "./language";
import { LibraryLogin } from "./librarylogin";

export const INSTALL = "npx -y approval-box@latest setup";

/** S1b: the reason for an automatic sign-out. The library tells stopped (pass_refused) from expired (pass_expired); anything else gets the generic text. */
function Reason({ code }: { code: string }) {
  return <p class="notice" role="status">{code === "pass_refused" ? t("この端末のログインは、承認したスマホから止められました。もう一度ログインしてください。") : code === "pass_expired" ? t("しばらく使われなかったため、ログインが切れました。もう一度ログインしてください。") : t("ログインが切れました。もう一度ログインしてください。")}</p>;
}

/** S1 (and S2 in library mode). Both modes share one structure: title, purpose, sign-in, 「はじめての方へ」, links, language. */
export function Login({ library, reason, onLogin }: { library: boolean; reason: string | null; onLogin: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [hasLogin, setHasLogin] = useState<boolean | null>(null);
  useEffect(() => { loginConfig().then((c) => setHasLogin(!!(c.google_client_id || c.apple_services_id))); }, []);
  if (library && waiting) return <section class="login"><h1>Approval Box</h1><LibraryLogin onDone={onLogin} onCancel={() => setWaiting(false)} /></section>;
  return (
    <section class="login">
      <h1>Approval Box</h1>
      <p>{t("AIの相談に、スマホやPCから答えます。")}</p>
      {reason !== null && <Reason code={reason} />}
      {!library && <IdLogin onDone={(r) => { setSession(r.session); onLogin(); }} />}
      {library && <button class="primary wide" onClick={() => setWaiting(true)}>{t("スマホの承認でログイン")}</button>}
      {!library && hasLogin && <p class="muted">{t("GoogleとAppleは別のアカウントになります。いつも同じ方でログインしてください。")}</p>}
      {!library && hasLogin === false && <p class="muted">{t("このサーバーにはログインの設定がありません。管理者は、AppleかGoogleのログインを設定してください（READMEの「自分でサーバーを立てる」）。")}</p>}
      <details class="first-time">
        <summary>{t("はじめての方へ")}</summary>
        <ol>
          <li>{t("iPhone・iPad・Mac または Android の決裁箱で、Apple または Google でログインし、設定 → 契約 から契約します。")}</li>
          <li>{t("PCでコマンドを実行して、AIとつなぎます。")}<CopyLine text={INSTALL} /></li>
          {library && <li>{t("ほかの端末（Linux・ブラウザ・もう一方のスマホ）は、この画面の「スマホの承認でログイン」を押し、契約したスマホの 設定 → ほかの端末をログインさせる で承認します。")}</li>}
        </ol>
      </details>
      <p class="links">
        <a href="/terms.html" target="_blank" rel="noopener">{t("利用規約")}</a>
        <a href="/privacy.html" target="_blank" rel="noopener">{t("プライバシーポリシー")}</a>
        <a href="/support.html" target="_blank" rel="noopener">{t("サポート")}</a>
      </p>
      <LanguagePicker />
    </section>
  );
}
