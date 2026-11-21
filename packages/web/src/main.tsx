import { t, useLocale } from "./i18n.ts";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, getSession, setLibraryLogin, setUnauthorizedHandler } from "./api";
import { AlertHost } from "./dialog";
import { useLocation } from "./router";
import { Pair } from "./pages/Connections";
import { loginConfig } from "./idlogin";
import { Login } from "./login";
import "./style.css";

/** The browser client was closed on 2026-11-21 (Owner): every path except /pair shows this notice and calls no API. */
function Closed() {
  useLocale();
  return (
    <main class="shell">
      <section class="login">
        <h1>{t("ブラウザ版は終わりました")}</h1>
        <p>{t("決裁箱は、iPhone・iPad・Mac・Android・Linux のアプリでお使いください。相談の中身を、サーバーから配るブラウザの画面には出さないためです。")}</p>
        <p class="links">
          <a href="/support.html">{t("サポート（アプリの入手）")}</a>
          <a href="/terms.html">{t("利用規約")}</a>
          <a href="/privacy.html">{t("プライバシーポリシー")}</a>
        </p>
      </section>
    </main>
  );
}

/** The only live screen: the consent page BellTeam's registered-client pairing needs (docs/bellteam-client.md). No menu and no event stream. */
function PairApp() {
  useLocale();
  // boot: サーバーがライブラリのログインを使うか確かめるまで。ライブラリのログインでは通行証がHttpOnlyのcookieで読めないので、/me（契約なしで通る）で有効かを聞く。
  const [auth, setAuth] = useState<"boot" | "in" | "out">("boot");
  const [library, setLibrary] = useState(false);
  // S1b: ログイン済みの端末が401で出された時の理由（pass_*コード）。
  const [reason, setReason] = useState<string | null>(null);
  const authRef = useRef(auth);
  authRef.current = auth;
  const { query } = useLocation();
  useEffect(() => setUnauthorizedHandler((code) => {
    if (authRef.current === "in") setReason(code ?? "");
    authRef.current = "out";
    setAuth("out");
  }), []);
  useEffect(() => {
    loginConfig().then(async (config) => {
      setLibraryLogin(!!config.library_login);
      setLibrary(!!config.library_login);
      if (!config.library_login) return setAuth(getSession() ? "in" : "out");
      setAuth(await api("GET", "/me").then(() => "in" as const, () => "out" as const));
    });
  }, []);

  if (auth === "boot") return <main class="shell" />;
  if (auth === "out") return <main class="shell"><Login library={library} reason={reason} onLogin={() => { setReason(null); setAuth(library || getSession() ? "in" : "out"); }} /></main>;
  return (
    <div class="shell">
      <main><Pair code={query.get("c") ?? ""} /></main>
      <AlertHost />
    </div>
  );
}

function App() {
  const { path } = useLocation();
  return path === "/pair" ? <PairApp /> : <Closed />;
}

render(<App />, document.getElementById("app")!);
