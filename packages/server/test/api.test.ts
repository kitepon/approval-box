import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

function setup(billing: "off" | "store" = "store") {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, billing);
  const decisions = new Decisions(db, events);
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test" });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json", ...opts.headers },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { app, accounts, call, session, userId };
}

async function paired(ctx: ReturnType<typeof setup>) {
  const start = await ctx.call("POST", "/connector/v1/pairing", { body: { device_name: "dev-pc", os: "linux", clients: ["claude-code", "codex"] } });
  assert.equal(start.status, 200);
  const lookup = await ctx.call("GET", `/v1/pairing/lookup?code=${start.json.code.toLowerCase().replace("-", "")}`, { token: ctx.session });
  assert.equal(lookup.json.device_name, "dev-pc");
  const claim = await ctx.call("POST", `/v1/pairing/${lookup.json.pairing_id}/claim`, { token: ctx.session });
  assert.equal(claim.status, 200);
  const poll = await ctx.call("GET", `/connector/v1/pairing/${start.json.pairing_id}`, { headers: { "x-poll-secret": start.json.poll_secret } });
  assert.equal(poll.json.status, "claimed");
  const again = await ctx.call("GET", `/connector/v1/pairing/${start.json.pairing_id}`, { headers: { "x-poll-secret": start.json.poll_secret } });
  assert.equal(again.json.status, "delivered");
  return poll.json.token as string;
}

const request = { title: "DBの移行をいま実行してよいか", context: "停止は30秒", options: [{ id: "a", label: "いま実行" }, { id: "b", label: "夜間" }], recommendation: "b", urgency: "high", session_label: "approval-box / server", client: "claude-code", route: { channel_id: "ch-1", harness: "claude" } };

test("申請・重複検知・修正・回答・配送", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const created = await ctx.call("POST", "/connector/v1/decisions", { token, body: request });
  assert.equal(created.status, 200);
  const id = created.json.decision_id;
  assert.match(id, /^K-[A-Z2-9]{6}$/);

  const dup = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...request, title: "ＤＢの移行を いま実行してよいか？" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "duplicate_suspected");
  assert.equal(dup.json.error.existing[0].decision_id, id);

  const mine = await ctx.call("GET", "/connector/v1/decisions?channel_id=ch-1", { token });
  assert.equal(mine.json.items[0].this_session, true);

  const amended = await ctx.call("POST", `/connector/v1/decisions/${id}/amend`, { token, body: { version: 1, note: "停止時間を直した", changes: { context: "停止は60秒" } } });
  assert.equal(amended.json.version, 2);

  const stale = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "a", version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.decision.version, 2);
  assert.deepEqual(stale.json.error.decision.history.at(-1).fields, ["context"]);

  const list = await ctx.call("GET", "/v1/decisions", { token: ctx.session });
  assert.equal(list.json.items.length, 1);

  const headers = { "idempotency-key": "11111111-1111-4111-8111-111111111111" };
  const answered = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "b", text: "夜にやって", version: 2 }, headers });
  assert.equal(answered.json.status, "answered");
  assert.equal(answered.json.delivery, "waiting");
  const replay = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "b", version: 2 }, headers });
  assert.deepEqual(replay.json, answered.json);

  const deliveries = await ctx.call("GET", "/connector/v1/deliveries", { token });
  assert.equal(deliveries.json.items.length, 1);
  assert.match(deliveries.json.items[0].text, /夜間/);
  await ctx.call("POST", `/connector/v1/deliveries/${id}`, { token, body: { state: "delivered" } });
  const after = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
  assert.equal(after.json.delivery, "delivered");
  assert.equal((await ctx.call("GET", "/connector/v1/deliveries", { token })).json.items.length, 0);

  const cancelLate = await ctx.call("POST", `/connector/v1/decisions/${id}/cancel`, { token, body: { reason: "不要" } });
  assert.equal(cancelLate.status, 409);
  assert.equal(cancelLate.json.error.decision.answer.option_id, "b");
});

test("他の接続の申請は見えない", async () => {
  const ctx = setup();
  const a = await paired(ctx);
  const b = await paired(ctx);
  const created = await ctx.call("POST", "/connector/v1/decisions", { token: a, body: request });
  const other = await ctx.call("GET", `/connector/v1/decisions/${created.json.decision_id}`, { token: b });
  assert.equal(other.status, 404);
});

test("セットアップ確認が済むまで課金させない", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const blocked = await ctx.call("POST", "/v1/billing/stripe/checkout", { token: ctx.session });
  assert.equal(blocked.json.error.code, "setup_not_verified");
  const me0 = await ctx.call("GET", "/v1/me", { token: ctx.session });
  assert.equal(me0.json.setup.verified, false);
  assert.equal(me0.json.setup.checks.length, 2);

  const started = await ctx.call("POST", "/connector/v1/setup-test", { token, body: { client: "claude-code", os: "linux", session_label: "test", route: { channel_id: "ch-9", harness: "claude" } } });
  const id = started.json.decision_id;
  await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "ok", version: 1 } });
  const delivery = (await ctx.call("GET", "/connector/v1/deliveries", { token })).json.items[0];
  const code = /確認コード: (\d{6})/.exec(delivery.text)![1]!;
  const wrong = await ctx.call("POST", "/connector/v1/setup-test/confirm", { token, body: { decision_id: id, code: "000000" } });
  assert.equal(wrong.status, 400);
  const ok = await ctx.call("POST", "/connector/v1/setup-test/confirm", { token, body: { decision_id: id, code } });
  assert.equal(ok.json.status, "passed");
  const me = await ctx.call("GET", "/v1/me", { token: ctx.session });
  assert.equal(me.json.setup.verified, true);
  assert.equal(me.json.setup.checks.find((c: { client: string }) => c.client === "claude-code").status, "passed");
  const nowAllowed = await ctx.call("POST", "/v1/billing/stripe/checkout", { token: ctx.session });
  assert.notEqual(nowAllowed.json.error.code, "setup_not_verified");
});

test("既決の削除は未決を残す", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const a = await ctx.call("POST", "/connector/v1/decisions", { token, body: request });
  await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...request, title: "別の件" } });
  await ctx.call("POST", `/v1/decisions/${a.json.decision_id}/answer`, { token: ctx.session, body: { option_id: "a", version: 1 } });
  const deleted = await ctx.call("DELETE", "/v1/decisions?status=answered,cancelled", { token: ctx.session });
  assert.equal(deleted.json.deleted, 1);
  const open = await ctx.call("GET", "/v1/decisions", { token: ctx.session });
  assert.equal(open.json.items.length, 1);
});
