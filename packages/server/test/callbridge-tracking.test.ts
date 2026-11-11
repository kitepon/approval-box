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

function mockClient(t: { mock: { method: typeof import("node:test").mock.method } }, onTool: (name: string) => unknown) {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => { calls.push(name); return onTool(name); });
  return calls;
}
function bridgeRow(db: ReturnType<typeof openDb>) { return get<{ state: string; seq: number | null; session_id: string }>(db, "select state, seq, session_id from bridge_deliveries"); }

test("accepted queued send hands off once: no call_info, no call_hangup", async t => {
  const db = openDb(":memory:"); seed(db); t.after(() => db.close());
  const calls = mockClient(t, name => {
    if (name === "call_open") return { structuredContent: { session_id: "s" }, content: [] };
    assert.equal(bridgeRow(db)!.session_id, "s", "checkpoint before call_send");
    return { structuredContent: { session_id: "s", seq: 1, delivery: { status: "queued" } }, content: [] };
  });
  const d = deliverer(db);
  await d.sync();
  assert.deepEqual(calls, ["call_open", "call_send"]);
  assert.equal(status(db), "delivered");
  assert.deepEqual({ ...bridgeRow(db) }, { state: "delivered", seq: 1, session_id: "s" });
  await d.sync(); await d.sync();
  assert.deepEqual(calls, ["call_open", "call_send"]);
});

test("lost call_send response is unknown and never resent", async t => {
  const db = openDb(":memory:"); seed(db); t.after(() => db.close());
  const calls = mockClient(t, name => { if (name === "call_open") return { structuredContent: { session_id: "s" }, content: [] }; throw new Error("response lost"); });
  const d = deliverer(db);
  await d.sync(); await d.sync();
  assert.equal(status(db), "unknown");
  assert.deepEqual(calls, ["call_open", "call_send"]);
});

test("explicit delivery error is shown as unknown", async t => {
  const db = openDb(":memory:"); seed(db); t.after(() => db.close());
  mockClient(t, name => name === "call_open" ? { structuredContent: { session_id: "s" }, content: [] } : { structuredContent: { delivery: { status: "error" } }, content: [] });
  await deliverer(db).sync();
  assert.equal(status(db), "unknown");
  assert.equal(bridgeRow(db)!.state, "failed");
});

test("checkpoint failure never sends answer", async t => {
  const calls = mockClient(t, () => ({ structuredContent: { session_id: "s" }, content: [] }));
  const result = await callBridgeSender(config)("member", "K-TEST", "answer", { save: () => { throw new Error("disk failure"); } });
  assert.equal(result.state, "failed");
  assert.deepEqual(calls, ["call_open"]);
});

for (const [name, seq, expected, delivery] of [["with seq", 1, "delivered", "waiting"], ["without seq", null, "unknown", "waiting"], ["fetched stays fetched", 1, "fetched", "fetched"]] as const) test(`legacy pending row on restart (${name}) is settled without any tool call`, async t => {
  const db = openDb(":memory:"); seed(db); t.after(() => db.close());
  run(db, "insert into bridge_deliveries(decision_id,session_id,seq,state) values('K-TEST','s',?,'pending')", seq);
  run(db, "update decisions set delivery = ? where id = 'K-TEST'", delivery);
  const calls = mockClient(t, () => assert.fail("legacy rows must not call the Bridge"));
  const d = deliverer(db);
  await d.sync();
  assert.equal(status(db), expected);
  assert.equal(bridgeRow(db)!.state, seq === null ? "unknown" : "delivered");
  assert.deepEqual(calls, []);
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

