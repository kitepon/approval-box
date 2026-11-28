import { signInApple, signInGoogle, type Provider, type Role } from "@kitepon/login-billing/web";
import { useEffect, useState } from "preact/hooks";
import { CopyLine } from "./copyline";
import { browserDevice } from "./device.ts";
import { locale, t } from "./i18n.ts";
import { type Config, loadAppleScript, loginConfig } from "./idlogin";
import { LanguagePicker } from "./language";

export const INSTALL = "npx -y approval-box@latest setup";
/** The QR's life: the browser's consent in it lasts 10 minutes (login-billing 1.59). */
const QR_MS = 600_000;
const POLL_MS = 3000; // keys/me is limited to 30 calls a minute per source with the other keys routes

const untilText = (ms: number) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** S1b: why a signed-in browser is back here. A clock that is off has its own text; anything else (key removed from the phone, key gone) the generic one. */
function Reason({ code }: { code: string }) {
  return <p class="notice" role="status">{code === "time_off" ? t("この端末の時計がずれています。時計を合わせてから、もう一度試してください。") : t("ログインが切れました。もう一度ログインしてください。")}</p>;
}

/**
 * S1 and S2. The browser signs in with Google or Apple itself (the id token goes only into the QR), shows the QR, and waits until a phone of the
 * same account reads it and admits this browser as a child (keys/me answers its entry). Then it is one device of the account like the phone apps.
 */
export function Login({ reason, onLogin }: { reason: string | null; onLogin: (who: { entry: string; role: Role }) => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [qr, setQr] = useState<{ svg: string; until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loginConfig().then(setConfig); }, []);
  useEffect(() => { if (config?.apple_services_id) loadAppleScript().catch(() => {}); }, [config]);

  useEffect(() => {
    if (!qr) return;
    let alive = true;
    (async () => {
      while (alive) {
        if (Date.now() > qr.until) { setQr(null); setError(t("QRの期限が切れました。もう一度ログインしてください。")); return; }
        try {
          const who = await browserDevice().me();
          if (who && alive) {
            void navigator.storage?.persist?.().catch(() => false); // keeps the key from eviction; a refusal changes nothing
            return onLogin(who);
          }
        } catch { /* offline for a moment: keep waiting */ }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
    return () => { alive = false; };
  }, [qr]);

  async function start(provider: Provider) {
    setError(null);
    setBusy(true);
    try {
      const signIn = provider === "google"
        ? (nonce: string) => signInGoogle({ clientId: config!.google_client_id!, redirectUri: `${location.origin}/auth/google/callback` }, nonce)
        : (nonce: string) => signInApple({ clientId: config!.apple_services_id!, redirectUri: `${location.origin}/auth/apple/callback` }, nonce);
      const request = await browserDevice().makeRequest({ provider, signIn });
      setQr({ svg: request.svg, until: Date.now() + QR_MS });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "popup_closed") setError(code === "popup_blocked" ? t("ポップアップが止められました。このページのポップアップを許可してから、もう一度押してください。") : t("ログインできませんでした。"));
    } finally {
      setBusy(false);
    }
  }

  if (qr) return (
    <section class="login">
      <h1>Approval Box</h1>
      <div class="library-login">
        <h2>{t("スマホの承認を待っています")}</h2>
        <p>{t("同じアカウントの iPhone の決裁箱でこの QR を読んでください")}</p>
        <div class="browser-qr" role="img" aria-label={t("QRコード")} dangerouslySetInnerHTML={{ __html: qr.svg }} />
        <p class="muted">{t("{time}まで有効", { time: untilText(qr.until) })}</p>
        <button class="ghost" onClick={() => setQr(null)}>{t("やめる")}</button>
      </div>
    </section>
  );

  const google = !!config?.google_client_id, apple = !!config?.apple_services_id;
  return (
    <section class="login">
      <h1>Approval Box</h1>
      <p>{t("AIの相談に、スマホやPCから答えます。")}</p>
      {reason !== null && <Reason code={reason} />}
      {(google || apple) && <p>{t("Google か Apple でログインすると QR が出ます。同じアカウントの iPhone の決裁箱でその QR を読むと、このブラウザが使えるようになります。")}</p>}
      <div class="idlogin">
        {google && <button class="primary wide" disabled={busy} onClick={() => start("google")}>{t("Googleでログイン")}</button>}
        {apple && <button class="apple-button" disabled={busy} onClick={() => start("apple")}>{t("Appleでサインイン")}</button>}
      </div>
      {error && <p class="error" role="alert">{error}</p>}
      {config && !google && !apple && <p class="muted">{t("このサーバーにはログインの設定がありません。管理者は、AppleかGoogleのログインを設定してください（READMEの「自分でサーバーを立てる」）。")}</p>}
      <details class="first-time">
        <summary>{t("はじめての方へ")}</summary>
        <ol>
          <li>{t("iPhone・iPad・Mac または Android の決裁箱で、Apple または Google でログインし、設定 → 契約 から契約します。")}</li>
          <li>{t("PCでコマンドを実行して、AIとつなぎます。")}<CopyLine text={INSTALL} /></li>
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
