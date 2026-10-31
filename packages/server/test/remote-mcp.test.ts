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
  assert.equal("requester_id" in (request.inputSchema.properties ?? {}), false, "call-bridge で届けない接続には、通話の届け先（requester_id）を求めない");
  // 誰から・何の仕事かは、どの接続でも道具の一覧で必須にして求める（クオの指摘 2026-10-14）。
  assert.match(request.description!, /unai.*承認の対象・範囲・費用・危険・期限・未確認事項を保つ/);
  assert.deepEqual(request.inputSchema.required, ["title", "options", "requester_name", "session_label"]);

  const named = { ...ask, requester_name: "Claude" };
  const first = await tool(client, "request_decision", named);
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent?.error, "confirm_required");
  const created = await tool(client, "request_decision", { ...named, check_token: first.structuredContent!.check_token });
  assert.equal(created.isError, undefined);
  const id = created.structuredContent!.decision_id as string;
  assert.match(created.content[0]!.text, /get_decision/);
  // 利用者はIDを知らない。件名を先に書き、件名で伝えるよう添える。
  assert.ok(created.content[0]!.text.startsWith(`申請しました: 「経費の区分を決めてほしい」（申請のID: ${id}）。利用者へこの申請の話をする時は、件名で伝えてください。`), created.content[0]!.text);

  const app = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
  assert.equal(app.json.source.via, "remote");
  assert.equal(app.json.source.session_label, "Claude / Books 確認");
  assert.equal(app.json.source.requester, "Claude");
  assert.equal(app.json.source.work_label, "Books 確認");
  assert.equal(app.json.source.connection_label, "Claude.ai");

  // 道具の一覧を古いまま持つ client は名前を送らない。その申請も受け付け、作業名だけを出す。
  const legacy = await tool(client, "request_decision", { ...ask, title: "名前なしの件", check_token: (await tool(client, "request_decision", { ...ask, title: "名前なしの件" })).structuredContent!.check_token });
  assert.equal(legacy.isError, undefined);
  const legacySource = (await ctx.call("GET", `/v1/decisions/${legacy.structuredContent!.decision_id}`, { token: ctx.session })).json.source;
  assert.equal(legacySource.session_label, "Books 確認");
  assert.equal("requester" in legacySource, false);
  await tool(client, "cancel_decision", { decision_id: legacy.structuredContent!.decision_id, reason: "試験の片付け" });
  // 名前を持たないAIは空文字で出す。申請者を付けず、作業名だけを出す。
  const nameless = await tool(client, "request_decision", { ...ask, title: "名前を持たないAIの件", requester_name: " ", check_token: (await tool(client, "request_decision", { ...ask, title: "名前を持たないAIの件", requester_name: " " })).structuredContent!.check_token });
  assert.equal(nameless.isError, undefined, JSON.stringify(nameless));
  const namelessSource = (await ctx.call("GET", `/v1/decisions/${nameless.structuredContent!.decision_id}`, { token: ctx.session })).json.source;
  assert.equal(namelessSource.session_label, "Books 確認");
  assert.equal("requester" in namelessSource, false);
  await tool(client, "cancel_decision", { decision_id: nameless.structuredContent!.decision_id, reason: "試験の片付け" });

  const dup = await tool(client, "request_decision", { ...named, check_token: (await tool(client, "request_decision", named)).structuredContent!.check_token });
  assert.equal(dup.structuredContent?.error, "duplicate_suspected");

  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "own", text: "synthetic-private-remote-answer", version: app.json.version } });
  const got = await tool(client, "get_decision", { decision_id: id });
  assert.match(got.content[0]!.text, /答え: 私用/);
  assert.match(got.content[0]!.text, /synthetic-private-remote-answer/);
  assert.equal(got.structuredContent!.delivery, "fetched");

  const listedMine = await tool(client, "list_my_decisions");
  assert.equal(listedMine.structuredContent!.items.length, 3, "答えた申請と、取り下げた名前なしの申請2つ");
  assert.match(listedMine.content[0]!.text, /「経費の区分を決めてほしい」 status=answered version=\d+ 申請者=Claude 作業=Books 確認/);
  assert.doesNotMatch(JSON.stringify(listedMine), /synthetic-private-remote-answer|Amazonの購入1件/);
  assert.equal(listedMine.structuredContent!.items.find((item: { decision_id: string }) => item.decision_id === id).has_answer, true);
  const nextCheck = await tool(client, "request_decision", { ...named, title: "次の申請" });
  assert.equal(nextCheck.structuredContent!.error, "confirm_required");
  assert.doesNotMatch(JSON.stringify(nextCheck), /synthetic-private-remote-answer|Amazonの購入1件/);
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
  assert.deepEqual(request.inputSchema.required, ["title", "options", "requester_name", "session_label", "requester_id"]);

  const missing = await tool(client, "request_decision", ask);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /requester_id/);

  const who = { requester_id: "cb85c77c-83de-4a84-bb58-85f1e9797cd4", requester_name: "モダニア" };
  const first = await tool(client, "request_decision", { ...ask, ...who });
  const created = await tool(client, "request_decision", { ...ask, ...who, check_token: first.structuredContent!.check_token });
  const id = created.structuredContent!.decision_id as string;
  assert.match(created.content[0]!.text, /通話であなたへ届きます/);

  const app = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
  // 共有の接続なので、名前がAIの自己申告だと分かる形で出す（今までと同じ表示）。分けた項目には、名前と作業名をそのまま入れる。
  assert.equal(app.json.source.session_label, "モダニア（申告） / Books 確認");
  assert.equal(app.json.source.requester, "モダニア");
  assert.equal(app.json.source.work_label, "Books 確認");

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

