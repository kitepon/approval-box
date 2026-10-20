import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

function setup() {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test" });
  return { db, accounts, app };
}

test("pairingを含む業務経路や未知の経路も接続トークンを必須とする", async (t) => {
  const { db, app } = setup();
  t.after(() => db.close());
  const paths = [
    ["GET", "/decisions/pairing"],
    ["GET", "/decisions/pairing-example"],
    ["GET", "/decisions/%70airing"],
    ["GET", "/decisions/K-ABC234/attachments/pairing"],
    ["POST", "/decisions/pairing/fetched"],
    ["POST", "/decisions/pairing/resume"],
    ["POST", "/decisions/pairing/amend"],
    ["POST", "/decisions/pairing/cancel"],
    ["POST", "/deliveries/pairing"],
    ["GET", "/pairing-extra"],
    ["GET", "/pairing/id/extra"],
    ["POST", "/pairing/id"],
    ["GET", "/pairing"],
    ["GET", "/connection?next=/pairing"],
  ];
  for (const [method, path] of paths) {
    for (const token of [undefined, "invalid-token"]) {
      const response = await app.request(`/connector/v1${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      assert.equal(response.status, 401, `${method} ${path}, token=${token ?? "missing"}`);
      assert.equal((await response.json()).error.code, "unauthorized");
    }
  }
});

test("公開ペアリングは接続トークンなしで動き、受取りにはpoll secretが必要", async (t) => {
  const { db, accounts, app } = setup();
  t.after(() => db.close());
  const start = await app.request("/connector/v1/pairing", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_name: "isolated-test", clients: ["codex"] }),
  });
  assert.equal(start.status, 200);
  const pairing = await start.json();
  const userId = accounts.createUser();
  accounts.claimPairing(userId, pairing.pairing_id);
  const path = `/connector/v1/pairing/${pairing.pairing_id}`;
  assert.equal((await app.request(path)).status, 404);
  assert.equal((await app.request(path, { headers: { "x-poll-secret": "wrong" } })).status, 404);
  const poll = await app.request(path, { headers: { "x-poll-secret": pairing.poll_secret } });
  assert.equal(poll.status, 200);
  const claimed = await poll.json();
  assert.equal(claimed.status, "claimed");
  assert.equal(accounts.connectionByToken(claimed.token).user_id, userId);
  const again = await app.request(path, { headers: { "x-poll-secret": pairing.poll_secret } });
  assert.deepEqual(await again.json(), { status: "delivered" });
});

test("正規接続トークンは業務経路へ進み、存在しない申請は404を返す", async (t) => {
  const { db, accounts, app } = setup();
  t.after(() => db.close());
  const userId = accounts.createUser();
  const { token } = accounts.createConnection(userId, "test", "linux", ["codex"]);
  const headers = { authorization: `Bearer ${token}` };
  const connection = await app.request("/connector/v1/connection", { headers });
  assert.equal(connection.status, 200);
  const decisions = await app.request("/connector/v1/decisions", { headers });
  assert.deepEqual(await decisions.json(), { items: [] });
  const missing = await app.request("/connector/v1/decisions/pairing", { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
});
