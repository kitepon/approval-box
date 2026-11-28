// Sealed content and the purge of decided requests (e02, docs/architecture/storage-lifecycle.md "Sealed content"). The package's test script sets
// ABX_DATA_KEY, so these run on the no-module window (keyWindow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Attachments } from "../src/attachments.ts";
import { all, get, openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { createAppKeyholes, createEntries } from "../src/keyholes.ts";
import { Vault, attachVault, looksSealed, sealExisting, vaultFromEnv, vaultOf } from "../src/seal.ts";
import { joinAs, signed, startParent, type Device } from "./keyhole-signer.ts";

const ORIGIN = "https://kb.test";
const DAY = 86400_000;
const png = (marker: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(marker)]);

function setup(onDisk = false) {
  const dir = mkdtempSync(join(tmpdir(), "ab-sealed-"));
  const db = openDb(onDisk ? join(dir, "approval-box.db") : ":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const decisions = new Decisions(db, events);
  const attachments = new Attachments(db, join(dir, "attachments"));
  const entries = createEntries({ db, accounts, attachments });
  const keyholes = createAppKeyholes({ db, origin: ORIGIN, entries });
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, attachments, keyholes });
  const call = async (method: string, path: string, opts: { device?: Device; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.device ? await signed(opts.device, method, path, text) : {}), ...opts.headers }, ...(text ? { body: text } : {}) });
    const raw = await res.text();
    return { status: res.status, json: raw ? JSON.parse(raw) : null };
  };
  return { dir, db, events, accounts, decisions, attachments, app, call };
}
type X = ReturnType<typeof setup>;

/** An entry with one parent device (its users row made by a signed request). */
async function entry(x: X) {
  const { device, entry } = await startParent(x.app, ORIGIN);
  assert.equal((await x.call("GET", "/v1/me", { device })).status, 200);
  return { device, entry };
}

/** A request from an AI connection of the account (the confirm round as the AI does it). */
async function ask(x: X, userId: string, title: string, extra: Record<string, unknown> = {}) {
  const c = x.accounts.createConnection(userId, "pc", "linux", ["codex"]);
  const conn = { id: c.id, user_id: userId, label: "pc", os: "linux" };
  const input = { title, context: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], urgency: "normal", session_label: "作業", client: "codex", ...extra } as never;
  let check_token = "";
  try { await x.decisions.create(conn, input); } catch (error) { check_token = (error as { extra: { check_token: string } }).extra.check_token; }
  const created = await x.decisions.create(conn, { ...(input as object), check_token } as never);
  return { conn, token: c.token, id: created.id };
}

