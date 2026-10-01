import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { openDb, all } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { Accounts } from "../src/accounts.ts";
import { Decisions } from "../src/decisions.ts";
import { Apns, Notifier } from "../src/push.ts";

test("申請が来たら件名で鳴らし、取り下げは音なし。無効なtokenの端末は消す", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const decisions = new Decisions(db, events);
  const userId = accounts.createUser();
  accounts.registerDevice(userId, { platform: "ios", apns_token: "good", apns_env: "sandbox" });
  accounts.registerDevice(userId, { platform: "ios", apns_token: "gone", apns_env: "production" });
  const sent: { env: string; token: string; headers: Record<string, string>; payload: any }[] = [];
  new Notifier(db, events, async (env, token, headers, payload) => {
    sent.push({ env, token, headers, payload });
    return token === "gone" ? { status: 410, reason: "Unregistered" } : { status: 200 };
  });
  const conn = accounts.createConnection(userId, "pc", "linux", ["claude-code"]);
  const created = decisions.create({ id: conn.id, user_id: userId, label: "pc", os: "linux" }, { title: "デプロイしてよいか", context: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], urgency: "normal", session_label: "s", client: "claude-code" });
  await new Promise((r) => setTimeout(r, 20));
  const loud = sent.find((s) => s.token === "good")!;
  assert.equal(loud.env, "sandbox");
  assert.equal(loud.headers["apns-push-type"], "alert");
  assert.deepEqual(loud.payload.aps, { alert: { title: "デプロイしてよいか" }, sound: "default", badge: 1 });
  assert.equal(loud.payload.decision_id, created.id);
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
