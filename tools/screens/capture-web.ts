// Captures every reachable Web client state at 390x844 and 1280x800 (ja-JP) with a stubbed API, and checks the key transitions.
// Run from the repository root:  node tools/screens/capture-web.ts [state-id ...]
// It starts the Vite dev server itself (127.0.0.1:4179). Every request that is not to 127.0.0.1 is aborted, except the
// Google/Apple sign-in scripts, which are replaced by local stubs. Nothing here touches a live server.
import { chromium, type BrowserContext, type Page, type Route } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "docs", "screenshots", "web");
const PORT = 4179, ORIGIN = `http://127.0.0.1:${PORT}`;
const SIZES = [{ name: "390", width: 390, height: 844 }, { name: "1280", width: 1280, height: 800 }];

// ---- fixtures -------------------------------------------------------------------------------------------------
const NOW = Date.now();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
type Json = Record<string, any>;
const decision = (o: Json): Json => ({
  id: "K-A1B2C3", title: "新しい版を本番へ出してよいですか？", context: "テストは全部通りました。出すと、今使っている人の画面が一度つなぎ直されます。\n詳しくは https://example.com/pull/48 を見てください。",
  options: [{ id: "go", label: "出す" }, { id: "wait", label: "今日は見送る" }], recommendation: "go", urgency: "high", deadline: iso(2 * HOUR),
  source: { client: "claude-code", session_label: "ナユタ / 本番配備", work_label: "本番配備", requester: "ナユタ", connection_label: "開発PC", via: "local" },
  status: "pending", resume_phrase: "Approval Boxの申請 K-A1B2C3 の答えを取ってください", history: [{ at: iso(-9 * MIN), kind: "created", by: "ai" }],
  created_at: iso(-9 * MIN), updated_at: iso(-9 * MIN), version: 1, ...o,
});
const pending = decision({});
const second = decision({ id: "K-D4E5F6", title: "古いログを消してよいですか？", urgency: "normal", deadline: undefined, recommendation: undefined, source: { client: "codex", session_label: "コーデックス / 掃除", requester: "コーデックス", via: "local" }, created_at: iso(-3 * HOUR) });
const testReq = decision({ id: "K-T0E1S2", title: "Approval Boxの接続テストです。どれかを選んでください。", urgency: "low", deadline: undefined, recommendation: undefined, options: [{ id: "ok", label: "確認しました" }], source: { client: "claude-code", session_label: "接続テスト", via: "local", test: true }, created_at: iso(-1 * MIN) });
const held = decision({ id: "K-H7J8K9", title: "請求書の送り先を変えてよいですか？", status: "held", urgency: "normal", deadline: undefined, recommendation: undefined, source: { client: "cursor", session_label: "カーソル / 経理", requester: "カーソル", via: "local" }, history: [{ at: iso(-2 * HOUR), kind: "created", by: "ai" }, { at: iso(-1 * HOUR), kind: "held", by: "user" }], created_at: iso(-2 * HOUR) });
const amended = decision({ id: "K-AM3ND1", title: "設定ファイルを書き換えてよいですか？", distinct_reason: "前の申請は別のファイルです。", history: [{ at: iso(-20 * MIN), kind: "created", by: "ai" }, { at: iso(-5 * MIN), kind: "amended", by: "ai", fields: ["context", "options"], note: "選択肢を1つ足しました" }], version: 2 });
const answered = decision({ id: "K-AN5WR1", status: "answered", delivery: "delivered", answer: { option_id: "go", answered_at: iso(-8 * MIN) }, history: [{ at: iso(-30 * MIN), kind: "created", by: "ai" }, { at: iso(-8 * MIN), kind: "answered", by: "user" }], updated_at: iso(-8 * MIN) });
const answeredText = decision({ id: "K-AN5WR2", title: "ログの保存先を変えてよいですか？", status: "answered", delivery: "unknown", answer: { text: "いったん今のままにしてください", answered_at: iso(-2 * HOUR) }, updated_at: iso(-2 * HOUR), deadline: undefined });
const cancelled = decision({ id: "K-CANC31", title: "この申請は要らなくなりました", status: "cancelled", cancel_reason: "別の方法で解決しました", updated_at: iso(-26 * HOUR), deadline: undefined });
const detail: Record<string, Json> = Object.fromEntries([pending, second, testReq, held, amended, answered, answeredText, cancelled].map((d) => [d.id, d]));

