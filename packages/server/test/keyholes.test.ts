import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Accounts } from "../src/accounts.ts";
import { Attachments } from "../src/attachments.ts";
import { all, get, openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { SqliteKeyholeStore, createAppKeyholes, createEntries } from "../src/keyholes.ts";
import { authenticate } from "../src/pc.ts";
import { joinAs, keysCall, makeDevice, parentAdd, signed, startParent } from "./keyhole-signer.ts";

const ORIGIN = "https://kb.test";

function setup(options: { now?: () => number } = {}) {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const decisions = new Decisions(db, events);
  const attachments = new Attachments(db, mkdtempSync(join(tmpdir(), "ab-keyholes-")));
  const pc = { forgotten: [] as string[], ended: [] as { k: string; passId: string }[] };
  const part = { forgetAccount: (k: string) => { pc.forgotten.push(k); }, onPassEnded: (e: { k: string; passId: string }) => { pc.ended.push(e); }, connectionRemoved: () => {} };
  const entries = createEntries({ db, accounts, attachments, peerChannel: () => part, ...(options.now ? { now: options.now } : {}) });
  const keyholes = createAppKeyholes({ db, origin: ORIGIN, entries });
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, attachments, keyholes, peerChannel: part });
  return { db, accounts, decisions, attachments, entries, keyholes, app, pc };
}

function insertDecision(db: ReturnType<typeof openDb>, userId: string, id: string) {
  run(db, `insert into decisions (id, user_id, title, norm_title, context, options, urgency, client, session_label, via, status, resume_phrase, created_at, updated_at, version)
    values (?, ?, ?, ?, '', '[{"id":"a","label":"A"},{"id":"b","label":"B"}]', 'normal', 'claude-code', 's', 'connector', 'pending', 'r', '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z', 1)`, id, userId, id, id);
}

test("store: write applies all ops or none (deletes first), useOnce is once until expiry, sweep drops expired", () => {
  const db = openDb(":memory:");
  let at = 1_000;
  const store = new SqliteKeyholeStore(db, () => at);
  store.write({ set: [["a", { entry: "E1", role: "parent" }], ["b", { entry: "E1", role: "child" }]], delete: [] });
  assert.deepEqual(store.keys("E1"), [{ key: "a", role: "parent" }, { key: "b", role: "child" }]);
  // A failing set rolls back the delete before it.
  assert.throws(() => store.write({ delete: ["a"], set: [["c", { entry: "E1", role: "owner" as never }]] }));
  assert.deepEqual(store.keyhole("a"), { entry: "E1", role: "parent" });
  assert.equal(store.keyhole("c"), undefined);
  // Deletes first, then sets: the same key in both ends set.
  store.write({ delete: ["a", "b"], set: [["a", { entry: "E2", role: "child" }]] });
  assert.deepEqual(store.keyhole("a"), { entry: "E2", role: "child" });
  assert.equal(store.keyhole("b"), undefined);
  assert.deepEqual(store.keys("E1"), []);

  assert.equal(store.useOnce("n:1", 2_000), true);
  assert.equal(store.useOnce("n:1", 2_000), false);
  at = 2_000; // kept while until >= now
  assert.equal(store.useOnce("n:1", 3_000), false);
  at = 3_001;
  assert.equal(store.useOnce("n:1", 4_000), true); // expired: usable again
  store.useOnce("n:2", 3_500);
  at = 3_600;
  store.sweep();
  assert.deepEqual(all<{ id: string }>(db, "select id from keyhole_used").map((r) => r.id), ["n:1"]);
});

test("/v1/keys/*: reached without auth (library answers), GET is the library's 404, body over 16 KiB is 413, calls per source 429", async () => {
  const x = setup();
  const start = await x.app.request("/v1/keys/start", { method: "POST", body: JSON.stringify({ role: "parent" }), headers: { "content-type": "application/json" } });
  assert.equal(start.status, 401);
  assert.deepEqual(await start.json(), { error: "key_invalid" }); // the library's body, not the /v1 device check's
  const get_ = await x.app.request("/v1/keys/accept");
  assert.equal(get_.status, 404);
  assert.deepEqual(await get_.json(), { error: "not_found" });
  const big = await x.app.request("/v1/keys/accept", { method: "POST", body: "x".repeat(16 * 1024 + 1), headers: { "x-forwarded-for": "1.1.1.1" } });
  assert.equal(big.status, 413);
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push((await x.app.request("/v1/keys/leave", { method: "POST", body: "{}", headers: { "x-forwarded-for": "10.0.0.1, 2.2.2.2" } })).status);
  assert.equal(statuses.filter((s) => s === 401).length, 30);
  assert.equal(statuses[30], 429);
  assert.equal((await x.app.request("/v1/keys/leave", { method: "POST", body: "{}", headers: { "x-forwarded-for": "3.3.3.3" } })).status, 401);
  // The real verify refuses a malformed signed header on /v1 with its own code.
  const me = await x.app.request("/v1/me", { headers: { "login-billing-key": "v1 k=bad" } });
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: "key_invalid" });
});

