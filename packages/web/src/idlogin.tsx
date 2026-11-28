import { locale } from "./i18n.ts";

/** The public client ids of /v1/auth/config (not secret). The browser signs in with them itself; no id token reaches the server. */
export type Config = { google_client_id?: string; apple_services_id?: string };

declare global {
  interface Window {
    AppleID?: { auth: { init(o: Record<string, unknown>): void; signIn(): Promise<{ authorization: { id_token: string; state?: string } }> } };
  }
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!scripts.has(src)) scripts.set(src, new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = true; el.onload = () => resolve(); el.onerror = () => reject(new Error("script"));
    document.head.appendChild(el);
  }));
  return scripts.get(src)!;
}
/** Sign in with Apple JS: the page loads it itself (the library's signInApple uses window.AppleID). Loaded before the button is pressed, so its popup opens within the click. */
export const loadAppleScript = () => loadScript(`https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/${({ ja: "ja_JP", en: "en_US", ko: "ko_KR", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW" })[locale()]}/appleid.auth.js`);

let configPromise: Promise<Config> | null = null;
/** Unsigned (it is public and the sign-in page has no key yet). */
export const loginConfig = (): Promise<Config> => (configPromise ??= fetch("/v1/auth/config").then((r) => r.json() as Promise<Config>).catch((): Config => ({})));
