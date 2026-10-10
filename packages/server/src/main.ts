#!/usr/bin/env node
import { Diagnostics } from "./diagnostics.ts";
import { Apns, Notifier } from "./push.ts";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { Accounts, type BillingMode } from "./accounts.ts";
import { Attachments } from "./attachments.ts";
import { openDb } from "./db.ts";
import { Decisions } from "./decisions.ts";
import { EventHub } from "./events.ts";
import { AppStore, appleRootCertificates } from "./appstore.ts";
import { createApp } from "./http.ts";
import { CallBridgeDeliverer, callBridgeSender, readHeaderFile } from "./callbridge.ts";

const env = process.env;
const dataDir = resolve(env.APPROVAL_BOX_DATA ?? "data");
const port = Number(env.PORT ?? 8787);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const billing: BillingMode = env.BILLING === "store" ? "store" : "off";

const db = openDb(join(dataDir, "approval-box.db"));
const events = new EventHub(db);
const accounts = new Accounts(db, events, billing);
const decisions = new Decisions(db, events);
const attachments = new Attachments(db, join(dataDir, "attachments"));

const [command, ...args] = process.argv.slice(2);

if (command === "admin") {
  const [sub, value] = args;
  // 運用者だけが使う。ログインはAppleかGoogleで行い、ここでアカウントは作らない。
  if (sub === "session" && value) {
    console.log(JSON.stringify(accounts.issueSession(value, "admin"), null, 2));
  } else {
    console.error("usage: approval-box-server admin session <user_id>   # 運用の調べもの用。利用者のログインはAppleかGoogle");
    process.exit(2);
  }
  process.exit(0);
}

// Web版（packages/web のビルド結果）。APIでないGETは index.html を返し、画面の振り分けはWeb版が行う。
const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = [env.APPROVAL_BOX_WEB, join(here, "..", "public"), join(here, "..", "..", "web", "dist")].find((dir) => dir && existsSync(join(dir, "index.html")));
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};
function staticHandler(c: Context) {
  if (!webRoot) return c.text("Web版がビルドされていません（npm run build -w packages/web）。", 404);
  const path = decodeURIComponent(new URL(c.req.url).pathname);
  const file = resolve(webRoot, `.${path}`);
  const inside = file.startsWith(resolve(webRoot) + sep);
  // /privacy・/support のような公開ページは、同じ名前の .html を返す（ログインもJSも要らない）。
  const page = inside && !extname(file) && existsSync(`${file}.html`) ? `${file}.html` : null;
  const target = page ?? (inside && existsSync(file) && extname(file) ? file : join(webRoot, "index.html"));
  const headers: Record<string, string> = { "content-type": types[extname(target)] ?? "application/octet-stream" };
  if (target.includes(`${sep}assets${sep}`)) headers["cache-control"] = "public, max-age=31536000, immutable";
  else headers["cache-control"] = "no-cache";
  return c.body(readFileSync(target), 200, headers);
}