const me = (o: Json = {}): Json => ({ user_id: "k-demo", login: "google", plan: "active", store: "app_store", billing: "store", setup: { verified: true, checks: [] }, ...o });
const device: Json = { id: "c-pc", kind: "device", label: "開発PC", os: "linux", clients: ["claude-code", "codex"], created_at: iso(-72 * HOUR), last_seen_at: iso(-4 * MIN) };
const clientConn: Json = { id: "c-bt", kind: "client", label: "BellTeam", clients: [], created_at: iso(-48 * HOUR), last_seen_at: iso(-1 * HOUR) };
const checks = [{ connection_id: "c-pc", client: "claude-code", status: "passed", tested_at: iso(-70 * HOUR) }, { connection_id: "c-pc", client: "codex", status: "failed", failed_step: "delivery", tested_at: iso(-60 * MIN) }];

// ---- the stub --------------------------------------------------------------------------------------------------
type Opts = {
  library?: boolean; config?: Json; signedIn?: boolean; me?: Json; open?: Json[]; closed?: Json[]; connections?: Json[]; paid402?: boolean;
  pairing?: Json; takes?: ("pending" | "ready" | "gone")[]; stallConfig?: boolean; stallStart?: boolean; startFails?: boolean;
};
type Stub = { signedIn: boolean; starts: number; signouts: number; deletes: string[]; answers: string[]; exports: number; claims: string[]; sessionHeaders: (string | undefined)[] };
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

async function install(context: BrowserContext, o: Opts): Promise<Stub> {
  const s: Stub = { signedIn: o.signedIn ?? false, starts: 0, signouts: 0, deletes: [], answers: [], exports: 0, claims: [], sessionHeaders: [] };
  const takes = [...(o.takes ?? ["pending"])];
  if (!o.library && s.signedIn) await context.addInitScript(() => localStorage.setItem("approval-box.session", "capture-fixture-only"));
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  await context.route("https://accounts.google.com/gsi/client", (route) => route.fulfill({ contentType: "text/javascript", body: `window.google={accounts:{id:{initialize(){},renderButton(el){el.innerHTML='<div style="width:280px;height:40px;border:1px solid #888;border-radius:4px;display:flex;align-items:center;justify-content:center;font:14px sans-serif;color:#555;background:#fff">[Google draws its own button here (capture stub)]</div>'}}}}` }));
  await context.route("https://appleid.cdn-apple.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: `window.AppleID={auth:{init(){},signIn(){return Promise.reject({error:"capture_stub_failure"})}}}` }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    s.sessionHeaders.push(await req.headerValue("authorization") ?? undefined);
    if (p === "/v1/auth/config") { if (o.stallConfig) return; return json(route, 200, { ...(o.config ?? {}), ...(o.library ? { library_login: true } : {}) }); }
    if (!s.signedIn) return json(route, 401, o.library ? { error: "pass_invalid" } : { error: { code: "unauthorized", message: "ログイン情報が無効か、期限が切れています。もう一度ログインしてください。" } });
    if (p === "/v1/me" && m === "GET") return json(route, 200, o.me ?? me());
    if (p === "/v1/me" && m === "DELETE") { s.deletes.push("me"); s.signedIn = false; return json(route, 200, { ok: true }); }
    if (p === "/v1/me/settings") return json(route, 200, { retention_days: 30 });
    if (p === "/v1/me/export") { s.exports++; return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-disposition": 'attachment; filename="approval-box-export-20261121.json"' }, body: "{}" }); }
    if (p === "/v1/auth/logout") { s.signedIn = false; return json(route, 200, { ok: true }); }
    if (o.paid402 && (p.startsWith("/v1/decisions") || p === "/v1/events")) return json(route, 402, { error: { code: "subscription_expired", message: "Approval Boxの契約がありません。iPhone・Mac・Android のアプリで契約してください。" } });
    if (p === "/v1/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (p === "/v1/decisions" && m === "GET") return json(route, 200, { items: url.searchParams.get("status")?.includes("answered") ? (o.closed ?? []) : (o.open ?? []) });
    if (p === "/v1/decisions" && m === "DELETE") { s.deletes.push("closed"); o.closed = []; return json(route, 200, { deleted: 3 }); }
    const d = /^\/v1\/decisions\/([^/]+)(?:\/(\w+))?$/.exec(p);
    if (d && d[2] === "attachments") return json(route, 200, { items: [] });
    if (d && m === "GET") return detail[d[1]!] ? json(route, 200, detail[d[1]!]) : json(route, 404, { error: { code: "not_found", message: "項目が見つかりません。" } });
    if (d && m === "POST" && d[2] === "answer") { s.answers.push(d[1]!); return json(route, 200, { ...detail[d[1]!], status: "answered", delivery: "waiting" }); }
    if (d && m === "POST" && (d[2] === "hold" || d[2] === "unhold")) return json(route, 200, { ...detail[d[1]!], status: d[2] === "hold" ? "held" : "pending", version: 2 });
    if (p === "/v1/connections" && m === "GET") return json(route, 200, o.connections ?? []);
    if (p === "/v1/pairing/lookup") return o.pairing && "error" in o.pairing ? json(route, 404, { error: { code: "not_found", message: o.pairing.error } }) : json(route, 200, o.pairing ?? {});
    const pr = /^\/v1\/pairing\/([^/]+)\/(claim|reject)$/.exec(p);
    if (pr) { s.claims.push(pr[2]!); return json(route, 200, { ok: true }); }
    return json(route, 404, { error: { code: "not_found", message: "項目が見つかりません。" } });
  });
  await context.route("**/auth/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice("/auth/v1/".length);
    if (path === "handoff/start") {
      s.starts++;
      if (o.stallStart) return;
      if (o.startFails) return json(route, 500, { error: "internal" });
      return json(route, 200, { slotId: "s".repeat(22), qrPayload: "lbq1:" + "s".repeat(22), shortCode: s.starts > 1 ? "WXYZ6789" : "ABCD2345", takeSecret: "secret", checkNumber: "42", expiresAt: iso(5 * MIN) });
    }
    if (path === "handoff/take") {
      const next = takes.shift() ?? "pending";
      if (next === "gone") return json(route, 410, { error: "slot_gone" });
      if (next === "ready") s.signedIn = true;
      return json(route, 200, { status: next });
    }
    if (path === "signout") { s.signouts++; s.signedIn = false; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: "bad_request" });
  });
  return s;
}

