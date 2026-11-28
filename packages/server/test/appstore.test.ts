import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { AppStore } from "../src/appstore.ts";
import { openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { keySigner } from "../src/auth-module.ts";

/** Appleと同じ形の証明書の鎖（ルート → 中間 → 署名）を作る。中間と署名にはAppleの印（OID）を付ける。 */
function appleLikeChain() {
  const dir = mkdtempSync(join(tmpdir(), "ab-appstore-"));
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ext = (name: string, body: string) => writeFileSync(join(dir, name), body);
  for (const k of ["root", "inter", "leaf"]) ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${k}.key`);
  ssl("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "2", "-out", "root.pem",
    "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ext("inter.ext", "basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=ASN1:NULL\n");
  ssl("req", "-new", "-key", "inter.key", "-subj", "/CN=Test Intermediate", "-out", "inter.csr");
  ssl("x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "2", "-extfile", "inter.ext", "-out", "inter.pem");
  ext("leaf.ext", "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=ASN1:NULL\n");
  ssl("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test Leaf", "-out", "leaf.csr");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const der = (pem: string) => ssl("x509", "-in", pem, "-outform", "der");
  const leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
  const x5c = ["leaf.pem", "inter.pem", "root.pem"].map((f) => der(f).toString("base64"));
  const sign = (payload: Record<string, unknown>) => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${enc({ alg: "ES256", x5c })}.${enc(payload)}`;
    const signature = createSign("SHA256").update(input).sign({ key: leafKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  };
  return { root: der("root.pem"), sign };
}

const PRODUCT = "dev.kitepon.approvalbox.monthly";
const BUNDLE = "dev.kitepon.approvalbox";

/** App Store Server API の代役。answer を書き換えると、次の問い合わせからその状態を返す。 */
function fakeAppleApi(sign: (payload: Record<string, unknown>) => string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const calls: { url: string; authorization: string }[] = [];
  const answer: { http: number; status: number; transaction: Record<string, unknown>; renewal?: Record<string, unknown> } = { http: 200, status: 1, transaction: {} };
  const fetch = (async (url: string, init: { headers: { authorization: string } }) => {
    calls.push({ url, authorization: init.headers.authorization });
    if (answer.http !== 200) return new Response("{}", { status: answer.http });
    const item = { status: answer.status, originalTransactionId: "1000000001", signedTransactionInfo: sign(answer.transaction),
      ...(answer.renewal ? { signedRenewalInfo: sign({ environment: "Sandbox", signedDate: Date.now(), ...answer.renewal }) } : {}) };
    return Response.json({ environment: "Sandbox", bundleId: BUNDLE, appAppleId: 6818175213, data: [{ subscriptionGroupIdentifier: "g1", lastTransactions: [item] }] });
  }) as unknown as typeof globalThis.fetch;
  return { calls, answer, publicKey, api: { issuerId: "issuer-1", keyId: "KEY1", sign: keySigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "ES256"), fetch } };
}

function setup(withApi = false) {
  const chain = appleLikeChain();
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const decisions = new Decisions(db, events);
  const apple = fakeAppleApi(chain.sign);
  const appStore = new AppStore(db, accounts, { bundleId: BUNDLE, appAppleId: 6818175213, productIds: [PRODUCT], rootCertificates: [chain.root], onlineChecks: false, ...(withApi ? { api: apple.api } : {}) });
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test", appStore });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, body?: unknown, token: string | null = session) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() as any };
  };
  const transaction = (fields: Record<string, unknown> = {}) => ({
    transactionId: randomUUID(), originalTransactionId: "1000000001", bundleId: BUNDLE, productId: PRODUCT, type: "Auto-Renewable Subscription",
    purchaseDate: Date.now(), expiresDate: Date.now() + 30 * 86400_000, appAccountToken: userId, environment: "Sandbox", signedDate: Date.now(), ...fields,
  });
  return { ...chain, db, accounts, userId, call, transaction, apple };
}

test("App Store: Sandboxの購入は確認前でも受け付け、署名を確かめて契約中にする", async () => {
  const t = setup();
  const res = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction()) });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.plan, "active");
  assert.equal(res.json.store, "app_store");
  assert.ok(res.json.expires_at > new Date().toISOString());
});