async function answer(x: X, device: Device, id: string, body: Record<string, unknown> = { option_id: "a" }) {
  const version = (await x.call("GET", `/v1/decisions/${id}`, { device })).json.version;
  const res = await x.call("POST", `/v1/decisions/${id}/answer`, { device, body: { ...body, version }, headers: { "idempotency-key": `k-${id}` } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

test("content at rest is sealed: no title, context, option, answer, note, image or file name in the SQLite file, the WAL or the attachment files; reads open it", async () => {
  const x = setup(true);
  const { device, entry: user } = await entry(x);
  const c = x.accounts.createConnection(user, "pc", "linux", ["codex"]);
  const conn = { id: c.id, user_id: user, label: "pc", os: "linux" };
  const image = await x.attachments.uploadRequest(conn, { name: "IMAGE-NAME-7f3.png", contentType: "image/png", data: png("IMAGE-BYTES-7f3") });
  const input = { title: "TITLE-MARK-7f3", context: "CONTEXT-MARK-7f3", options: [{ id: "a", label: "OPTION-MARK-7f3" }, { id: "b", label: "B" }], urgency: "normal", session_label: "work", client: "codex", request_attachment_ids: [image.id] } as never;
  let check_token = "";
  try { await x.decisions.create(conn, input); } catch (error) { check_token = (error as { extra: { check_token: string } }).extra.check_token; }
  const { id } = await x.decisions.create(conn, { ...(input as object), check_token } as never);
  await x.decisions.amend(conn, id, { version: 1, note: "NOTE-MARK-7f3", changes: { context: "CONTEXT-MARK-7f3 again" } });
  await answer(x, device, id, { option_id: "a", text: "ANSWER-MARK-7f3" });

  const opened = (await x.call("GET", `/v1/decisions/${id}`, { device })).json;
  assert.equal(opened.title, "TITLE-MARK-7f3");
  assert.equal(opened.context, "CONTEXT-MARK-7f3 again");
  assert.equal(opened.options[0].label, "OPTION-MARK-7f3");
  assert.equal(opened.answer.text, "ANSWER-MARK-7f3");
  assert.equal(opened.request_attachments[0].name, "IMAGE-NAME-7f3.png");
  assert.ok(opened.history.some((h: { note?: string }) => h.note === "NOTE-MARK-7f3"));
  const ai = (await x.call("GET", `/connector/v1/decisions/${id}`, { token: c.token })).json;
  assert.match(ai.answer_text, /ANSWER-MARK-7f3/);
  const file = await x.attachments.readForAi(id, image.id);
  assert.equal(file.data.toString("latin1").includes("IMAGE-BYTES-7f3"), true);
  // The same answer replays from the sealed idempotency record.
  const replay = await x.call("POST", `/v1/decisions/${id}/answer`, { device, body: { option_id: "a", text: "ANSWER-MARK-7f3", version: opened.version - 1 }, headers: { "idempotency-key": `k-${id}` } });
  assert.equal(replay.json.answer.text, "ANSWER-MARK-7f3");

  assert.equal(get<{ t: string }>(x.db, "select typeof(title) t from decisions where id = ?", id)!.t, "blob");
  assert.equal(get<{ t: string }>(x.db, "select typeof(body) t from idempotency")!.t, "blob");
  x.db.exec("pragma wal_checkpoint(truncate)");
  const bytes = [readFileSync(join(x.dir, "approval-box.db")), ...(existsSync(join(x.dir, "approval-box.db-wal")) ? [readFileSync(join(x.dir, "approval-box.db-wal"))] : []),
    ...readdirSync(join(x.dir, "attachments")).map((name) => readFileSync(join(x.dir, "attachments", name)))];
  for (const marker of ["TITLE-MARK", "CONTEXT-MARK", "OPTION-MARK", "ANSWER-MARK", "NOTE-MARK", "IMAGE-NAME", "IMAGE-BYTES"]) {
    assert.equal(bytes.some((b) => b.includes(Buffer.from(marker))), false, marker);
  }
  for (const name of readdirSync(join(x.dir, "attachments"))) assert.ok(looksSealed(readFileSync(join(x.dir, "attachments", name))));
  x.db.close();
});

test("decided content goes once the AI fetched it and every device stored it; the tombstone answers, then goes after 30 days; the data key goes with the account", async () => {
  const x = setup();
  const { device, entry: user } = await entry(x);
  const child = await joinAs(x.app, ORIGIN, device);
  const { id, token } = await ask(x, user, "決めてほしいこと");
  assert.equal((await x.call("POST", `/v1/decisions/${id}/stored`, { device })).status, 409); // not decided yet
  await answer(x, device, id);
  assert.equal(await x.decisions.sweepContent(), 0); // the AI has not fetched it
  assert.equal((await x.call("POST", `/connector/v1/decisions/${id}/fetched`, { token })).json.answer.option_id, "a");
  assert.equal(await x.decisions.sweepContent(), 0); // no device stored it
  for (let i = 0; i < 2; i++) assert.deepEqual((await x.call("POST", `/v1/decisions/${id}/stored`, { device })).json, { decision_id: id, stored: true });
  assert.equal(await x.decisions.sweepContent(), 0); // the child has not
  assert.equal((await x.call("POST", `/v1/decisions/${id}/stored`, { device: child })).status, 200);
  // The data key is past 30 days: the hourly sweep rotates it, and keeps the old one while records are sealed under it.
  const vault = vaultOf(x.db), dir = join(x.dir, "attachments");
  run(x.db, "update data_sets set value = json_set(value, '$.dk.items[0].created', 0) where key = ?", `dset:${user}`);
  assert.deepEqual(await vault.sweep(dir), { rotated: 1, retired: 0, forgotten: 0 });
  assert.equal(await x.decisions.sweepContent(), 1);
  assert.deepEqual(await vault.sweep(dir), { rotated: 0, retired: 1, forgotten: 0 }); // nothing left under the old key

  const tombstone = (await x.call("GET", `/v1/decisions/${id}`, { device })).json;
  assert.equal(tombstone.content_removed, true);
  assert.equal(tombstone.status, "answered");
  assert.equal(tombstone.title, "");
  assert.equal(tombstone.answer, undefined);
  const forAi = (await x.call("GET", `/connector/v1/decisions/${id}`, { token })).json;
  assert.equal(forAi.content_removed, true);
  assert.equal(forAi.answer_text, undefined);
  assert.equal((await x.call("POST", `/connector/v1/decisions/${id}/cancel`, { token, body: { reason: "x" } })).json.error.decision.content_removed, true);
  assert.deepEqual((await x.call("GET", "/v1/decisions?status=answered,cancelled", { device })).json.items, []);
  const row = get<Record<string, unknown>>(x.db, "select title, context, answer, delivery_text, content_state from decisions where id = ?", id)!;
  assert.deepEqual({ ...row }, { title: "", context: "", answer: null, delivery_text: null, content_state: "purged" });
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from idempotency")!.n, 0);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from history where decision_id = ? and note is not null", id)!.n, 0);

  assert.equal(await x.decisions.sweepContent(Date.now() + 29 * DAY), 0);
  assert.ok(get(x.db, "select 1 from decisions where id = ?", id));
  await x.decisions.sweepContent(Date.now() + 31 * DAY);
  assert.equal((await x.call("GET", `/v1/decisions/${id}`, { device })).status, 404);

  assert.ok(get(x.db, "select 1 from data_sets where key = ?", `dset:${user}`));
  x.accounts.deleteUser(user);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(get(x.db, "select 1 from data_sets where key = ?", `dset:${user}`), undefined);
});

test("the 7-day cap purges a decided request no device stored; an open request expires after 14 days", async () => {
  const x = setup();
  const { device, entry: user } = await entry(x);
  const decided = await ask(x, user, "答えるもの");
  const open = await ask(x, user, "待つもの");
  await answer(x, device, decided.id);
  assert.equal(await x.decisions.sweepContent(Date.now() + 6 * DAY), 0);
  assert.equal(await x.decisions.sweepContent(Date.now() + 7 * DAY + 60_000), 1);
  assert.equal((await x.call("GET", `/v1/decisions/${decided.id}`, { device })).json.content_removed, true);
  assert.equal((await x.call("GET", `/v1/decisions/${open.id}`, { device })).json.status, "pending");
  await x.decisions.sweepContent(Date.now() + 15 * DAY);
  const expired = (await x.call("GET", `/v1/decisions/${open.id}`, { device })).json;
  assert.deepEqual([expired.status, expired.cancel_reason], ["cancelled", "expired"]);
});

test("migration seals plaintext rows in place, resumably, leaving no plaintext on disk; a decided row is kept until 7 days after the migration", async () => {
  const x = setup(true);
  const user = x.accounts.createUser();
  const c = x.accounts.createConnection(user, "pc", "linux", ["codex"]);
  const at = "2026-11-01T00:00:00.000Z";
  const insert = (id: string, status: string, answerText: string | null) => run(x.db, `insert into decisions (id, user_id, connection_id, title, norm_title, context, options, urgency, client, session_label, via, status, answer, delivery, delivery_text, resume_phrase, created_at, updated_at, version)
    values (?, ?, ?, ?, ?, 'old context', '[{"id":"a","label":"A"},{"id":"b","label":"B"}]', 'normal', 'codex', 's', 'connector', ?, ?, ?, ?, 'r', ?, ?, 2)`,
    id, user, c.id, `old ${id}`, `old${id}`, status, answerText ? JSON.stringify({ option_id: "a", text: answerText, answered_at: at }) : null, answerText ? "delivered" : null, answerText ? `text ${answerText}` : null, at, at);
  insert("K-OPEN01", "pending", null);
  run(x.db, "update decisions set created_at = ? where id = 'K-OPEN01'", new Date().toISOString()); // still open after the 7 days below
  insert("K-DONE01", "answered", "old answer");
  run(x.db, "insert into history (decision_id, at, kind, by, note) values ('K-OPEN01', ?, 'amended', 'ai', 'old note')", at);
  const dir = join(x.dir, "attachments");
  run(x.db, "insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, position, created_at, purpose) values ('att_old', ?, 'K-DONE01', 'old.png', 'image/png', 'image', 12, 'x', 0, ?, 'answer')", user, at);
  writeFileSync(join(dir, "att_old"), png("OLD-BYTES"));
  // A stop after the file was sealed but before its row: the file is not sealed twice.
  run(x.db, "insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, position, created_at, purpose) values ('att_half', ?, 'K-DONE01', 'half.png', 'image/png', 'image', 12, 'x', 1, ?, 'answer')", user, at);
  writeFileSync(join(dir, "att_half"), await vaultOf(x.db).sealBytes(user, "att_half|file", png("HALF-BYTES")));
  run(x.db, "insert into idempotency (user_id, key, route, status, body, created_at) values (?, 'k1', 'POST /v1/decisions/K-DONE01/answer', 200, '{\"title\":\"old K-DONE01\"}', ?)", user, new Date().toISOString());

  const migratedAt = Date.now();
  assert.deepEqual(await sealExisting(x.db, dir, migratedAt), { decisions: 2, attachments: 2, request_uploads: 0, idempotency: 1 });
  assert.deepEqual(await sealExisting(x.db, dir, migratedAt), { decisions: 0, attachments: 0, request_uploads: 0, idempotency: 0 });
  assert.equal(all<{ t: string }>(x.db, "select typeof(title) t from decisions").every((r) => r.t === "blob"), true);
  assert.equal(get<{ t: string }>(x.db, "select typeof(note) t from history where decision_id = 'K-OPEN01'")!.t, "blob");
  const open = await x.decisions.view(x.decisions.forUser(user, "K-OPEN01"));
  assert.equal(open.title, "old K-OPEN01");
  assert.equal(open.history[0]!.note, "old note");
  const done = await x.decisions.view(x.decisions.forUser(user, "K-DONE01"));
  assert.equal(done.answer!.text, "old answer");
  assert.equal((await x.attachments.readForUser(user, "K-DONE01", "att_old")).data.toString("latin1").includes("OLD-BYTES"), true);
  assert.equal((await x.attachments.readForUser(user, "K-DONE01", "att_half")).data.toString("latin1").includes("HALF-BYTES"), true);
  assert.equal(readFileSync(join(dir, "att_old")).includes(Buffer.from("OLD-BYTES")), false);
  assert.equal(get<{ p: string }>(x.db, "select purge_by p from decisions where id = 'K-DONE01'")!.p, new Date(migratedAt + 7 * DAY).toISOString());
  const disk = [join(x.dir, "approval-box.db"), join(x.dir, "approval-box.db-wal"), ...readdirSync(dir).map((n) => join(dir, n))].filter(existsSync).map((f) => readFileSync(f));
  for (const marker of ["old K-OPEN01", "oldK-OPEN01", "old context", "old answer", "old note", "OLD-BYTES", "HALF-BYTES", "old.png"]) assert.equal(disk.some((b) => b.includes(Buffer.from(marker))), false, marker);

  // Decided weeks ago and already delivered to the AI, it still waits for the apps: not before 7 days from the migration.
  assert.equal(await x.decisions.sweepContent(migratedAt + 6 * DAY), 0);
  assert.equal(await x.decisions.sweepContent(migratedAt + 7 * DAY + 1000), 1);
  assert.equal(get<{ s: string }>(x.db, "select content_state s from decisions where id = 'K-OPEN01'")!.s, "sealed");
});

test("without a window nothing new is stored: requests are refused with 503 store_unavailable", async () => {
  assert.equal(vaultFromEnv(openDb(":memory:"), {}).ready, false);
  assert.equal(vaultFromEnv(openDb(":memory:"), { ABX_DATA_KEY: "c2hvcnQ=" }).ready, false);
  assert.equal(vaultFromEnv(openDb(":memory:"), { ABX_DATA_KEY: Buffer.alloc(32, 1).toString("base64") }).ready, true);
  const x = setup();
  attachVault(x.db, new Vault(x.db));
  const user = x.accounts.createUser();
  const c = x.accounts.createConnection(user, "pc", "linux", ["codex"]);
  const res = await x.call("POST", "/connector/v1/decisions", { token: c.token, body: { title: "t", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], session_label: "s", client: "codex" } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, "store_unavailable");
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from decisions")!.n, 0);
});
