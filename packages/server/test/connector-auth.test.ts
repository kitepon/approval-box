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

test("sessionと接続tokenを区別し、未知APIへstatic HTMLを返さない", async t => {
  const { db, accounts } = setup();
  t.after(() => db.close());
  const events = new EventHub(db);
  const app = createApp({ db, accounts, events, decisions: new Decisions(db, events), publicUrl: "https://kb.test" },
    { staticHandler: c => c.html("<main>app</main>") });
  const user = accounts.createUser();
  const { session } = accounts.issueSession(user, "test");
  const { token } = accounts.createConnection(user, "test", "linux", ["codex"]);
  for (const [path, bearer, status] of [
    ["/v1/me", token, 401], ["/connector/v1/connection", session, 401],
    ["/v1/unknown", session, 404], ["/connector/v1/unknown", token, 404],
    ["/v1/unknown", "", 401], ["/connector/v1/unknown", "", 401],
  ] as const) {
    const res = await app.request(path, { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(res.status, status, path);
    assert.match(res.headers.get("content-type")!, /application\/json/);
  }
  assert.equal((await app.request("/v1/auth/config")).status, 200);
  for (const method of ["GET", "DELETE"]) {
    const res = await app.request("/mcp", { method });
    assert.equal(res.status, 405); assert.equal(res.headers.get("allow"), "POST");
  }
  assert.match(await (await app.request("/web-route")).text(), /<main>app<\/main>/);
});

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