test("App Store: 本番の購入はセットアップ確認の後だけ。署名の違う取引・他人の取引・知らない商品は断る", async () => {
  const t = setup();
  const prod = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ environment: "Production", appAppleId: 6818175213 })) });
  assert.equal(prod.json.error.code, "setup_not_verified");

  const forged = t.sign(t.transaction()).split(".");
  const tampered = `${forged[0]}.${Buffer.from(JSON.stringify({ ...t.transaction(), expiresDate: Date.now() + 9e12 })).toString("base64url")}.${forged[2]}`;
  assert.equal((await t.call("POST", "/v1/billing/appstore/verify", { jws: tampered })).json.error.code, "validation_failed");

  const other = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ appAccountToken: randomUUID() })) });
  assert.equal(other.json.error.code, "conflict");
  const product = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ productId: "other" })) });
  assert.equal(product.json.error.code, "validation_failed");
  const xcode = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ environment: "Xcode" })) });
  assert.equal(xcode.json.error.code, "validation_failed");
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
});

test("App Store: 通知で更新・返金を反映し、古い通知で期限を巻き戻さない。期限を過ぎれば切れる", async () => {
  const t = setup();
  const first = t.transaction({ expiresDate: Date.now() + 60_000 });
  await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(first) });
  const notify = (tx: Record<string, unknown>) => t.call("POST", "/v1/appstore/notifications", {
    signedPayload: t.sign({ notificationType: "DID_RENEW", notificationUUID: randomUUID(), version: "2.0", signedDate: Date.now(),
      data: { environment: "Sandbox", bundleId: BUNDLE, appAppleId: 6818175213, signedTransactionInfo: t.sign(tx) } }),
  }, null);

  const renewed = t.transaction({ expiresDate: Date.now() + 30 * 86400_000 });
  assert.equal((await notify(renewed)).json.applied, true);
  const later = (await t.call("GET", "/v1/me")).json.expires_at;
  await notify(first); // 遅れて届いた古い通知
  assert.equal((await t.call("GET", "/v1/me")).json.expires_at, later);

  await notify(t.transaction({ revocationDate: Date.now(), revocationReason: 0 }));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");

  // 期限切れの判定（通知が来ない時）
  t.accounts.setPlan(t.userId, "active", new Date(Date.now() - 1000).toISOString(), "app_store");
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
});

test("App Store: Appleのルートにつながらない鎖で署名した取引は断る", async () => {
  const t = setup();
  const stranger = appleLikeChain();
  const res = await t.call("POST", "/v1/billing/appstore/verify", { jws: stranger.sign(t.transaction()) });
  assert.equal(res.json.error.code, "validation_failed");
});

const DAY = 86400_000;
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail("条件が満たされませんでした"); };

test("App Store Server API: verifyと通知は、本文でなくAppleの答えで決める。JWTの形も確かめる", async () => {
  const t = setup(true);
  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() + 30 * DAY });
  const appleEnds = new Date(t.apple.answer.transaction.expiresDate as number).toISOString();
  const verified = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ expiresDate: Date.now() + 900 * DAY })) });
  assert.equal(verified.json.expires_at, appleEnds); // アプリの申告ではなくAppleの値

  const [call] = t.apple.calls;
  assert.equal(call.url, "https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/1000000001");
  const [head, claims, sig] = call.authorization.replace("Bearer ", "").split(".");
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(json(head), { alg: "ES256", kid: "KEY1", typ: "JWT" });
  assert.deepEqual({ ...json(claims), iat: 0, exp: json(claims).exp - json(claims).iat }, { iss: "issuer-1", iat: 0, exp: 300, aud: "appstoreconnect-v1", bid: BUNDLE });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: t.apple.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));

  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() + 60 * DAY });
  const renewedEnds = new Date(t.apple.answer.transaction.expiresDate as number).toISOString();
  const notify = (body: Record<string, unknown>) => t.call("POST", "/v1/appstore/notifications", {
    signedPayload: t.sign({ notificationType: "DID_RENEW", notificationUUID: randomUUID(), version: "2.0", signedDate: Date.now(),
      data: { environment: "Sandbox", bundleId: BUNDLE, appAppleId: 6818175213, signedTransactionInfo: t.sign(body) } }),
  }, null);
  assert.equal((await notify(t.transaction({ expiresDate: Date.now() + 3000 * DAY }))).json.applied, true);
  assert.equal((await t.call("GET", "/v1/me")).json.expires_at, renewedEnds);

  t.apple.answer.http = 500; // Appleに届かない時は、黙って本文を使わず500で返す（Appleが再送する）
  assert.equal((await notify(t.transaction())).status, 500);
  assert.equal((await t.call("GET", "/v1/me")).json.expires_at, renewedEnds);
  t.apple.answer.http = 404;
  assert.equal((await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction()) })).json.error.code, "validation_failed");
});

