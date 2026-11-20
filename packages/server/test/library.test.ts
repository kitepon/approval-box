import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKWith } from "@kitepon/login-billing/server";
import { Accounts } from "../src/accounts.ts";
import { Attachments } from "../src/attachments.ts";
import { all, get, openDb, run, type Db } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { PRODUCT_ID, SqliteStorage, createLibrary, rateLimiter } from "../src/lb.ts";
import { hash } from "../src/ids.ts";
import { resetKeyCache } from "../src/oidc.ts";

// 共有ライブラリは公開の入口だけで動かす。AppleとGoogleは、偽のfetch（公開鍵とApp Store Server APIの答え）で代える。
const ORIGIN = "https://kb.test";
const BUNDLE = "dev.kitepon.approvalbox";
const GOOGLE_ID = "g-client";
const K_KEY = randomBytes(32).toString("base64url");
const PASS_KEY = randomBytes(32).toString("base64url");
const kOf = (provider: "apple" | "google", sub: string) => deriveKWith(Buffer.from(K_KEY, "base64url"), provider, sub);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "t1", alg: "RS256" };
const applePem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(provider: "apple" | "google", aud: string, nonce: string, sub: string) {
  const head = `${enc({ alg: "RS256", kid: "t1" })}.${enc({
    iss: provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com", aud, sub,
    exp: Math.floor(Date.now() / 1000) + 600, nonce: provider === "apple" ? createHash("sha256").update(nonce).digest("hex") : nonce,
  })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(rsa.privateKey).toString("base64url")}`;
}

/** 公開鍵と、App Store Server API（取引1つ・契約1つ）の答え。取引の印（appAccountToken）は state.mark。 */
function fakeFetch(state: { mark: string }) {
  const jws = (payload: object) => `${enc({ alg: "ES256" })}.${enc(payload)}.sig`;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://appleid.apple.com/auth/keys" || url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    const hit = url.match(/^https:\/\/api\.storekit\.itunes\.apple\.com\/inApps\/v1\/(transactions|subscriptions)\/(\d+)$/);
    if (!hit) return new Response("", { status: 404 });
    const tx = { bundleId: BUNDLE, productId: PRODUCT_ID, originalTransactionId: "1000", transactionId: "2000", appAccountToken: state.mark, expiresDate: Date.now() + 30 * 86400_000 };
    if (hit[1] === "transactions") return Response.json({ signedTransactionInfo: jws(tx) });
    return Response.json({ data: [{ lastTransactions: [{ status: 1, originalTransactionId: "1000", signedTransactionInfo: jws(tx), signedRenewalInfo: jws({}) }] }] });
  }) as typeof fetch;
}

function setup(options: { billing?: "off" | "store"; exempt?: string[]; offsetMs?: { value: number } } = {}) {
  resetKeyCache();
  const billing = options.billing ?? "store";
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const exempt = new Set(options.exempt ?? []);
  const accounts = new Accounts(db, events, billing, exempt);
  const decisions = new Decisions(db, events);
  const attachments = new Attachments(db, mkdtempSync(join(tmpdir(), "ab-lib-")));
  const state = { mark: "" };
  const offset = options.offsetMs ?? { value: 0 };
  const library = createLibrary({
    db, publicUrl: ORIGIN, billing, kKey: K_KEY, passKey: { id: "p1", key: PASS_KEY }, appleAudiences: [BUNDLE], googleAudiences: [GOOGLE_ID], exemptK: [...exempt],
    apple: { bundleId: BUNDLE, issuerId: "iss", keyId: "kid", privateKey: applePem }, fetch: fakeFetch(state), now: () => Date.now() + offset.value,
  });
  accounts.contract = (userId) => library.lb.known(userId);
  library.lb.onNone((userId) => decisions.endForNoContract(userId));
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, attachments, library, appleAudiences: [BUNDLE], idKeys: async () => [jwk as never] });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, { method, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json", ...opts.headers }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSONでない */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signIn = async (sub: string, provider: "apple" | "google" = "apple") => {
    const nonce = (await call("POST", "/auth/v1/signin/nonce")).json.nonce as string;
    const res = await call("POST", "/auth/v1/signin", { body: { provider, idToken: idToken(provider, provider === "apple" ? BUNDLE : GOOGLE_ID, nonce, sub), nonce } });
    assert.equal(res.status, 200);
    return res.json as { pass: string; k: string; purchaseMark: string };
  };
  return { db, app, accounts, decisions, attachments, library, state, offset, call, signIn };
}
type Ctx = ReturnType<typeof setup>;