// ---- scenarios ------------------------------------------------------------------------------------------------
type Scenario = { id: string; path?: string; opts: Opts; act?: (page: Page, stub: Stub) => Promise<void>; ready: (page: Page) => Promise<unknown> };
const both = { google_client_id: "capture-stub.apps.example", apple_services_id: "dev.example.web" };
const apple = { apple_services_id: "dev.example.web" };
const text = (page: Page, value: string) => page.getByText(value, { exact: false }).first().waitFor({ timeout: 10_000 });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true }).first().waitFor({ timeout: 10_000 });
const signedIn: Opts = { signedIn: true, config: {} };
const lib: Opts = { library: true, signedIn: true };
const SUBSCRIBE = "iPhone・Mac・Android のアプリで契約してください";
const pc = { pairing_id: "p1", device_name: "開発PC", os: "linux", clients: ["claude-code", "codex"] };
const conns = { ...signedIn, connections: [device, clientConn], me: me({ setup: { verified: true, checks } }) };

const scenarios: Scenario[] = [
  // signed out
  { id: "boot", opts: { stallConfig: true }, ready: (p) => p.getByLabel("言語").first().waitFor() },
  { id: "login-id", opts: { config: both }, ready: (p) => text(p, "GoogleとAppleは別のアカウントになります") },
  { id: "login-id-apple-error", opts: { config: apple }, act: async (p) => { await p.getByRole("button", { name: "Appleでログイン" }).click(); }, ready: (p) => text(p, "Appleのログインができませんでした。") },
  { id: "login-none", opts: { config: {} }, ready: (p) => text(p, "このサーバーにはログインの設定がありません") },
  { id: "login-library-loading", opts: { library: true, stallStart: true }, ready: (p) => heading(p, "Approval Box") },
  { id: "login-library", opts: { library: true }, ready: (p) => text(p, "表示される番号が 42 か確かめてください") },
  { id: "login-library-expired", opts: { library: true, takes: ["gone"] }, ready: (p) => text(p, "コードの有効期限が切れました。") },
  { id: "login-library-error", opts: { library: true, startFails: true }, ready: (p) => text(p, "コードを出せませんでした。") },
  // signed in: inbox
  { id: "inbox", opts: { ...signedIn, open: [testReq, pending, second, held, amended] }, ready: (p) => text(p, "古いログを消してよいですか？") },
  { id: "inbox-empty", opts: { ...signedIn, open: [] }, ready: (p) => text(p, "いま答えを待っている申請はありません。") },
  { id: "inbox-402", opts: { ...lib, paid402: true }, ready: (p) => text(p, SUBSCRIBE) },
  // decision
  { id: "decision-open", path: "/d/K-A1B2C3", opts: signedIn, ready: (p) => text(p, "今日は見送る") },
  { id: "decision-open-amended", path: "/d/K-AM3ND1", opts: signedIn, ready: (p) => text(p, "AIが修正しました") },
  { id: "decision-held", path: "/d/K-H7J8K9", opts: signedIn, ready: (p) => text(p, "保留を戻す") },
  { id: "decision-answered", path: "/d/K-AN5WR1", opts: signedIn, ready: (p) => text(p, "答え:") },
  { id: "decision-answered-unknown", path: "/d/K-AN5WR2", opts: signedIn, ready: (p) => text(p, "AIへ届いたか確かめられませんでした") },
  { id: "decision-cancelled", path: "/d/K-CANC31", opts: signedIn, ready: (p) => text(p, "AIが取り下げました") },
  { id: "decision-error", path: "/d/K-NOPE00", opts: signedIn, ready: (p) => text(p, "項目が見つかりません。") },
  { id: "decision-402", path: "/d/K-A1B2C3", opts: { ...lib, paid402: true }, ready: (p) => text(p, SUBSCRIBE) },
  // history
  { id: "history", path: "/history", opts: { ...signedIn, closed: [answered, answeredText, cancelled] }, ready: (p) => text(p, "既決の履歴を削除") },
  { id: "history-empty", path: "/history", opts: { ...signedIn, closed: [] }, ready: (p) => text(p, "まだ答えた申請はありません。") },
  { id: "history-402", path: "/history", opts: { ...lib, paid402: true }, ready: (p) => text(p, SUBSCRIBE) },
  // connections / pairing
  { id: "connections-empty", path: "/connections", opts: { ...signedIn, connections: [] }, ready: (p) => text(p, "はじめに: PCにコネクタを入れる") },
  { id: "connections", path: "/connections", opts: conns, ready: (p) => text(p, "開発PC") },
  { id: "connections-test-hint", path: "/connections", opts: conns, act: async (p) => { await p.getByRole("button", { name: "接続テスト" }).click(); }, ready: (p) => text(p, "Approval Boxのsetup_testを実行して") },
  { id: "pair-device", path: "/pair?c=ABCD-EFGH", opts: { ...signedIn, pairing: pc }, ready: (p) => text(p, "次の端末を、あなたのApproval Boxに追加しますか？") },
  { id: "pair-done", path: "/pair?c=ABCD-EFGH", opts: { ...signedIn, pairing: pc }, act: async (p) => { await p.getByRole("button", { name: "この端末を追加" }).click(); }, ready: (p) => text(p, "追加しました。PCの画面でセットアップが続きます。") },
  { id: "pair-client", path: "/pair?c=ABCD-EFGH", opts: { ...signedIn, pairing: { pairing_id: "p2", device_name: "BellTeam サーバー", clients: [], client: "bellteam", client_name: "BellTeam" } }, ready: (p) => text(p, "許可する") },
  { id: "pair-error", path: "/pair?c=ZZZZ-0000", opts: { ...signedIn, pairing: { error: "そのコードは見つからないか、期限が切れています。PCで npx -y approval-box@latest setup をやり直してください。" } }, ready: (p) => text(p, "そのコードは見つからないか") },
  // settings
  { id: "settings-subscribed", path: "/settings", opts: signedIn, ready: (p) => text(p, "App Storeで契約中") },
  { id: "settings-expired", path: "/settings", opts: { ...signedIn, me: me({ plan: "expired", expires_at: iso(-24 * HOUR), setup: { verified: true, checks } }) }, ready: (p) => text(p, "期限切れ") },
  { id: "settings-unverified", path: "/settings", opts: { ...signedIn, me: me({ plan: "expired", store: undefined, setup: { verified: false, checks: [] } }) }, ready: (p) => text(p, "契約の前に、セットアップ確認を済ませてください。") },
  { id: "settings-no-contract", path: "/settings", opts: { ...lib, me: me({ login: null, plan: "expired", store: undefined, setup: { verified: true, checks } }) }, ready: (p) => text(p, "未契約") },
  { id: "settings-selfhost", path: "/settings", opts: { ...signedIn, me: me({ billing: "off", plan: "active", store: undefined }) }, ready: (p) => text(p, "料金はかかりません") },
  { id: "settings-library", path: "/settings", opts: { ...lib, me: me({ login: null, store: "google_play" }) }, ready: (p) => text(p, "Google Playで契約中") },
];

