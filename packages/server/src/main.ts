#!/usr/bin/env node
import { Diagnostics } from "./diagnostics.ts";
import { Apns, Fcm, Notifier, Waker } from "./push.ts";
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
import { Play } from "./play.ts";
import { createApp } from "./http.ts";
import { CallBridgeDeliverer, callBridgeSender, readHeaderFile } from "./callbridge.ts";
import { type Library, createLibrary } from "./lb.ts";
import { purgeLegacy, rekeyToK } from "./rekey.ts";
import { type PeerChannel, createPeerChannel } from "./pc.ts";
import { parseAppLinks } from "./applinks.ts";

const env = process.env;
const dataDir = resolve(env.APPROVAL_BOX_DATA ?? "data");
const port = Number(env.PORT ?? 8787);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const billing: BillingMode = env.BILLING === "store" ? "store" : "off";

const db = openDb(join(dataDir, "approval-box.db"));
const events = new EventHub(db);
// 鍵は *_FILE のファイルか、直接の値。
const secretValue = (name: string) => {
  const file = env[`${name}_FILE`];
  return (file && existsSync(file) ? readFileSync(file, "utf8") : env[name] ?? "").trim();
};
// 課金の対象外にするアカウント（運営者）。利用者IDをカンマで並べる。
const freeAccountIds = new Set((env.FREE_ACCOUNT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const accounts = new Accounts(db, events, billing, freeAccountIds);
const decisions = new Decisions(db, events);
const attachments = new Attachments(db, join(dataDir, "attachments"));

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
let apnsSend: Apns["send"] | undefined;
if (apnsKey && env.APNS_KEY_ID && env.APNS_TEAM_ID) {
  const apns = new Apns({ keyPem: apnsKey, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC ?? "dev.kitepon.approvalbox" });
  console.log(`approval-box-server: iPhoneへの通知を送ります（key ${env.APNS_KEY_ID}）`);
  apnsSend = apns.send;
}
// App Storeの購入の照合。商品IDが無ければ受け付けない。本番の購入にはアプリのApple ID（数字）が要る。
const appStoreProducts = (env.APPSTORE_PRODUCT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// 契約の状態をAppleのサーバーから読む鍵（App Store Connectの In-App Purchase のキー）。3つ揃わなければ従来どおり、署名付きの取引の値で決める。
const appStoreApi = { issuerId: (env.APPSTORE_ISSUER_ID ?? "").trim(), keyId: (env.APPSTORE_KEY_ID ?? "").trim(), privateKey: secretValue("APPSTORE_PRIVATE_KEY").replace(/\\n/g, "\n") };
const appStoreApiOn = !!appStoreApi.issuerId && !!appStoreApi.keyId && !!appStoreApi.privateKey;
if (appStoreProducts.length) console.log(appStoreApiOn ? `approval-box-server: App Storeの契約の状態をAppleから読みます（key ${appStoreApi.keyId}）` : "approval-box-server: App Store Server APIの鍵（APPSTORE_ISSUER_ID・APPSTORE_KEY_ID・APPSTORE_PRIVATE_KEY）が揃っていません。App Storeの契約は署名付きの取引の値だけで決めます。");
const appStore = appStoreProducts.length ? new AppStore(db, accounts, {
  ...(appStoreApiOn ? { api: appStoreApi } : {}),
  bundleId: env.APPSTORE_BUNDLE_ID || "dev.kitepon.approvalbox", // compose は未設定を空文字で渡す
  ...(env.APPSTORE_APP_APPLE_ID ? { appAppleId: Number(env.APPSTORE_APP_APPLE_ID) } : {}),
  productIds: appStoreProducts,
  rootCertificates: appleRootCertificates(env.APPLE_ROOT_CERTS ?? join(here, "..", "certs")),
}) : undefined;
// Google Playの購入の照合。商品・サービスアカウントの鍵・Pub/Subのpush設定が揃った時だけ使う。
const playProducts = (env.PLAY_PRODUCT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// 鍵は保管庫の項目の2つの欄（client_email・private_key）から別々に受ける。PEMの改行が \n の文字で届いても読めるようにする。
const playClientEmail = (env.PLAY_CLIENT_EMAIL ?? "").trim();
const playPrivateKey = secretValue("PLAY_PRIVATE_KEY").replace(/\\n/g, "\n");
const playServiceAccount = playClientEmail && playPrivateKey ? { client_email: playClientEmail, private_key: playPrivateKey } : undefined;
const playPushAudience = (env.PLAY_PUSH_AUDIENCE ?? "").trim();
const playPushServiceAccount = (env.PLAY_PUSH_SERVICE_ACCOUNT ?? "").trim();
const play = billing === "store" && playProducts.length && playServiceAccount && playPushAudience && playPushServiceAccount
  ? new Play(db, accounts, { packageName: env.PLAY_PACKAGE_NAME?.trim() || "dev.kitepon.approvalbox", productIds: playProducts, serviceAccount: playServiceAccount, pushAudience: playPushAudience, pushServiceAccount: playPushServiceAccount })
  : undefined;
if (play) console.log("approval-box-server: Google Playでの契約を受け付けます");
// Androidへの通知（FCM）。Firebaseのプロジェクトと、Google Playと同じサービスアカウントの鍵が揃った時だけ送る。
const fcmProject = (env.FCM_PROJECT_ID ?? "").trim();
const fcm = fcmProject && playServiceAccount ? new Fcm({ projectId: fcmProject, serviceAccount: playServiceAccount }) : undefined;
if (fcm) console.log(`approval-box-server: Androidへの通知を送ります（project ${fcmProject}）`);
if (apnsSend || fcm) new Notifier(db, events, { ...(apnsSend ? { apns: apnsSend } : {}), ...(fcm ? { fcm: fcm.send } : {}) });
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
// 共有ライブラリ（login-billing）。LB_K_KEY・LB_PASS_KEY・LB_PASS_KEY_ID が揃った時だけ /auth/v1 に置き、無ければ今まで通り。
// ストアの鍵は上の APPLE_AUDIENCES・GOOGLE_CLIENT_IDS・APPSTORE_*・PLAY_* をそのまま使う。
let library: Library | undefined;
// 保管庫の鍵は普通の base64 で入っていることがある。ライブラリは base64url を受けるので、同じバイト列のまま書き直す。
const base64url = (value: string) => value.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const lbSettings = { LB_K_KEY: base64url(secretValue("LB_K_KEY") ?? ""), LB_PASS_KEY: base64url(secretValue("LB_PASS_KEY") ?? ""), LB_PASS_KEY_ID: (env.LB_PASS_KEY_ID ?? "").trim() };
const lbMissing = Object.entries(lbSettings).filter(([, value]) => !value).map(([name]) => name);
if (lbMissing.length === 3) {
  console.log("approval-box-server: ライブラリのログインは使いません（LB_K_KEY・LB_PASS_KEY・LB_PASS_KEY_ID が未設定）");
} else if (lbMissing.length) {
  console.error(`approval-box-server: ライブラリのログインは使いません（${lbMissing.join("・")} が足りません）`);
} else {
  const previousKey = base64url(secretValue("LB_PASS_KEY_PREVIOUS") ?? "");
  const previousId = (env.LB_PASS_KEY_PREVIOUS_ID ?? "").trim();
  try {
    library = createLibrary({
      db, publicUrl, billing, kKey: lbSettings.LB_K_KEY, passKey: { id: lbSettings.LB_PASS_KEY_ID, key: lbSettings.LB_PASS_KEY },
      ...(previousKey && previousId ? { passKeyPrevious: { id: previousId, key: previousKey } } : {}),
      appleAudiences, googleAudiences, exemptK: [...freeAccountIds],
      ...(env.LB_GOOGLE_CODE_CLIENT_ID && secretValue("LB_GOOGLE_CODE_CLIENT_SECRET") ? { googleCode: { clientId: env.LB_GOOGLE_CODE_CLIENT_ID.trim(), clientSecret: secretValue("LB_GOOGLE_CODE_CLIENT_SECRET") } } : {}),
      ...(() => {
        // Web サインイン（契約1.20）。Google は Web 種のクライアント、Apple は Services ID と Sign in with Apple の鍵。そろった方だけ使う。
        const google = env.LB_WEB_GOOGLE_CLIENT_ID && secretValue("LB_WEB_GOOGLE_CLIENT_SECRET") ? { clientId: env.LB_WEB_GOOGLE_CLIENT_ID.trim(), clientSecret: secretValue("LB_WEB_GOOGLE_CLIENT_SECRET") } : undefined;
        const appleKey = secretValue("LB_WEB_APPLE_PRIVATE_KEY").replace(/\\n/g, "\n");
        const apple = env.LB_WEB_APPLE_SERVICES_ID && env.LB_WEB_APPLE_TEAM_ID && env.LB_WEB_APPLE_KEY_ID && appleKey ? { servicesId: env.LB_WEB_APPLE_SERVICES_ID.trim(), teamId: env.LB_WEB_APPLE_TEAM_ID.trim(), keyId: env.LB_WEB_APPLE_KEY_ID.trim(), privateKey: appleKey } : undefined;
        return google || apple ? { webSignIn: { ...(google ? { google } : {}), ...(apple ? { apple } : {}) } } : {};
      })(),
      ...(appStoreApiOn ? { apple: { bundleId: env.APPSTORE_BUNDLE_ID || "dev.kitepon.approvalbox", issuerId: appStoreApi.issuerId, keyId: appStoreApi.keyId, privateKey: appStoreApi.privateKey } } : {}),
      ...(playServiceAccount ? { google: { packageName: env.PLAY_PACKAGE_NAME?.trim() || "dev.kitepon.approvalbox", serviceAccount: playServiceAccount } } : {}),
    });
  } catch (error) {
    console.error(`approval-box-server: ライブラリのログインは使いません（設定が正しくありません: ${error instanceof Error ? error.message : "不明"}）`); // ライブラリの文は設定の名前だけで、値を含まない
  }
}
if (library) {
  // 利用者IDをKへ付け替える（一度きり）。前提が外れたら何も変えず、ライブラリは使わずに今まで通り動く。
  const result = await rekeyToK(db, library.lb.deriveK, (env.LB_REKEY_DELETE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if ("failed" in result) {
    console.error(`approval-box-server: アカウントの付け替えを止めました（外れた確認: ${result.failed}）。ライブラリのログインは使わず、今まで通りに動かします`);
    library = undefined;
  } else {
    const lb = library.lb;
    accounts.contract = (userId) => lb.known(userId);
    lb.onNone((userId) => decisions.endForNoContract(userId));
    console.log(`approval-box-server: ライブラリのログインを使います（付け替え ${result.rekeyed}、削除 ${result.deleted}）`);
    // ライブラリだけで動く。旧いログインと契約の行を一度だけ消す（件数だけ出す。IDは出さない）。失敗しても旧い入口は閉じたままで、次の起動でやり直す。
    const purged = purgeLegacy(db);
    if ("failed" in purged) console.error(`approval-box-server: 旧いログインと契約の行を消せませんでした（${purged.failed}）。次の起動でやり直します`);
    else console.log(`approval-box-server: 旧いログインと契約の行（一度だけ消した数）: ${Object.entries(purged).map(([table, n]) => `${table} ${n}`).join("、")}`);
  }
}
// peer-channel の server part（/pc/v1）。端末の通行証にライブラリを使うので、ライブラリがある時だけ置く。
// 起こしは今の APNs・FCM の送り手で、中身の無い決まった知らせだけ。TURN は PC_TURN_SECRET と PC_TURN_URLS が揃った時だけ。
let peerChannel: PeerChannel | undefined;
if (library) {
  const turnSecret = secretValue("PC_TURN_SECRET");
  const turnUrls = (env.PC_TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const waker = new Waker(db, { ...(apnsSend ? { apns: apnsSend } : {}), ...(fcm ? { fcm: fcm.send } : {}) });
  peerChannel = createPeerChannel({ accounts, library, publicUrl, mirrorPath: join(dataDir, "pc-mirror.db"), wake: waker.wake, ...(turnSecret && turnUrls.length ? { turn: { secret: turnSecret, urls: turnUrls } } : {}) });
  console.log(`approval-box-server: peer-channel を /pc/v1 に置きます（TURN ${turnSecret && turnUrls.length ? turnUrls.length : "なし"}）`);
}
// アプリのリンク（/.well-known）。AB_ANDROID_APP_LINKS・AB_APPLE_APP_IDS が無ければ 404 で答える。
const appLinks = parseAppLinks(env.AB_ANDROID_APP_LINKS, env.AB_APPLE_APP_IDS);
for (const problem of appLinks.problems) console.error(`approval-box-server: アプリのリンクの設定の形が違うので外しました（${problem}）`);
const diagnosticsAdminToken = env.DIAGNOSTICS_ADMIN_KEY_FILE ? readFileSync(env.DIAGNOSTICS_ADMIN_KEY_FILE,"utf8").trim() : env.DIAGNOSTICS_ADMIN_KEY;
// 停止の合図。開いたままの更新の知らせ（SSE）を正しく閉じてから終える。
const shutdown = new AbortController();
const app = createApp({ shutdown: shutdown.signal, diagnosticsAdminToken, db, accounts, decisions, events, publicUrl, attachments, appleAudiences, googleAudiences, webLogin, ...(appStore ? { appStore } : {}), ...(play ? { play } : {}), remoteMcp: { attachments, ...(callBridgeConnections ? { callBridgeConnections } : {}) }, ...(library ? { library } : {}), ...(peerChannel ? { peerChannel: peerChannel.part } : {}), appLinks: appLinks.links }, { staticHandler });

setInterval(() => {
  new Diagnostics(db).prune();
  decisions.purgeExpired();
  attachments.gc();
  accounts.prunePairings();
  library?.storage.sweep();
  events.prune(7);
}, 3600_000).unref();

const server = serve({ fetch: app.fetch, port, ...(peerChannel ? { createServer: peerChannel.createServer } : {}) }, () => {
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
    peerChannel?.part.close(); // 合図の接続を閉じ、登録の写しの DB を閉じる
    const finish = () => { try { db.close(); } catch { /* 既に閉じている */ } process.exit(0); };
    server.close(finish);
    // 新しい要求は受けず、処理中の応答が終わるのを待つ。待ちすぎないよう上限を置く。
    const http = server as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
    http.closeIdleConnections?.();
    setTimeout(() => http.closeAllConnections?.(), 3000).unref();
    setTimeout(finish, 6000).unref();
  });
}
