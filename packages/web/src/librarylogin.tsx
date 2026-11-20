import { createWebClient, qrSvg, type LoginStart } from "@kitepon/login-billing/web";
import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n.ts";
import { deviceLabel } from "./devicelabel.ts";

let client: ReturnType<typeof createWebClient> | undefined;
/** The library web client. Its baseUrl is the mounted prefix (the server mounts the library at /auth/v1); the pass lives in the HttpOnly cookie. */
export const libraryClient = () => (client ??= createWebClient({ baseUrl: `${location.origin}/auth/v1`, carrier: "cookie" }));

/** The login screen when the server says library_login: QR, short code and check number, then wait for the phone. */
export function LibraryLogin({ onDone }: { onDone: () => void }) {
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
      {login && (
        <>
          <div class="library-qr" role="img" aria-label={t("QRコード")} dangerouslySetInnerHTML={{ __html: qrSvg(login.qrPayload) }} />
          <p class="muted">{t("コード")}</p>
          <p class="library-code">{login.shortCode.replace(/^(.{4})(.{4})$/, "$1-$2")}</p>
          <p>{t("スマホの決裁箱アプリで読み取るか、コードを入力してください。表示される番号が {checkNumber} か確かめてください。", { checkNumber: login.checkNumber })}</p>
          <p class="muted">{t("契約がまだの方は、先にスマホで契約してください。")}</p>
        </>
      )}
      {failed && (
        <>
          <p class="error">{failed === "expired" ? t("コードの有効期限が切れました。") : t("コードを出せませんでした。通信を確かめてください。")}</p>
          <button class="ghost" onClick={() => setRound((n) => n + 1)}>{t("新しいコードを出す")}</button>
        </>
      )}
    </div>
  );
}
