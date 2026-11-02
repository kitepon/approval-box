import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callBridgeSender, CallBridgeDeliverer } from "../src/callbridge.ts";
import { openDb, get, run } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { Decisions } from "../src/decisions.ts";

const config = { url: "https://bridge.test/mcp", headers: {}, localSystem: "local", localId: "approval-box", localLabel: "Approval Box", memberSystem: "grokbot" };
function seed(db: ReturnType<typeof openDb>) {
  run(db, "insert into users(id,created_at) values('u','2026-11-02')");
  run(db, "insert into connections(id,user_id,kind,label,created_at) values('c','u','remote','GrokBot','2026-11-02')");
  run(db, `insert into decisions(id,user_id,connection_id,route,title,norm_title,context,options,urgency,client,session_label,via,status,answer,delivery,delivery_id,delivery_text,resume_phrase,created_at,updated_at,version)
    values('K-TEST','u','c',?,'t','t','','[]','normal','other','job','remote','answered',?,'waiting','d','synthetic answer','r','2026-11-02','2026-11-02',1)`, JSON.stringify({ harness: "callbridge", channel_id: "member" }), JSON.stringify({ answered_at: new Date().toISOString() }));
}
function deliverer(db: ReturnType<typeof openDb>) {
  const events = new EventHub(db);
  return new CallBridgeDeliverer(db, new Decisions(db, events), events, callBridgeSender(config), ["c"]);
}
function status(db: ReturnType<typeof openDb>) { return get<{ delivery: string }>(db, "select delivery from decisions where id='K-TEST'")!.delivery; }

for (const terminal of ["submitted", "failed", "unknown"] as const) test(`queued→inflight→${terminal}: restart tracks same call; terminal persisted before hangup`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "ab-bridge-"));
  const file = join(dir, "db.sqlite");
  let db = openDb(file); seed(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  let receipt = "inflight";
  t.mock.method(Client.prototype, "callTool", async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    calls.push(name);
    if (name === "call_open") return { structuredContent: { session_id: "s" }, content: [] };
    if (name === "call_send") {
      assert.equal(get<{ session_id: string }>(db, "select session_id from bridge_deliveries")!.session_id, "s", "checkpoint before effect");
      return { structuredContent: { session_id: "s", seq: 1, delivery: { status: "queued" } }, content: [] };
    }
    assert.equal(args.session_id, "s");
    if (name === "call_info") return { structuredContent: { grokbot_delivery: [{ seq: 1, state: receipt }] }, content: [] };
    assert.equal(name, "call_hangup");
    assert.equal(status(db), terminal === "submitted" ? "delivered" : "unknown");
    assert.equal(get<{ state: string }>(db, "select state from bridge_deliveries")!.state, terminal === "submitted" ? "delivered" : terminal);
    return { content: [] };
  });
  await deliverer(db).sync();
  assert.equal(status(db), "waiting");
  assert.deepEqual(calls, ["call_open", "call_send"]);
  db.close(); db = openDb(file);
  const resumed = deliverer(db);
  await resumed.sync();
  assert.equal(status(db), "waiting");
  assert.equal(calls.filter(n => n === "call_send").length, 1);
  receipt = terminal;
  await resumed.sync(); await resumed.sync();
  assert.equal(calls.filter(n => n === "call_hangup").length, 1);
  assert.equal(get<{ closed: number }>(db, "select closed from bridge_deliveries")!.closed, 1);
});

test("lost send response + unavailable info keeps session; fetched result and failed close do not resend", async t => {
  const db = openDb(":memory:"); seed(db); t.after(() => db.close());
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  let polls = 0, closes = 0;
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => {
    calls.push(name);
    if (name === "call_open") return { structuredContent: { session_id: "s" }, content: [] };
    if (name === "call_send") throw new Error("response lost");
    if (name === "call_info") {
      if (++polls === 1) throw new Error("network unavailable");
      return { structuredContent: { grokbot_delivery: [{ seq: 1, state: "submitted" }] }, content: [] };
    }
    if (++closes === 1) throw new Error("hangup response lost");
    return { content: [] };
  });
  await deliverer(db).sync();
  assert.equal(get<{ seq: number | null }>(db, "select seq from bridge_deliveries")!.seq, null);
  const resumed = deliverer(db);
  await resumed.sync(); assert.equal(status(db), "waiting");
  run(db, "update decisions set delivery='fetched' where id='K-TEST'");
  await resumed.sync();
  assert.equal(status(db), "fetched");
  assert.equal(get<{ seq: number }>(db, "select seq from bridge_deliveries")!.seq, 1);
  await deliverer(db).sync();
  assert.equal(calls.filter(n => n === "call_send").length, 1);
  assert.equal(closes, 2);
  assert.equal(get<{ closed: number }>(db, "select closed from bridge_deliveries")!.closed, 1);
});

test("schema9 migration preserves legacy answers and unknown; journal cascades with decision deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-bridge-migration-"));
  const file = join(dir, "db.sqlite");
  let db = openDb(file); seed(db);
  db.exec("drop table bridge_deliveries; pragma user_version=9;");
  run(db, "update decisions set delivery='unknown', delivery_detail='call_send: queued'");
  db.close(); db = openDb(file);
  assert.equal(get<{ user_version: number }>(db, "pragma user_version")!.user_version, 10);
  assert.equal(status(db), "unknown");
  run(db, "insert into bridge_deliveries(decision_id,session_id,seq,state) values('K-TEST','s',1,'failed')");
  run(db, "delete from decisions where id='K-TEST'");
  assert.equal(get(db, "select * from bridge_deliveries"), undefined);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

for (const rows of [[], [{ seq: 2, state: "submitted" }], [{ seq: 1, state: "submitted" }, { seq: 2, state: "submitted" }]]) test(`lost response never guesses another message: ${JSON.stringify(rows)}`, async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => { calls.push(name); return { structuredContent: { grokbot_delivery: rows }, content: [] }; });
  const result = await callBridgeSender(config)("member", "K-TEST", "", { sessionId: "s", save: () => assert.fail("ambiguous seq must not be adopted") });
  assert.equal(result.state, "pending");
  assert.deepEqual(calls, ["call_info"]);
});

test("checkpoint failure never sends answer", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => { calls.push(name); return { structuredContent: { session_id: "s" }, content: [] }; });
  await callBridgeSender(config)("member", "K-TEST", "answer", { save: () => { throw new Error("disk failure"); } });
  assert.deepEqual(calls, ["call_open"]);
});

test("queued is not cancelled by immediate hangup", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => {
    calls.push(name);
    return { structuredContent: name === "call_open" ? { session_id: "s" } : { seq: 1, delivery: { status: "queued" } }, content: [] };
  });
  const result = await callBridgeSender(config)("member", "K-TEST", "synthetic answer", { save: () => {} });
  assert.deepEqual(calls, ["call_open", "call_send"]);
  assert.equal(result.state, "pending");
});
