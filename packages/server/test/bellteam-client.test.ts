import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

function setup() {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test" });
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
  /** 接続を作って申請する（1回目の確認の札を付けて出し直す）。 */
  const file = async (userId_: string, title: string, extra: Record<string, unknown> = {}) => {
    const { token } = accounts.createConnection(userId_, `conn-${title}`, null, []);
    const body = { title, context: "x", options: [{ id: "a", label: "はい" }, { id: "b", label: "いいえ" }], session_label: "w", client: "claude-code", ...extra };
    const first = await call("POST", "/connector/v1/decisions", { token, body });
    const made = await call("POST", "/connector/v1/decisions", { token, body: { ...body, check_token: first.json.error.check_token } });
    assert.equal(made.status, 200);
    return { connectorToken: token, id: made.json.decision_id as string };
  };
  return { db, accounts, call, session, userId, file };
}

/** BellTeamが接続を始め、利用者が承認し、範囲付きsessionを受け取るまで。 */
async function connectBellTeam(ctx: ReturnType<typeof setup>, userSession = ctx.session) {
  const start = await ctx.call("POST", "/connector/v1/pairing", { body: { device_name: "自宅のBellTeam", client: "bellteam" } });
  assert.equal(start.status, 200);
  const lookup = await ctx.call("GET", `/v1/pairing/lookup?code=${start.json.code}`, { token: userSession });
  assert.equal(lookup.json.client, "bellteam");
  assert.equal(lookup.json.client_name, "BellTeam");
  const poll = () => ctx.call("GET", `/connector/v1/pairing/${start.json.pairing_id}`, { headers: { "x-poll-secret": start.json.poll_secret } });
  // 許す相手を表示できない版の画面（confirm_clientなし）からは承認できない。
  assert.equal((await ctx.call("POST", `/v1/pairing/${lookup.json.pairing_id}/claim`, { token: userSession, body: {} })).status, 409);
  const claim = await ctx.call("POST", `/v1/pairing/${lookup.json.pairing_id}/claim`, { token: userSession, body: { confirm_client: "bellteam" } });
  assert.equal(claim.status, 200);
  const got = await poll();
  assert.equal(got.json.status, "claimed");
  assert.match(got.json.session, /^kss_/);
  assert.equal((await poll()).json.status, "delivered");
  return { session: got.json.session as string, start };
}

test("BellTeamは接続を始め、利用者の承認で範囲付きsessionを一度だけ受け取る", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { session, start } = await connectBellTeam(ctx);
  const ahead = Date.parse(start.json.expires_at) - Date.now();
  assert.ok(ahead > 14 * 60_000 && ahead < 16 * 60_000);
  assert.equal((await ctx.call("GET", "/v1/me", { token: session })).status, 200);
  const bad = await ctx.call("POST", "/connector/v1/pairing", { body: { device_name: "x", client: "unknown" } });
  assert.equal(bad.status, 400);
  // 断ると、受け取る側にはrejectedが返り、sessionは作られない。
  const other = await ctx.call("POST", "/connector/v1/pairing", { body: { device_name: "別のBellTeam", client: "bellteam" } });
  await ctx.call("POST", `/v1/pairing/${other.json.pairing_id}/reject`, { token: ctx.session });
  const refused = await ctx.call("GET", `/connector/v1/pairing/${other.json.pairing_id}`, { headers: { "x-poll-secret": other.json.poll_secret } });
  assert.equal(refused.json.status, "rejected");
  assert.equal(ctx.db.prepare("select count(*) n from sessions where client = 'bellteam'").get()?.n, 1);
});

test("範囲付きsessionは別の接続から出た申請も含め全部読め、アプリと同じ形で答えられる", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const a = await ctx.file(ctx.userId, "A", { requester: "ナユタ", requester_bot_id: "bot-4366a50b" });
  const b = await ctx.file(ctx.userId, "B", { requester: "外のAI" });
  const { session } = await connectBellTeam(ctx);
  const list = await ctx.call("GET", "/v1/decisions?status=pending,held,answered,cancelled", { token: session });
  assert.deepEqual(list.json.items.map((d: { id: string }) => d.id).sort(), [a.id, b.id].sort());
  const one = await ctx.call("GET", `/v1/decisions/${a.id}`, { token: session });
  assert.equal(one.json.source.requester_bot_id, "bot-4366a50b");
  assert.equal((await ctx.call("GET", `/v1/decisions/${b.id}`, { token: session })).json.source.requester_bot_id, undefined);
  assert.equal((await ctx.call("POST", `/v1/decisions/${a.id}/hold`, { token: session, headers: { "idempotency-key": "k-hold-1" } })).json.status, "held");
  assert.equal((await ctx.call("POST", `/v1/decisions/${a.id}/unhold`, { token: session, headers: { "idempotency-key": "k-hold-2" } })).json.status, "pending");
  const answered = await ctx.call("POST", `/v1/decisions/${a.id}/answer`, { token: session, body: { option_id: "a", version: one.json.version + 2 }, headers: { "idempotency-key": "k-ans-1" } });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.history.at(-1).by, "user");
});