/** 申請の行をそのまま入れる（AIの確認の札を通さずに、申請がある状態を作る）。 */
function insertDecision(db: Db, userId: string, id: string, extra: { test?: number; status?: string; title?: string; connection_id?: string } = {}) {
  run(db, `insert into decisions (id, user_id, connection_id, title, norm_title, context, options, urgency, client, session_label, via, test, status, resume_phrase, created_at, updated_at, version)
    values (?, ?, ?, ?, ?, '', ?, 'normal', 'claude-code', 's', 'connector', ?, ?, 'r', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 1)`,
  id, userId, extra.connection_id ?? null, extra.title ?? id, extra.title ?? id, JSON.stringify([{ id: "a", label: "A" }, { id: "b", label: "B" }]), extra.test ?? 0, extra.status ?? "pending");
}

test("lb_kv: 期限切れは読まず、掃除で消え、同じ鍵は上書きされる。表は移行で作られる", () => {
  const db = openDb(":memory:");
  let at = 1_000_000;
  const storage = new SqliteStorage(db, () => at);
  return (async () => {
    await storage.put("nonce:a", "1", 1000);
    await storage.put("slot:b", "x", 5000);
    assert.equal(await storage.get("nonce:a"), "1");
    at += 1000; // 期限ちょうどは切れ
    assert.equal(await storage.get("nonce:a"), undefined);
    assert.equal(get<{ n: number }>(db, "select count(*) n from lb_kv")?.n, 2); // 読む側が無視するだけで、行はまだある
    storage.sweep();
    assert.deepEqual(all<{ key: string }>(db, "select key from lb_kv").map((r) => r.key), ["slot:b"]);
    await storage.put("slot:b", "y", 1000);
    assert.equal(await storage.get("slot:b"), "y");
    await storage.delete("slot:b");
    assert.equal(await storage.get("slot:b"), undefined);
    assert.equal(get<{ user_version: number }>(db, "pragma user_version")?.user_version, 16);
  })();
});

test("回数制限は接続元ごとで、窓が過ぎると戻る", () => {
  let at = 0;
  const allow = rateLimiter(2, 1000, () => at);
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("b")], [true, true, false, true]);
  at = 1000;
  assert.equal(allow("a"), true);
});