test("call-bridgeの一時切断は永続待機、再起動後も期日前再送せず回復時に一回配送", async () => {
  const ctx = setup();
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "GrokBot" } });
  ctx.callBridgeConnections.add(issued.json.id);
  const client = await mcpClient(ctx, issued.json.token);
  const who = { requester_id: "actor", requester_name: "test" };
  const first = await tool(client, "request_decision", { ...ask, ...who });
  const id = (await tool(client, "request_decision", { ...ask, ...who, check_token: first.structuredContent!.check_token })).structuredContent!.decision_id as string;
  const version = (await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.version;
  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "biz", version } });
  let attempts = 0;
  const send = async (): Promise<SendResult> => (++attempts === 1 ? { state: "retry", retry_after_seconds: 30 } : { state: "delivered" });
  const firstRun = new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, send, ctx.callBridgeConnections);
  await firstRun.sync();
  assert.equal(attempts, 1);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.delivery, "waiting");
  const restarted = new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, send, ctx.callBridgeConnections);
  await restarted.sync();
  assert.equal(attempts, 1);
  assert.match(ctx.db.prepare("select delivery_detail from decisions where id=?").get(id)!.delivery_detail as string, /^retry_at:/);
  ctx.db.prepare("update decisions set delivery_detail='retry_at:2000-01-01T00:00:00.000Z' where id=?").run(id);
  await restarted.sync(); await restarted.sync();
  assert.equal(attempts, 2);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.delivery, "delivered");
  assert.equal(ctx.decisions.markSending(id), false);
  ctx.decisions.deferServerDelivery(id, 30);
  assert.equal((await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.delivery, "delivered");
  await client.close();
});


test("call-bridge一時切断の再試行期限は回答時刻から10分、再起動でも延長しない", async () => {
  const ctx = setup();
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "GrokBot" } });
  ctx.callBridgeConnections.add(issued.json.id);
  const client = await mcpClient(ctx, issued.json.token);
  const args = { ...ask, requester_id: "actor", requester_name: "test" };
  const first = await tool(client, "request_decision", args);
  const id = (await tool(client, "request_decision", { ...args, check_token: first.structuredContent!.check_token })).structuredContent!.decision_id as string;
  const version = (await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.version;
  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "biz", version } });
  ctx.db.prepare("update decisions set answer=json_set(answer,'$.answered_at','2000-01-01T00:00:00.000Z') where id=?").run(id);
  let attempts = 0;
  const send = async (): Promise<SendResult> => { attempts++; return { state: "retry", retry_after_seconds: 30 }; };
  await new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, send, ctx.callBridgeConnections).sync();
  await new CallBridgeDeliverer(ctx.db, ctx.decisions, ctx.events, send, ctx.callBridgeConnections).sync();
  assert.equal(attempts, 1);
  const decision = (await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json;
  assert.equal(decision.delivery, "unknown");
  assert.equal(decision.status, "answered");
  assert.equal(decision.answer.option_id, "biz");
  await client.close();
});