test("範囲付きsessionは許可表の外を403で断り、接続token（kbt_）とは相互に通らない", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const d = await ctx.file(ctx.userId, "A");
  const { session } = await connectBellTeam(ctx);
  const me = await ctx.call("GET", "/v1/me", { token: session });
  assert.equal(me.json.plan, "trial");
  const denied: [string, string][] = [
    ["GET", "/v1/connections"], ["DELETE", "/v1/connections/x"], ["POST", "/v1/tokens"], ["POST", "/v1/pairing/x/claim"], ["GET", "/v1/pairing/lookup?code=ABCDEFGH"],
    ["DELETE", "/v1/decisions?status=answered,cancelled"], ["DELETE", "/v1/me"], ["PATCH", "/v1/me/settings"], ["GET", "/v1/me/settings"], ["POST", "/v1/devices"],
    ["POST", `/v1/decisions/${d.id}/attachments?name=a.png`], ["POST", "/v1/auth/logout"], ["GET", "/v1/decisions/"],
  ];
  for (const [method, path] of denied) {
    const res = await ctx.call(method, path, { token: session, body: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.json.error.code, "forbidden");
  }
  assert.equal((await ctx.call("GET", "/v1/me", { token: session })).status, 200); // 403は止めただけで、sessionは生きている
  assert.equal((await ctx.call("GET", "/v1/decisions", { token: d.connectorToken })).status, 401);
  assert.equal((await ctx.call("GET", "/connector/v1/connection", { token: session })).status, 401);
});

test("利用者は接続の一覧からBellTeamを外せ、外した後は読めず、使い続ける限り期限は延びる", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { session } = await connectBellTeam(ctx);
  const listed = (await ctx.call("GET", "/v1/connections", { token: ctx.session })).json as { id: string; kind: string; label: string }[];
  const entry = listed.find((c) => c.kind === "client")!;
  assert.equal(entry.label, "BellTeam");
  // 期限が近づいたsessionは、使うと90日へ延びる。
  ctx.db.prepare("update sessions set expires_at = ? where client = 'bellteam'").run(new Date(Date.now() + 40 * 86400_000).toISOString());
  await ctx.call("GET", "/v1/me", { token: session });
  const renewed = Date.parse(ctx.db.prepare("select expires_at from sessions where client = 'bellteam'").get()!.expires_at as string) - Date.now();
  assert.ok(renewed > 89 * 86400_000);
  assert.equal(ctx.accounts.clientSessionActive(entry.id), true);
  assert.equal((await ctx.call("DELETE", `/v1/connections/${entry.id}`, { token: ctx.session })).status, 200);
  assert.equal(ctx.accounts.clientSessionActive(entry.id), false);
  assert.equal((await ctx.call("GET", "/v1/me", { token: session })).status, 401);
  assert.equal((await ctx.call("DELETE", `/v1/connections/${entry.id}`, { token: ctx.session })).status, 404);
});

test("範囲付きsessionは承認した利用者の申請だけを見せ、アカウント削除で消える", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const other = ctx.accounts.createUser();
  const theirs = await ctx.file(other, "他人の申請");
  await ctx.file(ctx.userId, "自分の申請");
  const { session } = await connectBellTeam(ctx);
  const list = await ctx.call("GET", "/v1/decisions?status=pending", { token: session });
  assert.deepEqual(list.json.items.map((d: { title: string }) => d.title), ["自分の申請"]);
  assert.equal((await ctx.call("GET", `/v1/decisions/${theirs.id}`, { token: session })).status, 404);
  assert.equal((await ctx.call("DELETE", "/v1/me", { token: ctx.session })).status, 200);
  assert.equal(ctx.db.prepare("select count(*) n from sessions where client is not null").get()?.n, 0);
});

test("requester_bot_idはBot ID形式だけ受け付ける", async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { token } = ctx.accounts.createConnection(ctx.userId, "c", null, []);
  const bad = await ctx.call("POST", "/connector/v1/decisions", { token, body: { title: "T", context: "x", options: [{ id: "a", label: "1" }, { id: "b", label: "2" }], session_label: "w", client: "codex", requester_bot_id: "not a bot" } });
  assert.equal(bad.status, 400);
});