test("ライブラリを使わない時は今までどおり: /auth/v1 は無く、sessionで入れて、写しも取れる", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: ORIGIN });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  assert.equal((await app.request("/auth/v1/signin/nonce", { method: "POST" })).status, 404);
  const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${session}` } });
  assert.equal(me.status, 200);
  const body = await me.json() as Record<string, unknown>;
  assert.equal(body.user_id, userId);
  assert.equal("purchase_mark" in body, false);
  assert.equal((await app.request("/v1/me/export", { headers: { authorization: `Bearer ${session}` } })).status, 200);
  assert.equal((await app.request("/v1/me", { headers: { authorization: "Bearer kss_nobody" } })).status, 401);
});

test("受け口: signin/nonce と signin に答え、K は公開の deriveK と同じ。回数は接続元ごとに絞る", async () => {
  const x = setup();
  const nonce = await x.call("POST", "/auth/v1/signin/nonce", { headers: { "x-forwarded-for": "9.9.9.9" } });
  assert.equal(nonce.status, 200);
  assert.match(nonce.json.nonce, /^[A-Za-z0-9_-]{22}$/);
  const signed = await x.signIn("sub-1");
  assert.equal(signed.k, await kOf("apple", "sub-1"));
  assert.equal(signed.purchaseMark, signed.k);
  const bad = await x.call("POST", "/auth/v1/signin", { body: { provider: "apple", idToken: "x.y.z", nonce: nonce.json.nonce } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, "signin_invalid");
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) statuses.push((await x.call("POST", "/auth/v1/signin/nonce", { headers: { "x-forwarded-for": "7.7.7.7" } })).status);
  assert.equal(statuses.filter((s) => s === 200).length, 60);
  assert.equal(statuses[60], 429);
  assert.equal((await x.call("POST", "/auth/v1/signin/nonce", { headers: { "x-forwarded-for": "8.8.8.8" } })).status, 200);
  for (let i = 0; i < 21; i++) statuses[i] = (await x.call("POST", "/auth/v1/handoff/start", { headers: { "x-forwarded-for": "7.7.7.7" }, body: { deviceLabel: "Chrome" } })).status;
  assert.equal(statuses[19], 200);
  assert.equal(statuses[20], 429);
});

test("G1: 契約の無い通行証は、申請と更新の知らせが402。/me・設定・写し・削除・セットアップ確認の申請は通る", async () => {
  const x = setup();
  const { pass, k } = await x.signIn("sub-g1");
  const me = await x.call("GET", "/v1/me", { token: pass });
  assert.equal(me.status, 200);
  assert.equal(me.json.user_id, k);
  assert.equal(me.json.plan, "expired");
  assert.equal(me.json.purchase_mark, k);
  assert.equal("store" in me.json, false);
  assert.ok(get(x.db, "select 1 from users where id = ?", k));
  insertDecision(x.db, k, "K-NORMAL");
  for (const [method, path] of [["GET", "/v1/decisions"], ["GET", "/v1/decisions/K-NORMAL"], ["POST", "/v1/decisions/K-NORMAL/answer"], ["POST", "/v1/decisions/K-NORMAL/hold"], ["DELETE", "/v1/decisions?status=answered,cancelled"], ["GET", "/v1/decisions/K-NORMAL/attachments"], ["GET", "/v1/events"]] as const) {
    const res = await x.call(method, path, { token: pass, ...(method === "POST" ? { body: { option_id: "a", version: 1 } } : {}) });
    assert.equal(res.status, 402, `${method} ${path}`);
    assert.equal(res.json.error.code, "subscription_expired");
  }
  assert.equal((await x.call("GET", "/v1/me/settings", { token: pass })).status, 200);
  assert.equal((await x.call("GET", "/v1/pairing/lookup?code=AAAA-BBBB", { token: pass })).status, 404);
  assert.equal((await x.call("GET", "/v1/me/export", { token: pass })).status, 200);
  // セットアップ確認の申請は、読めて答えられる。
  const conn = x.accounts.createConnection(k, "pc", "linux", ["claude-code"]);
  const started = await x.call("POST", "/connector/v1/setup-test", { token: conn.token, body: { client: "claude-code", session_label: "s" } });
  assert.equal(started.status, 200);
  const id = started.json.decision_id as string;
  assert.equal((await x.call("GET", `/v1/decisions/${id}`, { token: pass })).status, 200);
  assert.equal((await x.call("POST", `/v1/decisions/${id}/answer`, { token: pass, body: { option_id: "ok", version: 1 } })).status, 200);
  assert.equal((await x.call("DELETE", "/v1/me", { token: pass })).status, 200);
});

test("通行証の更新は Login-Billing-Pass に付いて返り、更新後の通行証でも入れる", async () => {
  const x = setup();
  const { pass } = await x.signIn("sub-renew");
  assert.equal((await x.call("GET", "/v1/me/settings", { token: pass })).headers.get("login-billing-pass"), null);
  x.offset.value = 25 * 3600_000;
  const renewed = (await x.call("GET", "/v1/me/settings", { token: pass })).headers.get("login-billing-pass");
  assert.ok(renewed && renewed !== pass);
  assert.equal((await x.call("GET", "/v1/me/settings", { token: renewed })).status, 200);
  // 通行証でないBearerは、通行証の誤りにせず、今までのsessionとして断る。
  assert.equal((await x.call("GET", "/v1/me", { token: "kss_nobody" })).status, 401);
});

test("ストアの契約がある通行証は通り、/me は store と期限を返す", async () => {
  const x = setup();
  const { pass, k } = await x.signIn("sub-paid");
  x.state.mark = k;
  const attached = await x.call("POST", "/auth/v1/receipt", { token: pass, body: { receipts: [{ store: "apple", transactionId: "2000" }] } });
  assert.equal(attached.status, 200);
  assert.equal(attached.json.receiptResults[0].result, "attached");
  const me = await x.call("GET", "/v1/me", { token: attached.json.pass });
  assert.equal(me.json.plan, "active");
  assert.equal(me.json.store, "app_store");
  assert.ok(Date.parse(me.json.expires_at) > Date.now());
  assert.equal((await x.call("GET", "/v1/decisions", { token: attached.json.pass })).status, 200);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from appstore_subscriptions")?.n, 0); // 契約の行は書かない
});

test("課金の対象外のK（FREE_ACCOUNT_IDS）は契約なしで通り、/me に store も期限も出ない", async () => {
  const exempt = await kOf("apple", "sub-owner");
  const x = setup({ exempt: [exempt] });
  const { pass } = await x.signIn("sub-owner");
  const me = await x.call("GET", "/v1/me", { token: pass });
  assert.equal(me.json.user_id, exempt);
  assert.equal(me.json.plan, "active");
  assert.equal("store" in me.json || "expires_at" in me.json, false);
  assert.equal((await x.call("GET", "/v1/decisions", { token: pass })).status, 200);
});

test("G2: ライブラリの覚え none は402、active は通し、unknown は今までの契約の確認", () => {
  const x = setup();
  const userId = x.accounts.createUser();
  let known: "active" | "none" | "unknown" = "none";
  x.accounts.contract = () => known;
  run(x.db, "update users set plan = 'active', plan_expires_at = '2999-01-01T00:00:00.000Z' where id = ?", userId);
  assert.throws(() => x.accounts.assertCanUse(userId), (e: any) => e.status === 402); // 今までの契約が有効でも、ライブラリが none ならだめ
  known = "unknown";
  assert.doesNotThrow(() => x.accounts.assertCanUse(userId));
  run(x.db, "update users set plan = 'expired' where id = ?", userId);
  assert.throws(() => x.accounts.assertCanUse(userId), (e: any) => e.status === 402);
  known = "active";
  assert.doesNotThrow(() => x.accounts.assertCanUse(userId)); // 今までの契約が切れていても、ライブラリが active なら通す
});

test("G2: 接続トークンとBellTeamのsessionに、ライブラリの none が効く（/me は通す）。覚えが無い間は今までの確認", async () => {
  const x = setup();
  const decisionBody = { title: "t", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], session_label: "s", client: "claude-code" };
  const reach = (k: string) => {
    const conn = x.accounts.createConnection(k, "pc", "linux", ["claude-code"]);
    return { conn, client: x.accounts.issueSession(k, "bellteam", "bellteam").session, submit: () => x.call("POST", "/connector/v1/decisions", { token: conn.token, body: decisionBody }) };
  };
  // まだ何も確かめていない（unknown）K: 今までの契約が有効なら通る（409 は確認の札へ進んだ = 関門を通った）。
  const unknownK = x.accounts.createUser(await kOf("apple", "sub-unknown"));
  const u = reach(unknownK);
  assert.equal(x.library.lb.known(unknownK), "unknown");
  assert.equal((await u.submit()).status, 402);
  run(x.db, "update users set plan = 'active', plan_expires_at = '2999-01-01T00:00:00.000Z' where id = ?", unknownK);
  assert.equal((await x.call("GET", "/v1/decisions", { token: u.client })).status, 200);
  assert.equal((await u.submit()).status, 409);
  // 端末の確認で契約なし（none）と分かった K: 今までの契約が有効でも、どちらも402。
  const { pass, k } = await x.signIn("sub-g2");
  x.accounts.createUser(k);
  run(x.db, "update users set plan = 'active', plan_expires_at = '2999-01-01T00:00:00.000Z' where id = ?", k);
  const n = reach(k);
  assert.equal(x.library.lb.known(k), "none");
  assert.equal((await x.call("GET", "/v1/decisions", { token: n.client })).status, 402);
  assert.equal((await x.call("GET", "/v1/me", { token: n.client })).status, 200);
  assert.equal((await n.submit()).status, 402);
});

test("G2: 契約のあるK（active）は、今までの契約が切れていても接続トークンで申請できる", async () => {
  const exempt = await kOf("apple", "sub-active");
  const x = setup({ exempt: [exempt] });
  const { pass } = await x.signIn("sub-active");
  await x.call("GET", "/v1/me", { token: pass });
  const conn = x.accounts.createConnection(exempt, "pc", "linux", ["claude-code"]);
  const res = await x.call("POST", "/connector/v1/decisions", { token: conn.token, body: { title: "t", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], session_label: "s", client: "claude-code" } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "confirm_required");
});

test("onNone: 契約が無いと分かったら、待っている申請（セットアップ確認以外）を subscription_expired で取り下げ、更新の知らせを流す", async () => {
  const x = setup();
  const { pass, k } = await x.signIn("sub-none");
  await x.call("GET", "/v1/me", { token: pass }); // アカウントを作る
  insertDecision(x.db, k, "K-PEND");
  insertDecision(x.db, k, "K-HELD", { status: "held" });
  insertDecision(x.db, k, "K-DONE", { status: "answered" });
  insertDecision(x.db, k, "K-TEST", { test: 1 });
  await x.call("GET", "/v1/me", { token: pass });
  const status = (id: string) => get<{ status: string; cancel_reason: string | null; version: number }>(x.db, "select status, cancel_reason, version from decisions where id = ?", id)!;
  for (const id of ["K-PEND", "K-HELD"]) assert.deepEqual({ ...status(id) }, { status: "cancelled", cancel_reason: "subscription_expired", version: 2 });
  assert.equal(status("K-DONE").status, "answered");
  assert.equal(status("K-TEST").status, "pending");
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from events where user_id = ? and type = 'decision.updated' and data like '%cancelled%'", k)?.n, 2);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from history where kind = 'cancelled' and note = 'subscription_expired'")?.n, 2);
});

test("ライブラリを使う旧い入口: 新しいアカウントのIDは deriveK で、通行証で入っても同じアカウント", async () => {
  const x = setup();
  const nonce = "n-old";
  const old = await x.call("POST", "/v1/auth/apple", { body: { identity_token: idToken("apple", BUNDLE, nonce, "sub-old"), nonce } });
  assert.equal(old.status, 200);
  const k = await kOf("apple", "sub-old");
  assert.equal(old.json.user.id, k);
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from identities where provider = 'apple' and subject = 'sub-old'")?.user_id, k);
  assert.equal((await x.call("GET", "/v1/me", { token: old.json.session })).json.user_id, k); // 旧いsessionも使える
  const { pass } = await x.signIn("sub-old");
  const me = await x.call("GET", "/v1/me", { token: pass });
  assert.equal(me.json.user_id, k);
  assert.equal(me.json.login, "apple");
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from users")?.n, 1);
  // 通行証が先にアカウントを作っていても、旧い入口は同じアカウントに着く。
  const { k: other } = await x.signIn("sub-new-first");
  await x.call("GET", "/v1/me/settings", { token: (await x.signIn("sub-new-first")).pass });
  const again = await x.call("POST", "/v1/auth/apple", { body: { identity_token: idToken("apple", BUNDLE, nonce, "sub-new-first"), nonce } });
  assert.equal(again.json.user.id, other);
});

test("写し: 自分の保存を全部、秘密と他のアカウントを除いて、1つのJSONファイルで返す", async () => {
  const x = setup();
  const { pass, k } = await x.signIn("sub-export");
  await x.call("GET", "/v1/me", { token: pass });
  const conn = x.accounts.createConnection(k, "my-laptop", "linux", ["claude-code"]);
  x.accounts.registerDevice(k, { platform: "ios", apns_token: "APNS-SECRET-TOKEN", apns_env: "production" });
  x.accounts.updateSettings(k, 90);
  insertDecision(x.db, k, "K-MINE", { title: "私の申請", connection_id: conn.id });
  const file = Buffer.from("hello export");
  x.attachments.upload(k, "K-MINE", { name: "memo.txt", contentType: "text/plain", idempotencyKey: "idem-1", data: file });
  // 答え済みにしておく（契約の無い通行証の確認は、待っている申請を取り下げるため）。
  run(x.db, "update decisions set status = 'answered', answer = '{\"text\":\"済\",\"answered_at\":\"2026-11-20T00:00:00.000Z\"}' where id = 'K-MINE'");
  run(x.db, "update attachments set position = 0 where decision_id = 'K-MINE'");
  const started = await x.call("POST", "/connector/v1/setup-test", { token: conn.token, body: { client: "claude-code", session_label: "s" } });
  await x.call("POST", `/v1/decisions/${started.json.decision_id}/answer`, { token: pass, body: { option_id: "ok", text: "届いた", version: 1 } });
  // 別のアカウント
  const other = x.accounts.createUser();
  const otherConn = x.accounts.createConnection(other, "other-pc", null, []);
  insertDecision(x.db, other, "K-OTHER", { title: "他人の申請" });
  x.accounts.registerDevice(other, { platform: "android", fcm_token: "OTHER-FCM" });

  const res = await x.call("GET", "/v1/me/export", { token: pass }); // 契約が無くても取れる
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition")!, /^attachment; filename="approval-box-export-\d{8}\.json"$/);
  assert.match(res.headers.get("content-type")!, /^application\/json/);
  const out = res.json;
  assert.equal(out.account.user_id, k);
  assert.equal(out.account.retention_days, 90);
  assert.equal(out.account.plan, "expired");
  assert.deepEqual(out.decisions.map((d: any) => d.title).sort(), ["Approval Boxの接続テスト", "私の申請"]);
  const answered = out.decisions.find((d: any) => d.title === "Approval Boxの接続テスト");
  assert.equal(answered.answer.text, "届いた");
  assert.ok(answered.history.length >= 2);
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].name, "memo.txt");
  assert.equal(Buffer.from(out.attachments[0].data_base64, "base64").toString(), "hello export");
  assert.equal(out.connections[0].label, "my-laptop");
  assert.deepEqual(out.devices.map((d: any) => d.platform), ["ios"]);
  assert.equal(out.setup_checks.length, 1);
  // 秘密と他人
  for (const secret of [conn.token, hash(conn.token), "APNS-SECRET-TOKEN", "token_hash", "push_key", "apns_token", "OTHER-FCM", other, "他人の申請", otherConn.token, hash(otherConn.token)]) assert.equal(res.text.includes(secret), false, secret);
  // 旧いsessionでも取れる。接続トークン・BellTeamのsession・認証なしは取れない。
  const session = x.accounts.issueSession(k, "old").session;
  assert.equal((await x.call("GET", "/v1/me/export", { token: session })).status, 200);
  assert.equal((await x.call("GET", "/v1/me/export", { token: x.accounts.issueSession(k, "bt", "bellteam").session })).status, 403);
  assert.equal((await x.call("GET", "/v1/me/export", { token: conn.token })).status, 401);
  assert.equal((await x.call("GET", "/v1/me/export")).status, 401);
});
