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
  const pc = { forgotten: [] as string[], ended: [] as { k: string; passId: string }[], moved: [] as [string, string][] };
  const part = { forgetAccount: (k: string) => { pc.forgotten.push(k); }, onPassEnded: (e: { k: string; passId: string }) => { pc.ended.push(e); }, moveAccount: (from: string, into: string) => { pc.moved.push([from, into]); }, connectionRemoved: () => {} };
  const entries = createEntries({ db, accounts, attachments, peerChannel: () => part, ...(options.now ? { now: options.now } : {}) });
  const keyholes = createAppKeyholes({ db, origin: ORIGIN, entries });
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, attachments, keyholes, peerChannel: part });
  return { db, events, accounts, decisions, attachments, entries, keyholes, app, pc };
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

test("/pc/v1 authenticate: a signed request is a device of the entry with endpoint_ref = key; a child may not approve a connector; a refusal carries the library's status and body", async () => {
  const x = setup();
  const { device, entry } = await startParent(x.app, ORIGIN);
  const auth = authenticate(x.accounts, undefined as never, ORIGIN, x.keyholes);
  const req = (header: string) => ({ method: "GET", url: "/pc/v1/signal", headers: { "login-billing-key": header } }) as unknown as IncomingMessage;
  assert.deepEqual(await auth(req((await signed(device, "GET", "/pc/v1/signal"))["login-billing-key"])), { k: entry, kind: "device", endpoint_ref: device.publicKey, pass_kind: "keyhole" });
  assert.ok(get(x.db, "select 1 from users where id = ?", entry));
  const child = await joinAs(x.app, ORIGIN, device, "child");
  assert.deepEqual(await auth(req((await signed(child, "GET", "/pc/v1/signal"))["login-billing-key"])),
    { k: entry, kind: "device", endpoint_ref: child.publicKey, pass_kind: "keyhole", binding_refused: "parent_required" });
  assert.deepEqual(await auth(req("bad")), { refused: "key_invalid", status: 401, body: { error: "key_invalid" } });
  // A wrong clock: 401 time_off with the server's now, so the device signs again once with it (peer-channel 0.6.0 carries status and body).
  const late = await auth(req((await signed(device, "GET", "/pc/v1/signal", "", Date.now() - 10 * 60_000))["login-billing-key"])) as { refused: string; status: number; body: { error: string; now: number } };
  assert.deepEqual([late.refused, late.status, late.body.error, typeof late.body.now], ["time_off", 401, "time_off", "number"]);
  assert.ok(Math.abs(late.body.now - Date.now()) < 60_000);
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
  assert.deepEqual(x.pc.moved, [[b.entry, a.entry]]); // the mirror moves (no slot dropped); B's sockets reconnect as A
  assert.deepEqual(x.pc.forgotten, []);
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
  x.entries.seen("A");
  x.entries.onEvent({ type: "joined", from: "A", into: "B" });
  assert.equal(get(x.db, "select 1 from users where id = 'A'"), undefined);
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from decisions where id = 'K-A'")?.user_id, "B");
  assert.equal(get<{ user_id: string }>(x.db, "select user_id from connections where id = ?", conn.id)?.user_id, "B");
  assert.deepEqual(all<{ keyhole: string }>(x.db, "select keyhole from devices where user_id = 'B' order by keyhole").map((r) => r.keyhole), ["ka", "kb"]); // the colliding token keeps B's row
  assert.ok(get(x.db, "select 1 from entries_seen where entry = 'B'"));
  assert.equal(get(x.db, "select 1 from entries_seen where entry = 'A'"), undefined);
  assert.deepEqual(x.pc.moved, [["A", "B"]]);
  assert.deepEqual(x.pc.forgotten, []);

  const file = join((x.attachments as unknown as { dir: string }).dir, "att-1");
  writeFileSync(file, "x");
  run(x.db, "insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, created_at) values ('att-1', 'B', 'K-A', 'a.png', 'image/png', 'image', 1, 'h', 'now')");
  run(x.db, "insert into keyholes (key, entry, role) values ('left', 'B', 'child')");
  x.entries.onEvent({ type: "emptied", entry: "B" });
  for (const [table, column] of [["users", "id"], ["decisions", "user_id"], ["connections", "user_id"], ["devices", "user_id"], ["attachments", "user_id"], ["entries_seen", "entry"]]) {
    assert.equal(get(x.db, `select 1 from ${table} where ${column} = 'B'`), undefined, table);
  }
  assert.equal(existsSync(file), false);
  assert.ok(get(x.db, "select 1 from keyholes where key = 'left'")); // keyholes are the library's: never written by the product
  assert.deepEqual(x.pc.forgotten, ["B"]);
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

test("retention: the content of entries unused for 90 days is erased, never their keyholes; recent ones stay", () => {
  let at = Date.parse("2026-11-24T00:00:00Z");
  const x = setup({ now: () => at });
  for (const e of ["OLD", "NEW"]) { x.entries.signedIn(e); insertDecision(x.db, e, `K-${e}`); run(x.db, "insert into keyholes (key, entry, role) values (?, ?, 'parent')", `k-${e}`, e); }
  at += 60 * 86400_000;
  x.entries.signedIn("NEW");
  at += 31 * 86400_000;
  assert.equal(x.entries.sweep(), 1);
  assert.equal(get(x.db, "select 1 from users where id = 'OLD'"), undefined);
  assert.ok(get(x.db, "select 1 from keyholes where entry = 'OLD'"));
  assert.ok(get(x.db, "select 1 from decisions where id = 'K-NEW'"));
  assert.ok(get(x.db, "select 1 from keyholes where entry = 'NEW'"));
  assert.deepEqual(x.pc.forgotten, ["OLD"]);
});

test("review fixes: a signed /me has no payment fields; a signed DELETE /me is 409 and erases nothing; k_moved is gone", async () => {
  const x = setup();
  let expired = 0;
  x.accounts.onExpired = () => { expired++; };
  const { device, entry } = await startParent(x.app, ORIGIN);
  const me = (await (await x.app.request("/v1/me", { headers: await signed(device, "GET", "/v1/me") })).json()) as Record<string, unknown>;
  assert.equal(me.user_id, entry);
  for (const field of ["plan", "store", "expires_at"]) assert.equal(field in me, false, field);
  assert.equal(expired, 0);
  insertDecision(x.db, entry, "K-1");
  const del = await x.app.request("/v1/me", { method: "DELETE", headers: await signed(device, "DELETE", "/v1/me") });
  assert.equal(del.status, 409);
  assert.ok(get(x.db, "select 1 from decisions where id = 'K-1'"));
  assert.ok(get(x.db, "select 1 from keyholes where entry = ?", entry));
  assert.equal(get(x.db, "select 1 from sqlite_master where name = 'k_moved'"), undefined);
  assert.equal(get<{ user_version: number }>(x.db, "pragma user_version")?.user_version, 18);
});

test("review fixes: calls per source and the 16 KiB cap come before verify on signed /v1 (the upload keeps its file cap) and /pc/v1", async () => {
  const x = setup();
  const { device } = await startParent(x.app, ORIGIN);
  const used = () => get<{ n: number }>(x.db, "select count(*) n from keyhole_used")!.n;
  const before = used();
  const body = "x".repeat(16 * 1024 + 1);
  const big = await x.app.request("/v1/devices", { method: "POST", body, headers: { ...(await signed(device, "POST", "/v1/devices", body)), "x-forwarded-for": "4.4.4.4" } });
  assert.equal(big.status, 413);
  assert.equal(used(), before); // verify never ran
  const path = "/v1/decisions/K-none/attachments?name=a.png";
  const upload = await x.app.request(path, { method: "POST", body, headers: { ...(await signed(device, "POST", path, body)), "x-forwarded-for": "4.4.4.4", "idempotency-key": "i1", "content-type": "image/png" } });
  assert.notEqual(upload.status, 413);
  assert.equal(used(), before + 1);
  for (let i = 0; i < 240; i++) assert.equal((await x.app.request("/v1/me", { headers: { ...(await signed(device, "GET", "/v1/me")), "x-forwarded-for": "5.5.5.5" } })).status, 200);
  const counted = used();
  assert.equal((await x.app.request("/v1/me", { headers: { ...(await signed(device, "GET", "/v1/me")), "x-forwarded-for": "5.5.5.5" } })).status, 429);
  assert.equal(used(), counted);
  const auth = authenticate(x.accounts, undefined as never, ORIGIN, x.keyholes);
  const req = async () => ({ method: "GET", url: "/pc/v1/signal", headers: { ...(await signed(device, "GET", "/pc/v1/signal")), "x-forwarded-for": "6.6.6.6" } }) as unknown as IncomingMessage;
  for (let i = 0; i < 240; i++) assert.equal((await auth(await req()) as { kind?: string }).kind, "device");
  const pcCounted = used();
  assert.deepEqual(await auth(await req()), { refused: "rate_limited", status: 429 });
  assert.equal(used(), pcCounted);
});

test("review fixes: the serial chain runs one call at a time, in order", async () => {
  const x = setup();
  const order: string[] = [];
  let release!: () => void;
  const first = x.entries.serial(async () => { order.push("a1"); await new Promise<void>((r) => { release = r; }); order.push("a2"); });
  const second = x.entries.serial(() => { order.push("b"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["a1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1", "a2", "b"]);
});

test("review fixes: an open /v1/events stream closes at its next wake once its keyhole is removed", async () => {
  const x = setup();
  const { device: parent, entry } = await startParent(x.app, ORIGIN);
  const child = await joinAs(x.app, ORIGIN, parent);
  const stream = await x.app.request("/v1/events", { headers: await signed(child, "GET", "/v1/events") });
  assert.equal(stream.status, 200);
  const text = stream.text();
  assert.deepEqual(await keysCall(x.app, parent, "others"), { status: 200, json: { removed: 1 } });
  x.events.publish(entry, "decision.created", { title: "after removal" });
  const closed = await Promise.race([text, new Promise((r) => setTimeout(() => r("still open"), 2000))]);
  assert.equal(typeof closed, "string");
  assert.notEqual(closed, "still open");
  assert.equal((closed as string).includes("after removal"), false); // nothing reaches the removed device
});

test("pairing claim: a child's signed request is refused parent_required (scan with the phone); a parent's reaches the claim", async () => {
  const x = setup();
  const { device: parent } = await startParent(x.app, ORIGIN);
  const child = await joinAs(x.app, ORIGIN, parent, "child");
  const path = "/v1/pairing/nope/claim";
  const claim = async (device: typeof parent, extra: Record<string, string> = {}) =>
    x.app.request(path, { method: "POST", body: "{}", headers: { ...(await signed(device, "POST", path, "{}")), "content-type": "application/json", ...extra } });
  const refused = await claim(child);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: { code: "parent_required", message: "AIとの接続は、スマホ（iPhone・iPad・Android）のアプリでQRコードを読み取って承認してください。" } });
  assert.match(((await (await claim(child, { "accept-language": "en" })).json()) as { error: { message: string } }).error.message, /scanning the QR code with the app on your phone/);
  const passed = await claim(parent);
  assert.equal(passed.status, 404); // past the gate: the pairing itself is unknown
  assert.equal(((await passed.json()) as { error: { code: string } }).error.code, "not_found");
});