test("signed request: a started parent runs /v1 as its entry with no paid gate; the body reaches the route; push token keyed by the keyhole", async () => {
  const x = setup();
  const { device, entry } = await startParent(x.app, ORIGIN);
  // The entry's users row is made on its first /v1 request, not on start.
  assert.equal(get(x.db, "select 1 from users where id = ?", entry), undefined);
  assert.equal(((await (await x.app.request("/v1/me", { headers: await signed(device, "GET", "/v1/me") })).json()) as { user_id: string }).user_id, entry);
  assert.ok(get(x.db, "select 1 from users where id = ?", entry));
  insertDecision(x.db, entry, "K-1");
  // The path with query is signed: the server rebuilt it exactly.
  const list = await x.app.request("/v1/decisions?status=pending", { headers: await signed(device, "GET", "/v1/decisions?status=pending") });
  assert.equal(list.status, 200); // billing "store", no contract: the old form would answer 402
  assert.deepEqual(((await list.json()) as { items: { id: string }[] }).items.map((d) => d.id), ["K-1"]);
  assert.ok(get(x.db, "select 1 from entries_seen where entry = ?", entry));
  // The body is signed too, and the route still reads it.
  const body = JSON.stringify({ platform: "android", fcm_token: "fcm-1" });
  const device_ = await x.app.request("/v1/devices", { method: "POST", body, headers: { ...(await signed(device, "POST", "/v1/devices", body)), "content-type": "application/json" } });
  assert.equal(device_.status, 200);
  assert.equal(get<{ keyhole: string }>(x.db, "select keyhole from devices where user_id = ?", entry)?.keyhole, device.publicKey);
  // The connector of an entry is never refused for payment either.
  assert.doesNotThrow(() => x.accounts.assertCanUse(entry));
  // A refused signature answers the library's status and body.
  const bad = await x.app.request("/v1/me", { headers: { "login-billing-key": "nope" } });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: "key_invalid" });
  // Without the header the old path is unchanged: no Bearer is 401 unauthorized.
  assert.equal((await x.app.request("/v1/me")).status, 401);
});

test("signed request: a child accepted with the parent's add joins the entry; replay, time_off and an unknown key are refused", async () => {
  const x = setup();
  const { device: parent, entry } = await startParent(x.app, ORIGIN);
  const child = await joinAs(x.app, ORIGIN, parent);
  assert.deepEqual(all<{ key: string; role: string }>(x.db, "select key, role from keyholes where entry = ? order by role desc", entry).map((r) => ({ ...r })), [{ key: parent.publicKey, role: "parent" }, { key: child.publicKey, role: "child" }]);
  const headers = await signed(child, "GET", "/v1/me");
  const me = await x.app.request("/v1/me", { headers });
  assert.equal(((await me.json()) as { user_id: string }).user_id, entry);
  // The same header again (same nonce) is a replay.
  const replay = await x.app.request("/v1/me", { headers });
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: "key_replayed" });
  // A clock 200 s off is time_off with the server's now, as the library answers it.
  const before = Date.now();
  const off = await x.app.request("/v1/me", { headers: await signed(child, "GET", "/v1/me", "", before - 200_000) });
  assert.equal(off.status, 401);
  const offBody = (await off.json()) as { error: string; now: number };
  assert.equal(offBody.error, "time_off");
  assert.ok(offBody.now >= before && offBody.now <= Date.now());
  // A key in no entry is not signed in.
  const stranger = await makeDevice({ origin: ORIGIN });
  const unknown = await x.app.request("/v1/me", { headers: await signed(stranger, "GET", "/v1/me") });
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: "not_signed_in" });
  // A signature for another origin does not verify.
  const elsewhere = await makeDevice({ origin: "https://evil.test" });
  assert.deepEqual(await (await x.app.request("/v1/me", { headers: await signed(elsewhere, "GET", "/v1/me") })).json(), { error: "key_invalid" });
});

