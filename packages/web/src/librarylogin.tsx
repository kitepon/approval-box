import { createWebClient, qrSvg, type LoginStart } from "@kitepon/login-billing/web";
import { useEffect, useState } from "preact/hooks";
import { locale, t } from "./i18n.ts";
import { deviceLabel } from "./devicelabel.ts";

let client: ReturnType<typeof createWebClient> | undefined;
/** The library web client. Its baseUrl is the mounted prefix (the server mounts the library at /auth/v1); the pass lives in the HttpOnly cookie. */
export const libraryClient = () => (client ??= createWebClient({ baseUrl: `${location.origin}/auth/v1`, carrier: "cookie" }));

const untilText = (iso: string) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** S2: QR, login code and check number, then wait for the phone. An expired code stays here with a button for a new one. */
export function LibraryLogin({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [round, setRound] = useState(0);
  const [login, setLogin] = useState<LoginStart | null>(null);
  const [failed, setFailed] = useState<"expired" | "error" | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLogin(null);
    setFailed(null);
    (async () => {
      try {
        const started = await libraryClient().startLogin(deviceLabel(navigator.userAgent));
        if (abort.signal.aborted) return;
        setLogin(started);
        await libraryClient().waitForPass(abort.signal);
        onDone();
      } catch (error) {
        if (abort.signal.aborted) return;
        setLogin(null);
        setFailed((error as { code?: string }).code === "slot_gone" ? "expired" : "error");
      }
    })();
    return () => abort.abort();
  }, [round]);

  return (
    <div class="library-login">
      <h2>{t("スマホの承認を待っています")}</h2>
      {login && (
        <>
          <div class="library-qr" role="img" aria-label={t("QRコード")} dangerouslySetInnerHTML={{ __html: qrSvg(login.qrPayload) }} />
          <p class="muted">{t("ログインコード")}</p>
          <p class="library-code">{login.shortCode.replace(/^(.{4})(.{4})$/, "$1-$2")}</p>
          <p class="muted">{t("確認番号")}</p>
          <p class="library-check">{login.checkNumber}</p>
          <p class="muted">{t("{time}まで有効", { time: untilText(login.expiresAt) })}</p>
        </>
      )}
      {failed && (
        <>
          <p class="error">{failed === "expired" ? t("コードの期限が切れました。") : t("コードを出せませんでした。通信を確かめてください。")}</p>
          <button class="primary" onClick={() => setRound((n) => n + 1)}>{t("新しいコードを出す")}</button>
        </>
      )}
      <p>{t("契約したスマホの決裁箱で、設定 → ほかの端末をログインさせる を開き、このQRを読むか、コードを入力してください。確認番号が同じなら「許可する」を押します。")}</p>
      <button class="ghost" onClick={onCancel}>{t("やめる")}</button>
    </div>
  );
}
