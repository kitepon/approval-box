// 「Googleでログイン」「Appleでログイン」のボタン。サーバーの /auth/config に値がある時だけ出す。
// Bearer付き（ログイン済み）で呼べば、IDの無い既存アカウントにそのIDを結ぶ（最初の1回だけ）。
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "./api";

type Config = { google_client_id?: string; apple_services_id?: string };
type Result = { session: string };

declare global {
  interface Window {
    google?: { accounts: { id: { initialize(o: Record<string, unknown>): void; renderButton(el: HTMLElement, o: Record<string, unknown>): void } } };
    AppleID?: { auth: { init(o: Record<string, unknown>): void; signIn(): Promise<{ authorization: { id_token: string } }> } };
  }
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!scripts.has(src)) scripts.set(src, new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = true; el.onload = () => resolve(); el.onerror = () => reject(new Error("読み込めませんでした"));
    document.head.appendChild(el);
  }));
  return scripts.get(src)!;
}

let configPromise: Promise<Config> | null = null;
export const loginConfig = (): Promise<Config> => (configPromise ??= api<Config>("GET", "/auth/config").catch((): Config => ({})));

export function IdLogin({ onDone, skip = [] }: { onDone: (r: Result) => void; skip?: string[] }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const googleRef = useRef<HTMLDivElement>(null);
  useEffect(() => { loginConfig().then(setConfig); }, []);

  const send = (path: string, body: Record<string, string>) =>
    api<Result>("POST", path, body, { idempotent: false }).then(onDone).catch((e) => setError(e instanceof ApiError ? e.message : "ログインできませんでした。"));

  useEffect(() => {
    if (!config?.google_client_id || skip.includes("google") || !googleRef.current) return;
    loadScript("https://accounts.google.com/gsi/client").then(() => {
      window.google!.accounts.id.initialize({ client_id: config.google_client_id, callback: (r: { credential: string }) => send("/auth/google", { id_token: r.credential }) });
      window.google!.accounts.id.renderButton(googleRef.current!, { theme: "outline", size: "large", text: "signin_with", locale: "ja", width: 280 });
    }).catch(() => setError("Googleのログインを読み込めませんでした。"));
  }, [config]);

  async function apple() {
    setError(null);
    try {
      await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/ja_JP/appleid.auth.js");
      window.AppleID!.auth.init({ clientId: config!.apple_services_id, scope: "", redirectURI: `${location.origin}/auth/apple/callback`, usePopup: true });
      const r = await window.AppleID!.auth.signIn();
      await send("/auth/apple", { identity_token: r.authorization.id_token });
    } catch (e) {
      if ((e as { error?: string }).error === "popup_closed_by_user") return;
      setError("Appleのログインができませんでした。");
    }
  }

  if (!config) return null;
  const google = !!config.google_client_id && !skip.includes("google");
  const appleOn = !!config.apple_services_id && !skip.includes("apple");
  if (!google && !appleOn) return null;
  return (
    <div class="idlogin">
      {google && <div ref={googleRef} class="google-button" />}
      {appleOn && <button class="apple-button" onClick={apple}>Appleでログイン</button>}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
