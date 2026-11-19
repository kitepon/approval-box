import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { openDb, all } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { Accounts } from "../src/accounts.ts";
import { Decisions } from "../src/decisions.ts";
import { Apns, Fcm, Notifier } from "../src/push.ts";

test("申請が来たら件名で鳴らし、取り下げは音なし。無効なtokenの端末は消す", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const decisions = new Decisions(db, events);
  const userId = accounts.createUser();
  accounts.registerDevice(userId, { platform: "ios", apns_token: "good", apns_env: "sandbox" });
  accounts.registerDevice(userId, { platform: "ios", apns_token: "gone", apns_env: "production" });
  const sent: { env: string; token: string; headers: Record<string, string>; payload: any }[] = [];
  new Notifier(db, events, { apns: async (env, token, headers, payload) => {
    sent.push({ env, token, headers, payload });
    return token === "gone" ? { status: 410, reason: "Unregistered" } : { status: 200 };
  } });
  const conn = accounts.createConnection(userId, "pc", "linux", ["claude-code"]);
  const me = { id: conn.id, user_id: userId, label: "pc", os: "linux" };
  const input = { title: "デプロイしてよいか", context: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], urgency: "normal" as const, session_label: "Approval Box / 配備", requester: "ナユタ", client: "claude-code" };
  let check_token = "";
  try { decisions.create(me, input); } catch (error) { check_token = (error as { extra: { check_token: string } }).extra.check_token; }
  const created = decisions.create(me, { ...input, check_token });
  await new Promise((r) => setTimeout(r, 20));
  const loud = sent.find((s) => s.token === "good")!;
  assert.equal(loud.env, "sandbox");
  assert.equal(loud.headers["apns-push-type"], "alert");
  // 件名の下に「誰から / 何の仕事」を出す。
  assert.deepEqual(loud.payload.aps, { alert: { title: "デプロイしてよいか", subtitle: "ナユタ / Approval Box / 配備" }, sound: "default", badge: 1 });
  assert.equal(loud.payload.decision_id, created.id);
  // 申請者を送らない古いコネクタの申請は、作業名だけを出す。
  sent.length = 0;
  const { requester: _requester, ...old } = input;
  try { decisions.create(me, { ...old, title: "別の件" }); } catch (error) { check_token = (error as { extra: { check_token: string } }).extra.check_token; }
  const second = decisions.create(me, { ...old, title: "別の件", check_token });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent[0]!.payload.aps.alert, { title: "別の件", subtitle: "Approval Box / 配備" });
  // 直した時の通知にも付く。
  sent.length = 0;
  decisions.amend(me, second.id, { version: 1, note: "件名を直した", changes: { title: "別の件（直し）" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent[0]!.payload.aps.alert, { title: "修正: 別の件（直し）", subtitle: "Approval Box / 配備" });
  decisions.cancel(me, second.id, "試験の片付け");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(all(db, "select * from devices").length, 1); // 410 の端末は消えた
  sent.length = 0;
  decisions.cancel({ id: conn.id, user_id: userId, label: "pc", os: "linux" }, created.id, "やめた");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent[0]!.payload.aps, { "content-available": 1, badge: 0 });
  assert.equal(sent[0]!.headers["apns-push-type"], "alert");
  assert.equal(sent[0]!.payload.change, "cancelled");
});

test("APNsの認証tokenはES256でチームとkidを持つ", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const apns = new Apns({ keyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), keyId: "KID123", teamId: "TPWX489GV4", topic: "dev.kitepon.approvalbox" });
  const jwt = (apns as unknown as { token(): string }).token();
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "ES256", kid: "KID123" });
  assert.equal(JSON.parse(Buffer.from(c!, "base64url").toString()).iss, "TPWX489GV4");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));
});

test("Androidにはデータだけで送り、鳴らす時はhigh・音なしはnormal。UNREGISTEREDの端末は消す", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const decisions = new Decisions(db, events);
  const userId = accounts.createUser();
  accounts.registerDevice(userId, { platform: "android", fcm_token: "a-good" });
  accounts.registerDevice(userId, { platform: "android", fcm_token: "a-gone" });
  accounts.registerDevice(userId, { platform: "ios", apns_token: "ios-1", apns_env: "production" });
  const sent: { token: string; data: Record<string, string>; priority: string }[] = [];
  // APNs が無いサーバーでは、iPhone の端末へは送らない。
  new Notifier(db, events, { fcm: async (token, data, priority) => {
    sent.push({ token, data, priority });
    return token === "a-gone" ? { status: 404, reason: "UNREGISTERED" } : { status: 200 };
  } });
  const conn = accounts.createConnection(userId, "pc", "linux", ["claude-code"]);
  const me = { id: conn.id, user_id: userId, label: "pc", os: "linux" };
  const input = { title: "配備してよいか", context: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], urgency: "normal" as const, session_label: "Approval Box / 配備", requester: "ナユタ", client: "claude-code" };
  let check_token = "";
  try { decisions.create(me, input); } catch (error) { check_token = (error as { extra: { check_token: string } }).extra.check_token; }
  const created = decisions.create(me, { ...input, check_token });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((s) => s.token).sort(), ["a-gone", "a-good"]);
  const loud = sent.find((s) => s.token === "a-good")!;
  assert.equal(loud.priority, "high");
  assert.deepEqual(loud.data, { type: "decision.created", decision_id: created.id, version: "1", badge: "1", title: "配備してよいか" });
  assert.equal(all(db, "select * from devices where platform = 'android'").length, 1);
  sent.length = 0;
  decisions.cancel(me, created.id, "やめた");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0]!.priority, "normal");
  assert.deepEqual(sent[0]!.data, { type: "decision.updated", change: "cancelled", decision_id: created.id, version: String(sent[0]!.data.version), badge: "0" });
});

test("FCMはサービスアカウントのtokenでv1 APIへ送り、Googleの errorCode を返す", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.fcm", expires_in: 3600 }));
    return new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
  }) as unknown as typeof fetch;
  const fcm = new Fcm({ projectId: "approval-box", serviceAccount: { client_email: "s@x.iam.gserviceaccount.com", private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }, fetch: fake });
  assert.deepEqual(await fcm.send("tok", { type: "decision.created" }, "high"), { status: 404, reason: "UNREGISTERED" });
  const claims = JSON.parse(Buffer.from(String(new URLSearchParams(String(calls[0]!.init.body)).get("assertion")).split(".")[1]!, "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(calls[1]!.url, "https://fcm.googleapis.com/v1/projects/approval-box/messages:send");
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer ya29.fcm");
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { message: { token: "tok", data: { type: "decision.created" }, android: { priority: "high" } } });
});
