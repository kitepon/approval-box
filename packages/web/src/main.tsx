import { t, useLocale } from "./i18n.ts";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { setUnauthorizedHandler, subscribeEvents } from "./api";
import { setSignOutHandler } from "./account";
import { browserDevice, setAccount } from "./device.ts";
import { AlertHost } from "./dialog";
import { linkProps, navigate, useLocation } from "./router";
import { bump, loadOpen, localHistory, useResource } from "./store";
import { Connections, Pair } from "./pages/Connections";
import { DecisionView } from "./pages/DecisionView";
import { History } from "./pages/History";
import { Inbox } from "./pages/Inbox";
import { Plan } from "./pages/Plan";
import { Settings } from "./pages/Settings";
import { Login } from "./login";
import "./style.css";

/** S2 メニュー: 受信・履歴・接続・設定。強調は今いる所で決め、履歴から開いた相談は「履歴」を強調する。 */
function Nav({ path, from }: { path: string; from?: "history" }) {
  const open = useResource(loadOpen);
  const count = open.data?.filter((d) => d.status === "pending").length ?? 0;
  useEffect(() => { document.title = count ? `(${count}) Approval Box` : "Approval Box"; }, [count]);
  const item = (href: string, label: string, active: boolean, badge?: number) => (
    <a class={`nav-item ${active ? "active" : ""}`} {...linkProps(href)}>{label}{badge ? <span class="count">{badge}</span> : null}</a>
  );
  const decision = path.startsWith("/d/");
  return (
    <nav class="nav">
      {item("/", t("受信"), path === "/" || (decision && from !== "history"), count)}
      {item("/history", t("履歴"), path === "/history" || (decision && from === "history"))}
      {item("/connections", t("接続"), path === "/connections" || path === "/pair")}
      {item("/settings", t("設定"), path === "/settings" || path === "/plan")}
    </nav>
  );
}

function App() {
  useLocale();
  // boot: この端末の鍵が、アカウントに入れられているか（keys/me）を確かめるまで。
  const [auth, setAuth] = useState<"boot" | "in" | "out">("boot");
  // S1b: ログイン済みの端末が401で出された時の理由（鍵穴のコード）。使う人が自分でログアウトした時は null。
  const [reason, setReason] = useState<string | null>(null);
  // 契約が無くて流れ（SSE）を止めた時。画面に戻ってきた時に張り直す。
  const [streamStopped, setStreamStopped] = useState(false);
  const authRef = useRef(auth);
  authRef.current = auth;
  const { path, query, state } = useLocation();
  useEffect(() => setUnauthorizedHandler((code) => {
    if (authRef.current === "in") setReason(code ?? "");
    authRef.current = "out";
    setAccount(undefined);
    setAuth("out");
  }), []);
  useEffect(() => setSignOutHandler(() => { setReason(null); setAuth("out"); navigate("/"); }), []);
  useEffect(() => {
    (async () => {
      if (!(await browserDevice().pub().catch(() => undefined))) return setAuth("out");
      try {
        const who = await browserDevice().me();
        setAccount(who);
        setAuth(who ? "in" : "out");
      } catch (error) {
        setReason((error as { code?: string }).code ?? "");
        setAuth("out");
      }
    })();
  }, []);
  useEffect(() => {
    if (auth !== "in" || streamStopped) return;
    return subscribeEvents((type, data) => { void localHistory.onEvent(type, data).finally(bump); }, () => setStreamStopped(true));
  }, [auth, streamStopped]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") { setStreamStopped(false); bump(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  if (path === "/login") { history.replaceState(null, "", "/"); } // 廃止したログインのURL（ブックマーク）で来た時
  if (auth === "boot") return <main class="shell" />;
  if (auth === "out") return <main class="shell"><Login reason={reason} onLogin={(who) => { setAccount(who); setReason(null); setAuth("in"); }} /></main>;

  let page;
  if (path.startsWith("/d/")) page = <DecisionView id={decodeURIComponent(path.slice(3))} />;
  else if (path === "/history") page = <History />;
  else if (path === "/connections") page = <Connections />;
  else if (path === "/pair") page = <Pair code={query.get("c") ?? ""} />;
  else if (path === "/plan") page = <Plan />;
  else if (path === "/settings") page = <Settings />;
  else page = <Inbox />;

  return (
    <div class="shell">
      <Nav path={path} from={state?.from} />
      <main>{page}</main>
      <AlertHost />
    </div>
  );
}

// The Google and Apple sign-in pop-ups land on /auth/<provider>/callback of this origin; the opener reads the result there and closes it, so nothing runs.
if (!location.pathname.startsWith("/auth/")) render(<App />, document.getElementById("app")!);
