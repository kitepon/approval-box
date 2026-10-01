import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, getSession, setSession, setUnauthorizedHandler, subscribeEvents } from "./api";
import { linkProps, navigate, useLocation } from "./router";
import { bump, loadOpen, useResource } from "./store";
import { Connections, Pair } from "./pages/Connections";
import { DecisionView } from "./pages/DecisionView";
import { History } from "./pages/History";
import { Inbox } from "./pages/Inbox";
import { Settings } from "./pages/Settings";
import "./style.css";

function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  return (
    <section class="login">
      <h1>Approval Box</h1>
      <p>AIが判断を求める時に、ここへ集まります。答えはその場でAIの会話へ届きます。</p>
      <form class="panel" onSubmit={(e) => { e.preventDefault(); if (key.trim()) { setSession(key.trim()); onLogin(); } }}>
        <label class="field">
          <span>セッションキー</span>
          <input value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="kss_…" autocomplete="off" />
        </label>
        <button class="primary" type="submit">ログイン</button>
        <p class="muted">Apple・Googleでのログインは準備中です。自分で立てたサーバーでは <code>approval-box-server admin create-user</code> でキーを発行します。</p>
      </form>
    </section>
  );
}

/** /login#code=… のリンクで開いた時。コードを session に替えて受信へ進む。コードは一度だけ使える。 */
function LinkLogin({ code, onLogin }: { code: string; onLogin: () => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    history.replaceState(null, "", "/login");
    api<{ session: string }>("POST", "/auth/link", { code }, { idempotent: false })
      .then((r) => { setSession(r.session); navigate("/"); onLogin(); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "ログインできませんでした。"));
  }, [code]);
  return (
    <section class="login">
      <h1>Approval Box</h1>
      <p>{error ?? "ログインしています…"}</p>
    </section>
  );
}

function Nav({ path }: { path: string }) {
  const open = useResource(loadOpen);
  const count = open.data?.filter((d) => d.status === "pending").length ?? 0;
  useEffect(() => { document.title = count ? `(${count}) Approval Box` : "Approval Box"; }, [count]);
  const item = (href: string, label: string, active: boolean, badge?: number) => (
    <a class={`nav-item ${active ? "active" : ""}`} {...linkProps(href)}>{label}{badge ? <span class="count">{badge}</span> : null}</a>
  );
  return (
    <nav class="nav">
      {item("/", "受信", path === "/" || path.startsWith("/d/"), count)}
      {item("/history", "既決", path === "/history")}
      {item("/connections", "接続", path === "/connections" || path === "/pair")}
      {item("/settings", "設定", path === "/settings")}
    </nav>
  );
}

function App() {
  const [session, setSessionState] = useState(getSession());
  const { path, query } = useLocation();
  useEffect(() => setUnauthorizedHandler(() => setSessionState(null)), []);
  useEffect(() => {
    if (!session) return;
    return subscribeEvents(() => bump());
  }, [session]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") bump(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const linkCode = path === "/login" ? new URLSearchParams(location.hash.slice(1)).get("code") : null;
  if (linkCode) return <main class="shell"><LinkLogin code={linkCode} onLogin={() => setSessionState(getSession())} /></main>;
  if (!session) return <main class="shell"><Login onLogin={() => setSessionState(getSession())} /></main>;

  let page;
  if (path.startsWith("/d/")) page = <DecisionView id={decodeURIComponent(path.slice(3))} />;
  else if (path === "/history") page = <History />;
  else if (path === "/connections") page = <Connections />;
  else if (path === "/pair") page = <Pair code={query.get("c") ?? ""} />;
  else if (path === "/settings") page = <Settings onLogout={() => { setSessionState(null); navigate("/"); }} />;
  else page = <Inbox />;

  return (
    <div class="shell">
      <Nav path={path} />
      <main>{page}</main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
