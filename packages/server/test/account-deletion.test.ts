import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const signed = accounts.signInWithIdentity("google", name);
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
  }
  run(x.db, "insert into auth_flows (state,provider,nonce,code_challenge,created_at,expires_at) values ('unbound','apple','nonce','pkce',?,?)", at, at);
  run(x.db, "insert into diagnostic_rate values (?,'global',2)", at.slice(0, 13));
  const beforeOther = all(x.db, "select * from events where user_id=?", x.b.user);
  assert.equal((await x.call("DELETE", "/v1/me")).status, 200);
  for (const table of ["users", "identities", "sessions", "connections", "devices", "decisions", "events", "idempotency", "pairings", "setup_checks", "attachments", "request_uploads", "login_links", "appstore_subscriptions"]) {
    const column = table === "users" ? "id" : "user_id";
    assert.equal(get<{ n: number }>(x.db, `select count(*) n from ${table} where ${column}=?`, x.a.user)?.n, 0, table);
  }
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from request_checks where connection_id=?", x.a.conn.id)?.n, 0);
  assert.equal(get<{ n: number }>(x.db, "select count(*) n from auth_flows where link_user_id=?", x.a.user)?.n, 0);
  assert.ok(get(x.db, "select 1 from auth_flows where state='unbound'"));
  assert.equal(get<{ count: number }>(x.db, "select count from diagnostic_rate where scope='global'")?.count, 2);
  assert.deepEqual(all(x.db, "select * from events where user_id=?", x.b.user), beforeOther);
  assert.equal((await x.call("GET", "/v1/me", x.b.session)).status, 200);
  assert.equal((await x.call("GET", "/v1/me")).status, 401);
  assert.equal((await x.call("GET", "/connector/v1/connection", x.a.conn.token)).status, 401);
  assert.throws(() => x.events.publish(x.a.user, "late", { private: "late" }), /FOREIGN KEY/);
  assert.throws(() => run(x.db, "insert into idempotency values (?,?,?,?,?,?)", x.a.user, "late", "POST /late", 200, "private", at), /FOREIGN KEY/);
});