// ---- transition checks (each prints one line; a failure is reported and the exit code is 1) --------------------------
type Check = { name: string; opts: Opts; path?: string; run: (page: Page, stub: Stub) => Promise<void> };
const urlIs = (page: Page, expected: string) => page.waitForURL((u) => u.pathname + u.search === expected, { timeout: 10_000 });
const bump = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const QR = "表示される番号が 42 か確かめてください";
const EMPTY = "いま答えを待っている申請はありません。";
const checkList: Check[] = [
  { name: "library: take=ready opens the inbox (no Authorization header ever sent)", opts: { library: true, takes: ["pending", "ready"] }, run: async (p, s) => {
    await p.getByRole("link", { name: "受信" }).waitFor({ timeout: 10_000 }); if (s.sessionHeaders.some((h) => h)) throw new Error("Authorization header seen"); } },
  { name: "library: pass stopped (401 pass_invalid) while signed in returns to the QR screen", opts: { ...lib, open: [] }, run: async (p, s) => {
    await text(p, EMPTY); s.signedIn = false; await bump(p); await text(p, QR); } },
  { name: "id login: 401 while signed in returns to the sign-in screen", opts: { ...signedIn, config: both, open: [] }, run: async (p, s) => {
    await text(p, EMPTY); s.signedIn = false; await bump(p); await text(p, "GoogleとAppleは別のアカウントになります"); } },
  { name: "402 keeps the menu and shows the subscribe-in-the-app text; 設定 still opens", opts: { ...lib, paid402: true }, run: async (p) => {
    await text(p, SUBSCRIBE); await p.getByRole("link", { name: "設定" }).click(); await urlIs(p, "/settings"); await heading(p, "契約"); } },
  { name: "inbox card -> /d/<id>; an option button answers and returns to /", opts: { ...signedIn, open: [pending] }, run: async (p, s) => {
    await p.getByText("新しい版を本番へ出してよいですか？").click(); await urlIs(p, "/d/K-A1B2C3");
    await p.getByRole("button", { name: /^出す/ }).click(); await urlIs(p, "/"); if (s.answers.length !== 1) throw new Error("no answer sent"); } },
  { name: "decision: 保留にする stays on /d/<id> and flips to 保留を戻す", opts: { ...signedIn, open: [pending] }, path: "/d/K-A1B2C3", run: async (p) => {
    await p.getByRole("button", { name: "保留にする" }).click(); await p.getByRole("button", { name: "保留を戻す" }).waitFor(); } },
  { name: "nav: 既決 / 接続 / 設定 / 受信 go to /history /connections /settings /", opts: { ...signedIn, open: [], closed: [], connections: [] }, run: async (p) => {
    await p.getByRole("link", { name: "既決" }).click(); await urlIs(p, "/history");
    await p.getByRole("link", { name: "接続" }).click(); await urlIs(p, "/connections");
    await p.getByRole("link", { name: "設定" }).click(); await urlIs(p, "/settings");
    await p.getByRole("link", { name: "受信" }).click(); await urlIs(p, "/"); } },
  { name: "設定 接続とテストへ -> /connections; 次へ -> /pair?c=; この端末を追加 then 接続へ -> /connections", opts: { ...signedIn, me: me({ plan: "expired", store: undefined, setup: { verified: false, checks: [] } }), connections: [], pairing: pc }, path: "/settings", run: async (p) => {
    await p.getByRole("button", { name: "接続とテストへ" }).click(); await urlIs(p, "/connections");
    await p.getByPlaceholder("ABCD-EFGH").fill("abcd-efgh"); await p.getByRole("button", { name: "次へ" }).click(); await urlIs(p, "/pair?c=abcd-efgh");
    await p.getByRole("button", { name: "この端末を追加" }).click(); await p.getByRole("button", { name: "接続へ" }).click(); await urlIs(p, "/connections"); } },
  { name: "library: ログアウト calls signout and shows a fresh QR at /", opts: { ...lib, open: [] }, path: "/settings", run: async (p, s) => {
    await p.getByRole("button", { name: "ログアウト" }).click(); await text(p, QR); await urlIs(p, "/"); if (s.signouts !== 1) throw new Error("no signout"); } },
  { name: "library: アカウントと全データを削除 (confirm, then 削除 typed) -> DELETE /me, signout, QR screen", opts: { ...lib, open: [] }, path: "/settings", run: async (p, s) => {
    p.on("dialog", (d) => void (d.type() === "prompt" ? d.accept("削除") : d.accept()));
    await p.getByRole("button", { name: "アカウントと全データを削除" }).click(); await text(p, QR); if (!s.deletes.includes("me") || s.signouts !== 1) throw new Error("not deleted"); } },
  { name: "保存されている情報の写しを受け取る downloads a file and stays on /settings", opts: lib, path: "/settings", run: async (p, s) => {
    const dl = p.waitForEvent("download"); await p.getByRole("button", { name: "保存されている情報の写しを受け取る" }).click(); await dl; if (s.exports !== 1) throw new Error("no export"); await urlIs(p, "/settings"); } },
  { name: "an unknown path shows the inbox", opts: { ...signedIn, open: [] }, path: "/nowhere", run: async (p) => { await text(p, EMPTY); } },
];