test("/pc/v1 authenticate: a signed request is a device of the entry with endpoint_ref = key; a refusal carries its code", async () => {
  const x = setup();
  const { device, entry } = await startParent(x.app, ORIGIN);
  const auth = authenticate(x.accounts, undefined as never, ORIGIN, x.keyholes);
  const req = (header: string) => ({ method: "GET", url: "/pc/v1/signal", headers: { "login-billing-key": header } }) as unknown as IncomingMessage;
  assert.deepEqual(await auth(req((await signed(device, "GET", "/pc/v1/signal"))["login-billing-key"])), { k: entry, kind: "device", endpoint_ref: device.publicKey, pass_kind: "keyhole" });
  assert.ok(get(x.db, "select 1 from users where id = ?", entry));
  assert.deepEqual(await auth(req("bad")), { refused: "key_invalid" });
});

test("keys: a parent added by another parent joins its whole entry into the signer's; rows move", async () => {
  const x = setup();
  const a = await startParent(x.app, ORIGIN);
  const b = await startParent(x.app, ORIGIN);
  const bChild = await joinAs(x.app, ORIGIN, b.device);
  for (const [device, entry] of [[a.device, a.entry], [b.device, b.entry]] as const) {
    const body = JSON.stringify({ platform: "android", fcm_token: `fcm-${entry}` });
    assert.equal((await x.app.request("/v1/devices", { method: "POST", body, headers: { ...(await signed(device, "POST", "/v1/devices", body)), "content-type": "application/json" } })).status, 200);
  }
  insertDecision(x.db, b.entry, "K-B");
  // A's parent adds B's parent: B's entry (its child too) joins A's.
  const add = await parentAdd(a.device, b.device.publicKey, "parent");
  const res = await keysCall(x.app, b.device, "accept", { add });
  assert.deepEqual(res, { status: 200, json: { entry: a.entry, role: "parent" } });
  assert.deepEqual(all<{ key: string }>(x.db, "select key from keyholes where entry = ? order by key", a.entry).map((r) => r.key), [a.device.publicKey, b.device.publicKey, bChild.publicKey].sort());
  assert.equal(get(x.db, "select 1 from users where id = ?", b.entry), undefined);
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from decisions where id = 'K-B'")?.user_id, a.entry);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from devices where user_id = ?", a.entry)?.n, 2);
  assert.equal(get(x.db, "select 1 from entries_seen where entry = ?", b.entry), undefined);
  assert.deepEqual(x.pc.forgotten, [b.entry]);
  // B's child now reads A's entry.
  assert.equal(((await (await x.app.request("/v1/me", { headers: await signed(bChild, "GET", "/v1/me") })).json()) as { user_id: string }).user_id, a.entry);
  // The same add again is add_used.
  assert.deepEqual(await keysCall(x.app, b.device, "accept", { add }), { status: 409, json: { error: "add_used" } });
});

test("keys: others removes the child's keyhole and its devices row; leave of the last key erases the entry", async () => {
  const x = setup();
  const { device: parent, entry } = await startParent(x.app, ORIGIN);
  const child = await joinAs(x.app, ORIGIN, parent);
  const body = JSON.stringify({ platform: "android", fcm_token: "fcm-child" });
  assert.equal((await x.app.request("/v1/devices", { method: "POST", body, headers: { ...(await signed(child, "POST", "/v1/devices", body)), "content-type": "application/json" } })).status, 200);
  assert.ok(get(x.db, "select 1 from devices where keyhole = ?", child.publicKey));
  // A child may not remove the others.
  assert.deepEqual(await keysCall(x.app, child, "others"), { status: 403, json: { error: "not_parent" } });
  assert.deepEqual(await keysCall(x.app, parent, "others"), { status: 200, json: { removed: 1 } });
  assert.equal(get(x.db, "select 1 from devices where keyhole = ?", child.publicKey), undefined);
  assert.equal(get(x.db, "select 1 from keyholes where key = ?", child.publicKey), undefined);
  assert.deepEqual(x.pc.ended, [{ k: entry, passId: child.publicKey }]);
  assert.deepEqual(await (await x.app.request("/v1/me", { headers: await signed(child, "GET", "/v1/me") })).json(), { error: "not_signed_in" });
  // The parent leaves as the last key: the entry is emptied and erased.
  insertDecision(x.db, entry, "K-LEAVE");
  assert.deepEqual(await keysCall(x.app, parent, "leave"), { status: 200, json: {} });
  for (const [table, column] of [["users", "id"], ["decisions", "user_id"], ["keyholes", "entry"], ["entries_seen", "entry"]]) {
    assert.equal(get(x.db, `select 1 from ${table} where ${column} = ?`, entry), undefined, table);
  }
  assert.deepEqual(x.pc.forgotten, [entry]);
  assert.deepEqual(await (await x.app.request("/v1/me", { headers: await signed(parent, "GET", "/v1/me") })).json(), { error: "not_signed_in" });
});

