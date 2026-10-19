import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Accounts } from "../src/accounts.ts";
import { Attachments } from "../src/attachments.ts";
import { all, get, openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { Diagnostics, diagnosticFingerprint, diagnosticSchema } from "../src/diagnostics.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=", "base64");
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ab-delete-")), db = openDb(":memory:");
  const events = new EventHub(db), accounts = new Accounts(db, events, "off"), decisions = new Decisions(db, events);
  const attachments = new Attachments(db, dir), diagnostics = new Diagnostics(db);
  const app = createApp({ db, events, accounts, decisions, attachments, publicUrl: "https://test.invalid" });
  const identity = (name: string) => {
    const signed = accounts.signInWithIdentity("google", name, `${name}@example.invalid`);
    const conn = accounts.createConnection(signed.user.id, name, "linux", ["codex"]);
    return { user: signed.user.id, session: signed.session, conn };
  };
  const a = identity("delete"), b = identity("keep");
  const call = (method: string, path: string, session = a.session) => app.request(path, { method, headers: { authorization: `Bearer ${session}` } });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, events, accounts, attachments, diagnostics, app, dir, a, b, call };
}
const event = (operation: "events" | "decisions.list" = "events") => diagnosticSchema.parse({
  event_id: randomUUID(), occurred_at: new Date().toISOString(), code: "api_failed", module: "api", app_version: "0.1.0(27)", device_type: "Mac", os_version: "27.0.0",
  diagnostic_log: { operation, user_visible: false, error_domain: "NSURLErrorDomain", error_code: -1001 },
});

test("DELETE /me removes owned auxiliary data and rejects late writes without changing another account", async t => {
  const x = fixture(t), at = new Date().toISOString();
  for (const who of [x.a, x.b]) {
    x.events.publish(who.user, "decision.created", { title: who.user });
    run(x.db, "insert into idempotency values (?,?,?,?,?,?)", who.user, "key", "POST /v1/decisions", 200, JSON.stringify({ private: who.user }), at);
    run(x.db, "insert into pairings (id,code,poll_secret_hash,device_name,clients,status,user_id,connection_id,token,created_at,expires_at) values (?,?,?,?,?,'claimed',?,?,?,?,?)", who.user, who.user, "h", "device", "[]", who.user, who.conn.id, "secret", at, at);
    run(x.db, "insert into request_checks values (?,?,?,?,null)", who.user, who.conn.id, at, at);
    run(x.db, "insert into auth_flows (state,provider,nonce,code_challenge,created_at,expires_at,link_user_id) values (?,'apple','nonce','pkce',?,?,?)", who.user, at, at, who.user);
    run(x.db, "insert into diagnostic_rate values (?,?,1)", at.slice(0, 13), who.user);
  }
  run(x.db, "insert into auth_flows (state,provider,nonce,code_challenge,created_at,expires_at) values ('unbound','apple','nonce','pkce',?,?)", at, at);
  run(x.db, "insert into diagnostic_rate values (?,'global',2)", at.slice(0, 13));
  const beforeOther = all(x.db, "select * from events where user_id=?", x.b.user);
  assert.equal((await x.call("DELETE", "/v1/me")).status, 200);
  for (const table of ["users", "identities", "sessions", "connections", "devices", "decisions", "events", "idempotency", "pairings", "setup_checks", "attachments", "request_uploads", "diagnostics", "diagnostic_receipts", "login_links", "appstore_subscriptions"]) {
    const column = table === "users" ? "id" : "user_id";
    assert.equal(get<{ n: number }>(x.db, `select count(*) n from ${table} where ${column}=?`, x.a.user)?.n, 0, table);
  }
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from request_checks where connection_id=?", x.a.conn.id)?.n, 0);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from auth_flows where link_user_id=?", x.a.user)?.n, 0);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from diagnostic_rate where scope=?", x.a.user)?.n, 0);
  assert.ok(get(x.db, "select 1 from auth_flows where state='unbound'"));
  assert.equal(get<{ count: number }>(x.db, "select count from diagnostic_rate where scope='global'")?.count, 2);
  assert.deepEqual(all(x.db, "select * from events where user_id=?", x.b.user), beforeOther);
  assert.equal((await x.call("GET", "/v1/me", x.b.session)).status, 200);
  assert.equal((await x.call("GET", "/v1/me")).status, 401);
  assert.equal((await x.call("GET", "/connector/v1/connection", x.a.conn.token)).status, 401);
  assert.throws(() => x.events.publish(x.a.user, "late", { private: "late" }), /FOREIGN KEY/);
  assert.throws(() => run(x.db, "insert into idempotency values (?,?,?,?,?,?)", x.a.user, "late", "POST /late", 200, "private", at), /FOREIGN KEY/);
});