// ---- runner ---------------------------------------------------------------------------------------------------
async function waitForServer() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("dev server did not start");
}

const only = process.argv.slice(2);
const vite = spawn(join(root, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: join(root, "packages", "web"), stdio: "ignore" });
let failed = 0;
try {
  await waitForServer();
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const open = async (size: { width: number; height: number }, opts: Opts) => {
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: size.width, height: size.height }, serviceWorkers: "block", acceptDownloads: true });
    const stub = await install(context, opts);
    return { context, stub, page: await context.newPage() };
  };
  for (const sc of scenarios.filter((s) => !only.length || only.includes(s.id))) {
    for (const size of SIZES) {
      const { context, stub, page } = await open(size, sc.opts);
      try {
        await page.goto(ORIGIN + (sc.path ?? "/"));
        if (sc.act) await sc.act(page, stub); // the click waits for its button itself
        await sc.ready(page);
        await page.waitForTimeout(250);
        // Below 720px the menu is a tab bar fixed to the bottom of the viewport, so a tall page is shot with a tall viewport (not fullPage) to keep the bar at the bottom.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        if (size.width < 720 && height > size.height) { await page.setViewportSize({ width: size.width, height }); await page.waitForTimeout(100); }
        await page.screenshot({ path: join(outDir, `${sc.id}-${size.name}.png`), fullPage: size.width >= 720 });
        console.log(`shot  ${sc.id}-${size.name}`);
      } catch (error) { failed++; console.error(`FAIL  ${sc.id}-${size.name}: ${(error as Error).message.split("\n")[0]}`); }
      await context.close();
    }
  }
  if (!only.length) for (const check of checkList) {
    const { context, stub, page } = await open(SIZES[1]!, check.opts);
    try { await page.goto(ORIGIN + (check.path ?? "/")); await check.run(page, stub); console.log(`ok    ${check.name}`); }
    catch (error) { failed++; console.error(`FAIL  ${check.name}: ${(error as Error).message.split("\n")[0]}`); }
    await context.close();
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(failed ? 1 : 0);