test("diagnostics carry no account: no user column or email is stored, and DELETE /me leaves diagnostics unchanged", async t => {
  const x = fixture(t);
  x.diagnostics.accept(x.a.user, event()); x.diagnostics.accept(x.b.user, event("decisions.list"));
  const cols = (name: string) => all<{ name: string }>(x.db, `select name from pragma_table_info('${name}')`).map(c => c.name);
  for (const name of ["diagnostics", "diagnostic_receipts", "diagnostic_groups", "diagnostic_rate", "diagnostic_investigations"]) assert.equal(cols(name).includes("user_id"), false, name);
  assert.equal(cols("identities").includes("email"), false);
  assert.deepEqual(all<{ scope: string }>(x.db, "select scope from diagnostic_rate").map(r => r.scope), ["global"]);
  const snapshot = () => ["diagnostics", "diagnostic_receipts", "diagnostic_groups", "diagnostic_rate"].map(name => all(x.db, `select * from ${name}`));
  const before = snapshot();
  assert.equal((await x.call("DELETE", "/v1/me")).status, 200);
  assert.deepEqual(snapshot(), before);
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

test("schema6 migration removes orphan replies and preserves diagnostic groups on reopen and account deletion", t => {
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
  run(db, "insert into idempotency values ('gone','orphan','POST /v1/answer',200,'personal','2000-01-01')");
  db.exec("pragma user_version=6"); db.close();
  db = openDb(file);
  assert.equal(get<{ user_version: number }>(db, "pragma user_version")?.user_version, 13);
  assert.equal(get(db, "select * from idempotency where user_id='gone'"), undefined);
  assert.deepEqual(all(db, "select * from diagnostic_groups"), before);
  db.close(); db = openDb(file);
  new Accounts(db, new EventHub(db), "off").deleteUser(user);
  assert.deepEqual(all(db, "select * from diagnostic_groups"), before);
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

test("schema13 migration erases stored emails and user IDs in diagnostics, keeping the newest row per event", t => {
  const dir = mkdtempSync(join(tmpdir(), "ab-anonymous-")), file = join(dir, "v12.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = openDb(file);
  const accounts = new Accounts(db, new EventHub(db), "off");
  const a = accounts.signInWithIdentity("apple", "sub-a").user.id, b = accounts.createUser();
  const d = new Diagnostics(db), shared = event(), other = event("decisions.list");
  d.accept(a, shared); d.accept(b, other);
  const groups = all(db, "select * from diagnostic_groups");
  const raw = all<{ id: number; event_id: string; payload: string; payload_hash: string; fingerprint: string; severity: string; received_at: string }>(db, "select * from diagnostics order by id");
  // Rebuild the schema12 shape: an email on the identity, user-linked raw events/receipts, per-user sources and rate.
  db.exec(`alter table identities add column email text; update identities set email='private-mail@example.invalid';
    drop table diagnostics; drop table diagnostic_receipts;
    create table diagnostics (id integer primary key autoincrement, user_id text not null references users(id) on delete cascade, event_id text not null, received_at text not null, payload text not null, payload_hash text not null, fingerprint text not null, severity text not null, resolved_at text, unique(user_id,event_id));
    create table diagnostic_receipts (user_id text not null references users(id) on delete cascade, event_id text not null, payload_hash text not null, created_at text not null, primary key(user_id,event_id));
    create table diagnostic_group_sources (fingerprint text not null, user_id text not null, occurrence_count integer not null, first_seen text not null, last_seen text not null, payload text not null, primary key(fingerprint,user_id));`);
  const owners = [a, b];
  raw.forEach((r, i) => {
    run(db, "insert into diagnostics (id,user_id,event_id,received_at,payload,payload_hash,fingerprint,severity) values (?,?,?,?,?,?,?,?)", r.id + 10, owners[i]!, r.event_id, r.received_at, r.payload, r.payload_hash, r.fingerprint, r.severity);
    run(db, "insert into diagnostic_receipts values (?,?,?,?)", owners[i]!, r.event_id, r.payload_hash, "2026-11-19T00:00:0" + (i + 1));
    run(db, "insert into diagnostic_group_sources values (?,?,1,?,?,?)", r.fingerprint, owners[i]!, r.received_at, r.received_at, r.payload);
  });
  // The same event_id from another account: the older copy is the one to drop.
  run(db, "insert into diagnostics (id,user_id,event_id,received_at,payload,payload_hash,fingerprint,severity) values (1,?,?,'2000','old','old','old','high')", b, shared.event_id);
  run(db, "insert into diagnostic_receipts values (?,?,'old','2000')", b, shared.event_id);
  run(db, "insert into diagnostic_rate values ('2026-11-19T00',?,3)", a);
  db.exec("pragma user_version=12"); db.close();
  db = openDb(file);
  const cols = (name: string) => all<{ name: string }>(db, `select name from pragma_table_info('${name}')`).map(c => c.name);
  assert.equal(get<{ user_version: number }>(db, "pragma user_version")?.user_version, 13);
  assert.equal(cols("identities").includes("email"), false);
  assert.equal(cols("diagnostics").includes("user_id"), false);
  assert.equal(cols("diagnostic_receipts").includes("user_id"), false);
  assert.equal(get(db, "select 1 from sqlite_master where name='diagnostic_group_sources'"), undefined);
  assert.deepEqual(all<{ scope: string }>(db, "select scope from diagnostic_rate").map(r => r.scope), ["global"]);
  assert.deepEqual(all<{ event_id: string; payload: string }>(db, "select event_id,payload from diagnostics order by event_id").map(r => [r.event_id, r.payload]), raw.map(r => [r.event_id, r.payload]).sort());
  assert.deepEqual(all<{ payload_hash: string }>(db, "select payload_hash from diagnostic_receipts where event_id=?", shared.event_id).map(r => r.payload_hash), [raw[0]!.payload_hash]);
  assert.deepEqual(all(db, "select * from diagnostic_groups"), groups);
  assert.equal(new Accounts(db, new EventHub(db), "off").signInWithIdentity("apple", "sub-a").user.id, a);
  assert.equal(new Diagnostics(db).accept(a, shared).duplicate, true);
  assert.deepEqual(all(db, "pragma foreign_key_check"), []);
  db.close();
  for (const name of [file, `${file}-wal`]) if (existsSync(name)) assert.equal(readFileSync(name).includes("private-mail@example.invalid"), false, name);
});