// Sign in with Apple を受けるアプリの Bundle ID（Webの Services ID も足せる）。空なら /auth/apple は使えない。
const appleAudiences = (env.APPLE_AUDIENCES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Googleのログインを受けるOAuthクライアントID（Web・iOS・Android）。空なら /auth/google は使えない。
const googleAudiences = (env.GOOGLE_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Web版のボタンに使う値。Webのクライアントも受け先に入れる。
const webLogin = { ...(env.GOOGLE_WEB_CLIENT_ID ? { google_client_id: env.GOOGLE_WEB_CLIENT_ID } : {}), ...(env.APPLE_WEB_SERVICES_ID ? { apple_services_id: env.APPLE_WEB_SERVICES_ID } : {}) };
if (webLogin.google_client_id && !googleAudiences.includes(webLogin.google_client_id)) googleAudiences.push(webLogin.google_client_id);
if (webLogin.apple_services_id && !appleAudiences.includes(webLogin.apple_services_id)) appleAudiences.push(webLogin.apple_services_id);
// iPhoneへの通知（APNs）。鍵が無ければ送らない（自分で立てたサーバーは Web Push を後で足す）。
// 鍵は APNS_KEY_FILE（.p8 のファイル。読み取り専用で渡す）か APNS_KEY（PEMの中身。改行は \n）で渡す。
const apnsKey = env.APNS_KEY_FILE ? (existsSync(env.APNS_KEY_FILE) ? readFileSync(env.APNS_KEY_FILE, "utf8") : "") : (env.APNS_KEY ?? "").replace(/\\n/g, "\n");
if (env.APNS_KEY_FILE && !apnsKey) console.error(`approval-box-server: APNS_KEY_FILE（${env.APNS_KEY_FILE}）が読めません。iPhoneへの通知は送りません。`);
if (apnsKey && env.APNS_KEY_ID && env.APNS_TEAM_ID) {
  const apns = new Apns({ keyPem: apnsKey, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC ?? "dev.kitepon.approvalbox" });
  console.log(`approval-box-server: iPhoneへの通知を送ります（key ${env.APNS_KEY_ID}）`);
  new Notifier(db, events, apns.send);
}
// App Storeの購入の照合。商品IDが無ければ受け付けない。本番の購入にはアプリのApple ID（数字）が要る。
const appStoreProducts = (env.APPSTORE_PRODUCT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const appStore = appStoreProducts.length ? new AppStore(db, accounts, {
  bundleId: env.APPSTORE_BUNDLE_ID || "dev.kitepon.approvalbox", // compose は未設定を空文字で渡す
  ...(env.APPSTORE_APP_APPLE_ID ? { appAppleId: Number(env.APPSTORE_APP_APPLE_ID) } : {}),
  productIds: appStoreProducts,
  rootCertificates: appleRootCertificates(env.APPLE_ROOT_CERTS ?? join(here, "..", "certs")),
}) : undefined;
// 答えを call-bridge の通話で届ける接続（GrokBotなど）。ヘッダーのファイル（Authorization など）が読めなければ使わない。
const callBridgeIds = (env.CALL_BRIDGE_CONNECTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
let callBridgeConnections: Set<string> | undefined;
if (callBridgeIds.length) {
  const file = env.CALL_BRIDGE_HEADERS_FILE ?? "";
  if (!file || !existsSync(file)) {
    console.error(`approval-box-server: CALL_BRIDGE_HEADERS_FILE（${file || "未設定"}）が読めません。call-bridge での配送は使いません。`);
  } else {
    const send = callBridgeSender({
      url: env.CALL_BRIDGE_URL || "https://call.kitepon.dev/mcp",
      headers: readHeaderFile(file),
      localSystem: env.CALL_BRIDGE_LOCAL_SYSTEM || "local",
      localId: env.CALL_BRIDGE_LOCAL_ID || "approval-box",
      localLabel: env.CALL_BRIDGE_LOCAL_LABEL || "Approval Box",
      memberSystem: env.CALL_BRIDGE_MEMBER_SYSTEM || "grokbot",
    });
    callBridgeConnections = new Set(callBridgeIds);
    const deliverer = new CallBridgeDeliverer(db, decisions, events, send, callBridgeConnections);
    setInterval(() => { void deliverer.sync(); }, 60_000).unref();
    void deliverer.sync();
    console.log(`approval-box-server: call-bridge で答えを届けます（接続 ${callBridgeIds.length}）`);
  }
}
const diagnosticsAdminToken = env.DIAGNOSTICS_ADMIN_KEY_FILE ? readFileSync(env.DIAGNOSTICS_ADMIN_KEY_FILE,"utf8").trim() : env.DIAGNOSTICS_ADMIN_KEY;
// 停止の合図。開いたままの更新の知らせ（SSE）を正しく閉じてから終える。
const shutdown = new AbortController();
const app = createApp({ shutdown: shutdown.signal, diagnosticsAdminToken, db, accounts, decisions, events, publicUrl, attachments, appleAudiences, googleAudiences, webLogin, ...(appStore ? { appStore } : {}), remoteMcp: { attachments, ...(callBridgeConnections ? { callBridgeConnections } : {}) } }, { staticHandler });

setInterval(() => {
  new Diagnostics(db).prune();
  decisions.purgeExpired();
  attachments.gc();
  accounts.prunePairings();
  events.prune(7);
}, 3600_000).unref();

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`approval-box-server: ${publicUrl} (port ${port}, data ${dataDir}, billing ${billing}${webRoot ? "" : ", web未ビルド"})`);
});

// コンテナの中ではこのプロセスが PID 1 で、合図を受ける処理が無いと SIGTERM は無視される。
// その場合 docker stop は10秒待ってから強制終了し、処理中の応答とSSEが途中で切れる。
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`approval-box-server: ${signal} を受けて停止します`);
    shutdown.abort();
    const finish = () => { try { db.close(); } catch { /* 既に閉じている */ } process.exit(0); };
    server.close(finish);
    // 新しい要求は受けず、処理中の応答が終わるのを待つ。待ちすぎないよう上限を置く。
    const http = server as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
    http.closeIdleConnections?.();
    setTimeout(() => http.closeAllConnections?.(), 3000).unref();
    setTimeout(finish, 6000).unref();
  });
}