for (const pruned of [false, true]) test(`DELETE /me removes diagnostic contributions and personal notes, preserves other sources (raw pruned=${pruned})`, async t => {
  const x = fixture(t), shared = event(), sole = event("decisions.list");
  x.diagnostics.accept(x.b.user, { ...shared, event_id: randomUUID() });
  x.diagnostics.accept(x.a.user, shared);
  x.diagnostics.accept(x.a.user, sole);
  const fp = diagnosticFingerprint(shared), only = diagnosticFingerprint(sole);
  run(x.db, "update diagnostic_groups set status='resolved',resolution_note='private deletion subject' where fingerprint=?", fp);
  run(x.db, "insert into diagnostic_investigations values (?,?,?,?)", fp, "private deletion subject", "[]", new Date().toISOString());
  const other = event(); other.diagnostic_log.error_code = -1005;
  x.diagnostics.accept(x.b.user, other);
  const otherFp = diagnosticFingerprint(other);
  const protectedRow = get(x.db, "select * from diagnostic_groups where fingerprint=?", otherFp);
  if (pruned) run(x.db, "delete from diagnostics");
  assert.equal((await x.call("DELETE", "/v1/me")).status, 200);
  assert.equal(get(x.db, "select * from diagnostic_groups where fingerprint=?", only), undefined);
  const remaining = get<{ occurrence_count: number; status: string; payload: string; resolution_note: string | null }>(x.db, "select * from diagnostic_groups where fingerprint=?", fp)!;
  assert.equal(remaining.occurrence_count, 1);
  assert.equal(remaining.status, "resolved");
  assert.equal(remaining.resolution_note, null);
  assert.notEqual(JSON.parse(remaining.payload).event_id, shared.event_id);
  assert.equal(get(x.db, "select * from diagnostic_investigations where fingerprint=?", fp), undefined);
  assert.deepEqual(get(x.db, "select * from diagnostic_groups where fingerprint=?", otherFp), protectedRow);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from diagnostic_receipts where user_id=?", x.b.user)?.n, 2);
});

test("DELETE /me file removal failure rolls back account deletion and permits a retry", async t => {
  const x = fixture(t);
  const a = x.attachments.uploadRequest({ id: x.a.conn.id, user_id: x.a.user }, { name: "a.png", contentType: "image/png", data: PNG });
  const b = x.attachments.uploadRequest({ id: x.b.conn.id, user_id: x.b.user }, { name: "b.png", contentType: "image/png", data: PNG });
  writeFileSync(join(x.dir, `${a.id}.part`), PNG);
  const mutable = x.attachments as Attachments & { eraseFiles?: (ids: string[]) => void };
  const erase = mutable.eraseFiles;
  mutable.eraseFiles = () => { throw Error("simulated file removal failure"); };
  assert.equal((await x.call("DELETE", "/v1/me")).status, 500);
  assert.equal((await x.call("GET", "/v1/me")).status, 200);
  assert.ok(existsSync(join(x.dir, a.id)));
  assert.ok(existsSync(join(x.dir, b.id)));
  mutable.eraseFiles = erase;
  assert.equal((await x.call("DELETE", "/v1/me")).status, 200);
  assert.equal(existsSync(join(x.dir, a.id)), false);
  assert.equal(existsSync(join(x.dir, `${a.id}.part`)), false);
  assert.equal(existsSync(join(x.dir, b.id)), true);
});