test("events: removed drops that key's push tokens and closes its endpoint; joined moves every row; emptied erases the entry", () => {
  const x = setup();
  x.accounts.ensureUser("A");
  x.accounts.ensureUser("B");
  x.accounts.registerDevice("A", { platform: "android", fcm_token: "t-a" }, "ka");
  x.accounts.registerDevice("A", { platform: "android", fcm_token: "t-shared" }, "ka2");
  x.accounts.registerDevice("B", { platform: "android", fcm_token: "t-shared" }, "kb");
  x.accounts.registerDevice("B", { platform: "android", fcm_token: "t-b" }, "kb2");
  x.entries.onEvent({ type: "removed", entry: "B", key: "kb2", role: "child" });
  assert.equal(get(x.db, "select 1 from devices where keyhole = 'kb2'"), undefined);
  assert.deepEqual(x.pc.ended, [{ k: "B", passId: "kb2" }]);

  insertDecision(x.db, "A", "K-A");
  const conn = x.accounts.createConnection("A", "pc", "linux", ["codex"]);
  run(x.db, "insert into k_moved (k, entry, at) values ('K-old', 'A', 'now')");
  x.entries.seen("A");
  x.entries.onEvent({ type: "joined", from: "A", into: "B" });
  assert.equal(get(x.db, "select 1 from users where id = 'A'"), undefined);
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from decisions where id = 'K-A'")?.user_id, "B");
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from connections where id = ?", conn.id)?.user_id, "B");
  assert.deepEqual(all<{ keyhole: string }>(x.db, "select keyhole from devices where user_id = 'B' order by keyhole").map((r) => r.keyhole), ["ka", "kb"]); // the colliding token keeps B's row
  assert.equal(get<{ entry: string }>(x.db, "select entry from k_moved where k = 'K-old'")?.entry, "B");
  assert.ok(get(x.db, "select 1 from entries_seen where entry = 'B'"));
  assert.equal(get(x.db, "select 1 from entries_seen where entry = 'A'"), undefined);
  assert.deepEqual(x.pc.forgotten, ["A"]);

  const file = join((x.attachments as unknown as { dir: string }).dir, "att-1");
  writeFileSync(file, "x");
  run(x.db, "insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, created_at) values ('att-1', 'B', 'K-A', 'a.png', 'image/png', 'image', 1, 'h', 'now')");
  run(x.db, "insert into keyholes (key, entry, role) values ('left', 'B', 'child')");
  x.entries.onEvent({ type: "emptied", entry: "B" });
  for (const [table, column] of [["users", "id"], ["decisions", "user_id"], ["connections", "user_id"], ["devices", "user_id"], ["attachments", "user_id"], ["keyholes", "entry"], ["entries_seen", "entry"], ["k_moved", "entry"]]) {
    assert.equal(get(x.db, `select 1 from ${table} where ${column} = 'B'`), undefined, table);
  }
  assert.equal(existsSync(file), false);
  assert.deepEqual(x.pc.forgotten, ["A", "B"]);
});

test("events: a failing handler is logged as one code line and not thrown", () => {
  const x = setup();
  x.db.close();
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try {
    assert.doesNotThrow(() => x.entries.onEvent({ type: "emptied", entry: "Z" }));
  } finally { console.error = original; }
  assert.deepEqual(lines, ["approval-box-server: keyhole_event_failed emptied"]);
});

test("retention: entries unused for 90 days are erased with their keyholes; recent ones stay", () => {
  let at = Date.parse("2026-11-24T00:00:00Z");
  const x = setup({ now: () => at });
  for (const e of ["OLD", "NEW"]) { x.entries.signedIn(e); insertDecision(x.db, e, `K-${e}`); run(x.db, "insert into keyholes (key, entry, role) values (?, ?, 'parent')", `k-${e}`, e); }
  at += 60 * 86400_000;
  x.entries.signedIn("NEW");
  at += 31 * 86400_000;
  assert.equal(x.entries.sweep(), 1);
  assert.equal(get(x.db, "select 1 from users where id = 'OLD'"), undefined);
  assert.equal(get(x.db, "select 1 from keyholes where entry = 'OLD'"), undefined);
  assert.ok(get(x.db, "select 1 from decisions where id = 'K-NEW'"));
  assert.ok(get(x.db, "select 1 from keyholes where entry = 'NEW'"));
  assert.deepEqual(x.pc.forgotten, ["OLD"]);
});
