import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Accounts } from "../src/accounts.ts";
import { CallBridgeDeliverer, type SendResult } from "../src/callbridge.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

function setup() {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const decisions = new Decisions(db, events);
  const callBridgeConnections = new Set<string>();
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test", remoteMcp: { callBridgeConnections } });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json" },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { db, app, events, accounts, decisions, call, session, callBridgeConnections };
}

async function mcpClient(ctx: ReturnType<typeof setup>, token: string) {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://kb.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => ctx.app.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

const ask = { title: "経費の区分を決めてほしい", context: "Amazonの購入1件", options: [{ id: "biz", label: "事業" }, { id: "own", label: "私用" }], recommendation: "biz", session_label: "Books 確認" };

test("リモートMCP: Bearer無しは401、札の往復で申請し、get_decisionで答えを取る", async () => {
  const ctx = setup();
  const unauth = await ctx.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(unauth.status, 401);
  assert.equal((await ctx.app.request("/mcp", { method: "GET" })).status, 405);

  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "Claude.ai" } });
  const client = await mcpClient(ctx, issued.json.token);
  const listed = await client.listTools();
  const request = listed.tools.find((t) => t.name === "request_decision")!;
  assert.equal("requester_id" in (request.inputSchema.properties ?? {}), false, "call-bridge で届けない接続には requester を求めない");

  const first = await tool(client, "request_decision", ask);
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent?.error, "confirm_required");
  const created = await tool(client, "request_decision", { ...ask, check_token: first.structuredContent!.check_token });
  assert.equal(created.isError, undefined);
  const id = created.structuredContent!.decision_id as string;
  assert.match(created.content[0]!.text, /get_decision/);

  const app = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
  assert.equal(app.json.source.via, "remote");
  assert.equal(app.json.source.session_label, "Books 確認");

  const dup = await tool(client, "request_decision", { ...ask, check_token: (await tool(client, "request_decision", ask)).structuredContent!.check_token });
  assert.equal(dup.structuredContent?.error, "duplicate_suspected");

  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "own", version: app.json.version } });
  const got = await tool(client, "get_decision", { decision_id: id });
  assert.match(got.content[0]!.text, /答え: 私用/);
  assert.equal(got.structuredContent!.delivery, "fetched");

  const listedMine = await tool(client, "list_my_decisions");
  assert.equal(listedMine.structuredContent!.items.length, 1);
  await client.close();
});

test("call-bridge の接続: 申請者のIDで受け、答えを通話で届ける。コネクタのデーモンには渡さない", async () => {
  const ctx = setup();
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "GrokBot" } });
  ctx.callBridgeConnections.add(issued.json.id);
  const sent: { member: string; id: string; text: string }[] = [];
  let outcome: SendResult = { state: "delivered", detail: "call x" };
  const deliverer = new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, async (member, id, text) => { sent.push({ member, id, text }); return outcome; }, ctx.callBridgeConnections);

  const client = await mcpClient(ctx, issued.json.token);
  const request = (await client.listTools()).tools.find((t) => t.name === "request_decision")!;
  assert.deepEqual(request.inputSchema.required, ["title", "options", "session_label", "requester_id", "requester_name"]);

  const missing = await tool(client, "request_decision", ask);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /requester_id/);

  const who = { requester_id: "cb85c77c-83de-4a84-bb58-85f1e9797cd4", requester_name: "モダニア" };
  const first = await tool(client, "request_decision", { ...ask, ...who });
  const created = await tool(client, "request_decision", { ...ask, ...who, check_token: first.structuredContent!.check_token });
  const id = created.structuredContent!.decision_id as string;
  assert.match(created.content[0]!.text, /通話であなたへ届きます/);

  const app = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
  assert.equal(app.json.source.session_label, "モダニア（申告） / Books 確認");

  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "biz", text: "今月分も同じで", version: app.json.version } });
  // コネクタの配送デーモンには渡さない
  const daemon = await ctx.call("GET", "/connector/v1/deliveries", { token: issued.json.token });
  assert.deepEqual(daemon.json.items, []);
  await deliverer.sync();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.member, who.requester_id);
  assert.match(sent[0]!.text, new RegExp(`^Approval Box ${id}\\n\\[Approval Box\\]`));
  assert.match(sent[0]!.text, /答え: 事業（option_id=biz）/);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.delivery, "delivered");
  await deliverer.sync();
  assert.equal(sent.length, 1, "届けたものは送り直さない");

  // 届いたか分からない送信は unknown のまま送り直さない
  outcome = { state: "unknown", detail: "call_send: unknown" };
  const second = await tool(client, "request_decision", { ...ask, title: "別の件", ...who, check_token: (await tool(client, "request_decision", { ...ask, title: "別の件", ...who })).structuredContent!.check_token });
  const id2 = second.structuredContent!.decision_id as string;
  const v2 = (await ctx.call("GET", `/v1/decisions/${id2}`, { token: ctx.session })).json.version;
  await ctx.call("POST", `/v1/decisions/${id2}/answer`, { token: ctx.session, body: { option_id: "own", version: v2 } });
  await deliverer.sync();
  await deliverer.sync();
  assert.equal(sent.length, 2);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id2}`, { token: ctx.session })).json.delivery, "unknown");
  await client.close();
});

test("call-bridge: 送信の途中でサーバーが止まった配送は、起動し直した時に unknown にして送り直さない", async () => {
  const ctx = setup();
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "GrokBot" } });
  ctx.callBridgeConnections.add(issued.json.id);
  const client = await mcpClient(ctx, issued.json.token);
  const who = { requester_id: "member-1", requester_name: "ネオン" };
  const first = await tool(client, "request_decision", { ...ask, ...who });
  const id = (await tool(client, "request_decision", { ...ask, ...who, check_token: first.structuredContent!.check_token })).structuredContent!.decision_id as string;
  const version = (await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.version;
  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "biz", version } });
  ctx.decisions.markSending(id);

  const sent: string[] = [];
  const deliverer = new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, async (_m, decisionId) => { sent.push(decisionId); return { state: "delivered" }; }, ctx.callBridgeConnections);
  await deliverer.sync();
  assert.deepEqual(sent, []);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.delivery, "unknown");
  await client.close();
});
