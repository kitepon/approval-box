import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { AppStore } from "../src/appstore.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

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

function setup() {
  const chain = appleLikeChain();
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const decisions = new Decisions(db, events);
  const appStore = new AppStore(db, accounts, { bundleId: BUNDLE, appAppleId: 6818175213, productIds: [PRODUCT], rootCertificates: [chain.root], onlineChecks: false });
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
  return { ...chain, accounts, userId, call, transaction };
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
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "trial");
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