test("App Store Server API: 課金の猶予期間は猶予の期限まで払い済み。再試行・期限切れは未払い。取り消しは切れる", async () => {
  const t = setup(true);
  const verify = () => t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction()) });
  const graceEnds = Date.now() + 2 * DAY;
  t.apple.answer.status = 4;
  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() - DAY });
  t.apple.answer.renewal = { gracePeriodExpiresDate: graceEnds };
  const grace = await verify();
  assert.equal(grace.json.plan, "active");
  assert.equal(grace.json.expires_at, new Date(graceEnds).toISOString());

  t.apple.answer.status = 3; // 猶予も終わり、課金の再試行
  assert.equal((await verify()).json.plan, "expired");
  t.apple.answer.status = 1;
  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() + DAY });
  assert.equal((await verify()).json.plan, "active");
  t.apple.answer.status = 5;
  assert.equal((await verify()).json.plan, "expired");
  t.apple.answer.status = 1;
  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() + DAY, revocationDate: Date.now() });
  assert.equal((await verify()).json.plan, "expired");
});

test("App Store Server API: 更新の通知を取りこぼしても、期限切れを見た時にAppleから読み直して戻る。同じ購入は10分に1回まで", async () => {
  const t = setup(true);
  // 通知が来ないまま期限が過ぎた記録（Appleには更新済み）。
  run(t.db, "insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, revoked, updated_at) values (?, ?, 'Sandbox', ?, ?, 0, ?)",
    "1000000001", t.userId, PRODUCT, new Date(Date.now() - DAY).toISOString(), new Date().toISOString());
  t.accounts.setPlan(t.userId, "active", new Date(Date.now() - DAY).toISOString(), "app_store");
  t.apple.answer.transaction = t.transaction({ expiresDate: Date.now() + 30 * DAY });

  assert.throws(() => t.accounts.assertCanUse(t.userId), { code: "subscription_expired" }); // この呼び出しは待たない
  await until(async () => (await t.call("GET", "/v1/me")).json.plan === "active");
  t.accounts.assertCanUse(t.userId);
  assert.equal(t.apple.calls.length, 1);

  t.accounts.setPlan(t.userId, "expired", new Date(Date.now() - DAY).toISOString(), "app_store");
  await t.call("GET", "/v1/me");
  assert.throws(() => t.accounts.assertCanUse(t.userId), { code: "subscription_expired" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.apple.calls.length, 1); // 10分以内なのでAppleへ聞かない
});

test("App Store Server API: 鍵が無ければ従来どおり、署名付きの取引の値で決めてAppleへ聞かない", async () => {
  const t = setup();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Appleへ問い合わせてはいけない"); }) as typeof fetch;
  try {
    const ends = Date.now() + 90 * DAY;
    const res = await t.call("POST", "/v1/billing/appstore/verify", { jws: t.sign(t.transaction({ expiresDate: ends })) });
    assert.equal(res.json.expires_at, new Date(ends).toISOString());
    t.accounts.setPlan(t.userId, "active", new Date(Date.now() - 1000).toISOString(), "app_store");
    assert.throws(() => t.accounts.assertCanUse(t.userId), { code: "subscription_expired" });
    await new Promise((r) => setTimeout(r, 20));
  } finally { globalThis.fetch = original; }
});