test("schema6 migration removes orphan replies/payloads and preserves living diagnostic groups on reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "ab-delete-migration-")), file = join(dir, "old.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = openDb(file);
  const accounts = new Accounts(db, new EventHub(db), "off"), user = accounts.createUser();
  const d = new Diagnostics(db), input = event(); d.accept(user, input);
  const before = all(db, "select * from diagnostic_groups");
  db.exec("pragma foreign_keys=off");
  for (const name of ["events", "idempotency", "pairings", "request_checks", "auth_flows"]) {
    db.exec(`create table legacy_${name} as select * from ${name}; drop table ${name}; alter table legacy_${name} rename to ${name};`);
  }
  db.exec("drop table if exists diagnostic_group_sources");
  run(db, "insert into idempotency values ('gone','orphan','POST /v1/answer',200,'personal','2000-01-01')");
  run(db, "insert into diagnostic_groups (fingerprint,severity,message_template,occurrence_count,first_seen,last_seen,status,payload) values ('orphan','high','old',2,'2000','2000','resolved',?)", JSON.stringify({ ...input, event_id: randomUUID() }));
  db.exec("pragma user_version=6"); db.close();
  db = openDb(file);
  assert.equal(get<{ user_version: number }>(db, "pragma user_version")?.user_version, 7);
  assert.equal(get(db, "select * from idempotency where user_id='gone'"), undefined);
  assert.equal(get(db, "select * from diagnostic_groups where fingerprint='orphan'"), undefined);
  assert.deepEqual(all(db, "select * from diagnostic_groups"), before);
  db.close(); db = openDb(file);
  new Accounts(db, new EventHub(db), "off").deleteUser(user);
  assert.equal(all(db, "select * from diagnostic_groups").length, 0);
  assert.deepEqual(all(db, "pragma foreign_key_check"), []);
  db.close();
});

test("account-deletion migration preserves the SSE cursor even when the highest event was already removed", t => {
  const dir = mkdtempSync(join(tmpdir(), "ab-delete-sequence-")), file = join(dir, "events.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = openDb(file);
  const accounts = new Accounts(db, new EventHub(db), "off"), user = accounts.createUser();
  run(db, "insert into events (id,user_id,type,data,at) values (900,?,'old','{}','2000')", user);
  run(db, "delete from events");
  run(db, "insert into auth_flows (state,provider,nonce,code_challenge,created_at,expires_at,used_at) values ('consumed','apple','n','c','2000','3000','2000')");
  db.exec("pragma user_version=6"); db.close();
  db = openDb(file);
  new EventHub(db).publish(user, "new", {});
  assert.equal(get<{ id: number }>(db, "select id from events")?.id, 901);
  assert.equal(get(db, "select 1 from auth_flows where state='consumed'"), undefined);
  db.close();
});

test("another user's active aggregate does not extend an inactive source's 120-day retention", t => {
  const x = fixture(t), old = event(), recent = { ...old, event_id: randomUUID() };
  x.diagnostics.accept(x.a.user, old); x.diagnostics.accept(x.b.user, recent);
  const fp = diagnosticFingerprint(old);
  run(x.db, "update diagnostics set received_at='2000-01-01T00:00:00Z' where user_id=?", x.a.user);
  run(x.db, "update diagnostic_group_sources set last_seen='2000-01-01T00:00:00Z' where user_id=?", x.a.user);
  run(x.db, "insert into diagnostic_investigations values (?,'old context','[]','2000')", fp);
  x.diagnostics.prune();
  assert.equal(get(x.db, "select 1 from diagnostic_group_sources where user_id=?", x.a.user), undefined);
  assert.equal(get(x.db, "select 1 from diagnostics where user_id=?", x.a.user), undefined);
  assert.equal(get(x.db, "select 1 from diagnostic_investigations where fingerprint=?", fp), undefined);
  assert.equal(JSON.parse(get<{ payload: string }>(x.db, "select payload from diagnostic_groups where fingerprint=?", fp)!.payload).event_id, recent.event_id);
});
