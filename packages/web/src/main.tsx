import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getSession, setSession, setUnauthorizedHandler, subscribeEvents } from "./api";
import { linkProps, navigate, useLocation } from "./router";
import { bump, loadOpen, useResource } from "./store";
import { Connections, Pair } from "./pages/Connections";
import { DecisionView } from "./pages/DecisionView";
import { History } from "./pages/History";
import { Inbox } from "./pages/Inbox";
import { Settings } from "./pages/Settings";
import { IdLogin, loginConfig } from "./idlogin";
import "./style.css";

function Login({ onLogin }: { onLogin: () => void }) {
  const [hasLogin, setHasLogin] = useState<boolean | null>(null);
  useEffect(() => { loginConfig().then((c) => setHasLogin(!!(c.google_client_id || c.apple_services_id))); }, []);
  return (
    <section class="login">
      <h1>Approval Box</h1>
      <p>AIが判断を求める時に、ここへ集まります。答えはその場でAIの会話へ届きます。</p>
      <IdLogin onDone={(r) => { setSession(r.session); onLogin(); }} />
      {hasLogin && <p class="muted">GoogleとAppleは別のアカウントになります。いつも同じ方でログインしてください。</p>}
      {hasLogin === false && <p class="muted">このサーバーにはログインの設定がありません。管理者は、AppleかGoogleのログインを設定してください（READMEの「自分でサーバーを立てる」）。</p>}
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

  if (path === "/login") { history.replaceState(null, "", "/"); } // 廃止したログインのURL（ブックマーク）で来た時
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
