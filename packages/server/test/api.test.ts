import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb, run } from "../src/db.ts";
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
  return { db, app, accounts, call, session, userId };
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

/** 申請する。1回目は一覧と確認の札が返るので、札を付けて出し直す。 */
async function submit(ctx: ReturnType<typeof setup>, token: string, body: Record<string, unknown>) {
  const first = await ctx.call("POST", "/connector/v1/decisions", { token, body });
  assert.equal(first.status, 409);
  assert.equal(first.json.error.code, "confirm_required");
  return ctx.call("POST", "/connector/v1/decisions", { token, body: { ...body, check_token: first.json.error.check_token } });
}

const request = { title: "DBの移行をいま実行してよいか", context: "停止は30秒", options: [{ id: "a", label: "いま実行" }, { id: "b", label: "夜間" }], recommendation: "b", urgency: "high", session_label: "approval-box / server", client: "claude-code", route: { channel_id: "ch-1", harness: "claude" } };

test("同じIdempotency-Keyの同時回答は同じ成功応答を返し、保存は1回に留める", async (t) => {
  const ctx = setup(), token = await paired(ctx);
  t.after(() => ctx.db.close());
  const created = await submit(ctx, token, request);
  const id = created.json.decision_id;
  const key = "22222222-2222-4222-8222-222222222222";
  const options = { token: ctx.session, body: { option_id: "a", text: "同じ回答", version: 1 }, headers: { "idempotency-key": key } };
  const responses = await Promise.all([
    ctx.call("POST", `/v1/decisions/${id}/answer`, options),
    ctx.call("POST", `/v1/decisions/${id}/answer`, options),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(responses[0]!.json, responses[1]!.json);
  assert.equal(responses[0]!.json.answer.text, options.body.text);
  assert.equal(ctx.db.prepare("select count(*) n from history where decision_id=? and kind='answered'").get(id)?.n, 1);
  assert.equal(ctx.db.prepare("select status from idempotency where user_id=? and key=?").get(ctx.userId, key)?.status, 200);
});


test("一覧は時差と小数秒を含む期限の実時刻順にし、急ぎ度・保留・期限なし・ページ送りを保つ", async () => {
  const ctx = setup(), token = await paired(ctx);
  const cases = [
    { title: "期限なし通常", urgency: "normal" },
    { title: "一時UTC", deadline: "2026-10-27T01:00:00Z" },
    { title: "翌日表記の十時UTC", deadline: "2026-10-28T00:00:00+14:00" },
    { title: "細かい小数秒の後", deadline: "2026-10-27T00:30:00.0002Z" },
    { title: "同時刻の古い申請", deadline: "2026-10-27T00:40:00.1Z" },
    { title: "九時UTC", deadline: "2026-10-27T04:00:00-05:00" },
    { title: "細かい小数秒の先", deadline: "2026-10-27T09:30:00.000100+09:00" },
    { title: "保留の零時UTC", deadline: "2026-10-27T09:00:00+09:00", held: true },
    { title: "同時刻の新しい申請", deadline: "2026-10-27T09:40:00.100+09:00" },
    { title: "急ぎ度highの期限なし", urgency: "high" },
    { title: "急ぎ度lowの早い期限", urgency: "low", deadline: "2026-10-26T00:00:00Z" },
  ];
  for (const [index, item] of cases.entries()) {
    const created = await submit(ctx, token, { ...request, title: item.title, urgency: item.urgency ?? "normal", ...(item.deadline ? { deadline: item.deadline } : {}) });
    assert.equal(created.status, 200);
    const id = created.json.decision_id;
    run(ctx.db, "update decisions set created_at=? where id=?", `2026-10-26T00:00:00.${String(index).padStart(3, "0")}Z`, id);
    if (item.held) assert.equal((await ctx.call("POST", `/v1/decisions/${id}/hold`, { token: ctx.session })).status, 200);
  }
  const expected = ["急ぎ度highの期限なし", "保留の零時UTC", "細かい小数秒の先", "細かい小数秒の後", "同時刻の古い申請", "同時刻の新しい申請", "一時UTC", "九時UTC", "翌日表記の十時UTC", "期限なし通常", "急ぎ度lowの早い期限"];
  const full = await ctx.call("GET", "/v1/decisions?status=pending,held", { token: ctx.session });
  assert.equal(full.status, 200);
  assert.deepEqual(full.json.items.map((d: { title: string }) => d.title), expected);
  for (const item of cases) {
    const listed = full.json.items.find((d: { title: string }) => d.title === item.title);
    assert.equal(listed.deadline, item.deadline);
    assert.equal(listed.status, item.held ? "held" : "pending");
  }
  const pages: string[] = [];
  let cursor = "0";
  do {
    const page = await ctx.call("GET", `/v1/decisions?status=pending,held&limit=3&cursor=${cursor}`, { token: ctx.session });
    assert.equal(page.status, 200);
    pages.push(...page.json.items.map((d: { title: string }) => d.title));
    cursor = page.json.next_cursor;
  } while (cursor !== undefined);
  assert.deepEqual(pages, expected);
});

test("時差付き期限の修正は一覧へ反映し、既決の一覧は更新日時の新しい順を保つ", async () => {
  const ctx = setup(), token = await paired(ctx);
  const first = await submit(ctx, token, { ...request, title: "先に出した申請", deadline: "2026-10-27T02:00:00Z" });
  const second = await submit(ctx, token, { ...request, title: "後に出した申請", deadline: "2026-10-27T01:00:00Z" });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const id = first.json.decision_id, otherId = second.json.decision_id;
  const amended = await ctx.call("POST", `/connector/v1/decisions/${id}/amend`, { token, body: { version: 1, note: "期限を早める", changes: { deadline: "2026-10-27T09:00:00+09:00" } } });
  assert.equal(amended.status, 200);
  const list = await ctx.call("GET", "/v1/decisions", { token: ctx.session });
  assert.deepEqual(list.json.items.map((d: { id: string }) => d.id), [id, otherId]);
  assert.equal(list.json.items[0].deadline, "2026-10-27T09:00:00+09:00");
  assert.equal((await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { version: 2, option_id: "a" } })).status, 200);
  assert.equal((await ctx.call("POST", `/connector/v1/decisions/${otherId}/cancel`, { token, body: { reason: "不要" } })).status, 200);
  run(ctx.db, "update decisions set updated_at=? where id=?", "2026-10-26T01:00:00Z", id);
  run(ctx.db, "update decisions set updated_at=? where id=?", "2026-10-26T02:00:00Z", otherId);
  const closed = await ctx.call("GET", "/v1/decisions?status=answered,cancelled", { token: ctx.session });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.json.items.map((d: { id: string }) => d.id), [otherId, id]);
});

test("申請・重複検知・修正・回答・配送", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const created = await submit(ctx, token, request);
  assert.equal(created.status, 200);
  const id = created.json.decision_id;
  assert.match(id, /^K-[A-Z2-9]{6}$/);

  const dup = await submit(ctx, token, { ...request, title: "ＤＢの移行を いま実行してよいか？" });
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

test("申請はまず一覧を返して確かめさせ、札を付けて出し直した時だけ受け付ける", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const old = (await submit(ctx, token, { ...request, title: "npmへ0.1.5を公開する承認" })).json.decision_id;

  const first = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...request, title: "npmへ0.1.6を公開する承認" } });
  assert.equal(first.status, 409);
  assert.equal(first.json.error.code, "confirm_required");
  assert.deepEqual(first.json.error.decisions.map((d: { decision_id: string }) => d.decision_id), [old]);
  assert.equal((await ctx.call("GET", "/v1/decisions?status=pending,held", { token: ctx.session })).json.items.length, 1);

  // 取り下げるかはAIが決める。サーバーは中身を見ない。
  await ctx.call("POST", `/connector/v1/decisions/${old}/cancel`, { token, body: { reason: "0.1.6に出し直す" } });
  const body = { ...request, title: "npmへ0.1.6を公開する承認", check_token: first.json.error.check_token };
  const created = await ctx.call("POST", "/connector/v1/decisions", { token, body });
  assert.equal(created.status, 200);

  // 札は1回きり。他の接続の札も使えない。
  const reused = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...body, title: "別の件" } });
  assert.equal(reused.json.error.code, "confirm_required");
  assert.match(reused.json.error.message, /古いか、もう使われています/);
  const other = await (async () => {
    const start = await ctx.call("POST", "/connector/v1/pairing", { body: { device_name: "pc2", os: "linux", clients: ["codex"] } });
    const lookup = await ctx.call("GET", `/v1/pairing/lookup?code=${start.json.code.replace("-", "")}`, { token: ctx.session });
    await ctx.call("POST", `/v1/pairing/${lookup.json.pairing_id}/claim`, { token: ctx.session });
    return (await ctx.call("GET", `/connector/v1/pairing/${start.json.pairing_id}`, { headers: { "x-poll-secret": start.json.poll_secret } })).json.token as string;
  })();
  const stolen = await ctx.call("POST", "/connector/v1/decisions", { token: other, body: { ...body, title: "別の件", check_token: reused.json.error.check_token } });
  assert.equal(stolen.json.error.code, "confirm_required");
  assert.deepEqual(stolen.json.error.decisions, []);
});

test("他の接続の申請は見えない", async () => {
  const ctx = setup();
  const a = await paired(ctx);
  const b = await paired(ctx);
  const created = await submit(ctx, a, request);
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
  const a = await submit(ctx, token, request);
  await submit(ctx, token, { ...request, title: "別の件" });
  await ctx.call("POST", `/v1/decisions/${a.json.decision_id}/answer`, { token: ctx.session, body: { option_id: "a", version: 1 } });
  const deleted = await ctx.call("DELETE", "/v1/decisions?status=answered,cancelled", { token: ctx.session });
  assert.equal(deleted.json.deleted, 1);
  const open = await ctx.call("GET", "/v1/decisions", { token: ctx.session });
  assert.equal(open.json.items.length, 1);
});

test("接続トークンを発行・一覧・失効でき、登録手順と知らないAPIはJSONで返る", async () => {
  const ctx = setup();
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "server" } });
  assert.equal(issued.status, 200);
  assert.match(issued.json.setup_command, /^npx -y approval-box@latest setup --server https:\/\/kb\.test --token kbt_/);
  const conn = await ctx.call("GET", "/connector/v1/connection", { token: issued.json.token });
  assert.equal(conn.status, 200);
  const list = await ctx.call("GET", "/v1/tokens", { token: ctx.session });
  assert.deepEqual(list.json.map((t: { id: string }) => t.id), [issued.json.id]);
  assert.equal(list.json[0].token, undefined);
  const conns = await ctx.call("GET", "/v1/connections", { token: ctx.session });
  assert.equal(conns.json.find((c: { id: string }) => c.id === issued.json.id).kind, "device");
  assert.equal((await ctx.call("DELETE", `/v1/tokens/${issued.json.id}`, { token: ctx.session })).status, 200);
  assert.equal((await ctx.call("GET", "/connector/v1/connection", { token: issued.json.token })).status, 401);
  const guide = await ctx.call("GET", "/v1/onboarding", { token: ctx.session });
  assert.deepEqual(guide.json.map((g: { client: string }) => g.client), ["claude-code", "codex", "cursor", "grok"]);
  assert.ok(guide.json[0].steps.some((s: { copy?: string }) => s.copy === "Approval Boxのsetup_testを実行して"));
  const unknown = await ctx.call("GET", "/v1/nope", { token: ctx.session });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "not_found");
  const other = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "other" } });
  assert.equal((await ctx.call("GET", "/connector/v1/nope", { token: other.json.token })).status, 404);
});

test("通知の端末を登録でき、同じtokenは同じidになり、解除できる", async () => {
  const ctx = setup();
  const a = await ctx.call("POST", "/v1/devices", { token: ctx.session, body: { platform: "ios", apns_token: "abc", apns_env: "sandbox" } });
  assert.equal(a.status, 200);
  const b = await ctx.call("POST", "/v1/devices", { token: ctx.session, body: { platform: "ios", apns_token: "abc", apns_env: "production" } });
  assert.equal(b.json.id, a.json.id);
  assert.equal((await ctx.call("POST", "/v1/devices", { token: ctx.session, body: { platform: "android" } })).status, 400);
  assert.equal((await ctx.call("DELETE", `/v1/devices/${a.json.id}`, { token: ctx.session })).status, 200);
  assert.equal((await ctx.call("DELETE", `/v1/devices/${a.json.id}`, { token: ctx.session })).status, 404);
});

test("Sign in with Apple: 確かめたtokenで入り、同じApple IDは同じアカウント、ログイン済みなら結ぶ", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { resetKeyCache } = await import("../src/oidc.ts");
  resetKeyCache();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const tokenFor = (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid: "k1" })}.${enc({ iss: "https://appleid.apple.com", aud: "dev.kitepon.approvalbox", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
  };
  const db = (await import("../src/db.ts")).openDb(":memory:");
  const { EventHub } = await import("../src/events.ts");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test", appleAudiences: ["dev.kitepon.approvalbox"], googleAudiences: ["g-client"], idKeys: async () => [jwk as never] });
  const post = async (identity_token: string, extra: Record<string, unknown> = {}, session?: string) => {
    const res = await app.request("/v1/auth/apple", { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify({ identity_token, ...extra }) });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const first = await post(tokenFor({ sub: "apple-1" }));
  assert.equal(first.status, 200);
  const second = await post(tokenFor({ sub: "apple-1" }));
  assert.equal(second.json.user.id, first.json.user.id);
  assert.equal((await post(tokenFor({ sub: "apple-1", aud: "other.app" }))).status, 401);
  assert.equal((await post(tokenFor({ sub: "apple-1", exp: 1 }))).status, 401);
  assert.equal((await post(tokenFor({ sub: "apple-1", nonce: "n1" }), { nonce: "n2" })).status, 401);
  assert.equal((await post(tokenFor({ sub: "apple-1", nonce: "n1" }), { nonce: "n1" })).status, 200);
  const tampered = tokenFor({ sub: "apple-1" }).replace(/\.[^.]+\./, (m) => m.slice(0, -2) + "x.");
  assert.equal((await post(tampered)).status, 401);
  // Bearer付きで呼んでも結ばない（ログインはIDごと。クオの裁定）
  const other = accounts.createUser();
  const { session } = accounts.issueSession(other, "admin");
  const viaBearer = await post(tokenFor({ sub: "apple-2" }), {}, session);
  assert.notEqual(viaBearer.json.user.id, other);
  const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${viaBearer.json.session}` } });
  assert.equal(((await me.json()) as { login: string }).login, "apple");
  // Google: 別のIDなので別のアカウントになる
  const gToken = (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid: "k1" })}.${enc({ iss: "https://accounts.google.com", aud: "g-client", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
  };
  const g = await app.request("/v1/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id_token: gToken({ sub: "g-1" }) }) });
  const gj = (await g.json()) as { user: { id: string } };
  assert.equal(g.status, 200);
  assert.notEqual(gj.user.id, first.json.user.id); // 別のIDなら別のアカウント
  const gBad = await app.request("/v1/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id_token: tokenFor({ sub: "g-1" }) }) });
  assert.equal(gBad.status, 401); // Appleの発行者のtokenはGoogleでは通らない
});

test("ブラウザで始めるAppleのログイン: callbackで確かめ、code_verifierと合う時だけ一度きりのコードを使える", async () => {
  const { generateKeyPairSync, sign, createHash, randomBytes } = await import("node:crypto");
  const { resetKeyCache } = await import("../src/oidc.ts");
  resetKeyCache();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "w1", alg: "RS256" };
  const db = (await import("../src/db.ts")).openDb(":memory:");
  const { EventHub } = await import("../src/events.ts");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test", appleAudiences: ["dev.kitepon.approvalbox"], webLogin: { apple_services_id: "dev.kitepon.approvalbox.web" }, idKeys: async () => [jwk as never] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const startAs = async (session?: string) => {
    const res = await app.request("/v1/auth/apple/web/start", { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }) });
    return (await res.json()) as { authorization_url: string; state: string };
  };
  const idToken = (nonce: string, sub: string) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid: "w1" })}.${enc({ iss: "https://appleid.apple.com", aud: "dev.kitepon.approvalbox.web", exp: Math.floor(Date.now() / 1000) + 600, sub, nonce })}`;
    return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
  };
  const callback = async (fields: Record<string, string>) => {
    const res = await app.request("/auth/apple/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    assert.equal(res.status, 303);
    return new URL(res.headers.get("location")!);
  };
  const started = await startAs();
  const auth = new URL(started.authorization_url);
  assert.equal(auth.searchParams.get("redirect_uri"), "https://kb.test/auth/apple/callback");
  const back = await callback({ state: started.state, id_token: idToken(auth.searchParams.get("nonce")!, "apple-w1") });
  assert.equal(back.protocol, "approvalbox:");
  assert.equal(back.searchParams.get("state"), started.state);
  const code = back.searchParams.get("code")!;
  const link = (extra: Record<string, string>) => app.request("/v1/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, ...extra }) });
  assert.equal((await link({})).status, 400); // verifier が無ければ使えない
  assert.equal((await link({ code_verifier: randomBytes(32).toString("base64url") })).status, 401);
  const linked = await link({ code_verifier: verifier });
  assert.equal(linked.status, 200);
  const signed = await linked.json() as { session: string };
  const signedUser = accounts.userBySession(signed.session);
  assert.equal(db.prepare("select link_user_id from auth_flows where state=?").get(started.state)?.link_user_id, signedUser);
  assert.equal((await link({ code_verifier: verifier })).status, 401); // 一度きり
  // 同じ state は二度使えない・nonce違いは通らない
  assert.equal((await callback({ state: started.state, id_token: idToken(auth.searchParams.get("nonce")!, "apple-w1") })).searchParams.get("error"), "unauthorized");
  const s2 = await startAs();
  assert.equal((await callback({ state: s2.state, id_token: idToken("wrong", "apple-w2") })).searchParams.get("error"), "unauthorized");
  // 取り消しは cancelled で戻る
  const s3 = await startAs();
  assert.equal((await callback({ state: s3.state, error: "user_cancelled_authorize" })).searchParams.get("error"), "cancelled");
});

test("確認を求める文に札と一覧が入る（0.1.6までのコネクタは文だけをAIに見せる）", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const created = (await submit(ctx, token, request)).json.decision_id;
  const first = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...request, title: "別の件" } });
  assert.ok(first.json.error.message.includes(first.json.error.check_token));
  assert.ok(first.json.error.message.includes(created));
});

test("会話切替: amendは配送先も更新し、古い版の競合では更新しない", async () => {
  const ctx = setup(); const token = await paired(ctx);
  const created = await submit(ctx, token, request); const id = created.json.decision_id;
  const route = { channel_id: "new-session", harness: "claude" };
  const amended = await ctx.call("POST", `/connector/v1/decisions/${id}/amend`, { token, body: { version: 1, note: "会話を再開", changes: { context: "更新" }, route } });
  assert.equal(amended.status, 200);
  const stale = await ctx.call("POST", `/connector/v1/decisions/${id}/amend`, { token, body: { version: 1, note: "古い呼出", changes: { context: "古い" }, route: request.route } });
  assert.equal(stale.status, 409);
  assert.equal((await ctx.call("GET", `/connector/v1/decisions/${id}?channel_id=new-session`, { token })).json.this_session, true);
  const answered = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "b", version: amended.json.version } });
  assert.equal(answered.status, 200);
  assert.deepEqual((await ctx.call("GET", "/connector/v1/deliveries", { token })).json.items[0].route, route);
});

test("再開: 対象の申請だけ移管し、回答済みはその場で取得、他の接続と取り下げは拒否", async () => {
  const ctx = setup(); const token = await paired(ctx); const other = await paired(ctx);
  const first = await submit(ctx, token, request); const id = first.json.decision_id;
  const second = await submit(ctx, token, { ...request, title: "別の席の申請" });
  const route = { channel_id: "resumed-session", harness: "grok" };
  assert.equal((await ctx.call("POST", `/connector/v1/decisions/${id}/resume`, { token: other, body: route })).status, 404);
  const resumed = await ctx.call("POST", `/connector/v1/decisions/${id}/resume`, { token, body: route });
  assert.equal(resumed.json.this_session, true);
  assert.equal((await ctx.call("GET", `/connector/v1/decisions/${second.json.decision_id}?channel_id=ch-1`, { token })).json.this_session, true);
  const answer = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "b", version: resumed.json.version } });
  assert.equal(answer.status, 200);
  const fetched = await ctx.call("POST", `/connector/v1/decisions/${id}/resume`, { token, body: route });
  assert.equal(fetched.json.delivery, "fetched"); assert.match(fetched.json.answer_text, /夜間/);
  assert.equal((await ctx.call("GET", "/connector/v1/deliveries", { token })).json.items.length, 0);
  await ctx.call("POST", `/connector/v1/decisions/${second.json.decision_id}/cancel`, { token, body: { reason: "不要" } });
  assert.equal((await ctx.call("POST", `/connector/v1/decisions/${second.json.decision_id}/resume`, { token, body: route })).status, 409);
});

test("申請者と作業名: アプリには「誰から / 何の仕事」の一行と、分けた項目の両方を返す", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const view = async (id: string) => (await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session })).json.source;

  // 申請者あり。今のアプリは session_label だけを出すので、そこへ申請者を入れて返す。
  const named = await submit(ctx, token, { ...request, requester: " トロニー ", session_label: "BellTeam / 28回目の入れ替え" });
  assert.equal(named.status, 200);
  assert.equal(named.json.requester, "トロニー");
  assert.equal(named.json.session_label, "BellTeam / 28回目の入れ替え", "AIへは、AIが書いた作業名のまま返す");
  assert.deepEqual(await view(named.json.decision_id), {
    client: "claude-code", session_label: "トロニー / BellTeam / 28回目の入れ替え", work_label: "BellTeam / 28回目の入れ替え",
    requester: "トロニー", connection_label: "dev-pc", via: "connector",
  });

  // 作業名が申請者の名前で始まる時は、二重にしない。
  const doubled = await submit(ctx, token, { ...request, title: "別の件1", requester: "サクラ", session_label: "サクラ / 鍵の片付け" });
  assert.equal((await view(doubled.json.decision_id)).session_label, "サクラ / 鍵の片付け");

  // 申請者を送らない古いコネクタの申請は、今までどおり。
  const legacy = await submit(ctx, token, { ...request, title: "別の件2" });
  assert.equal("requester" in legacy.json, false);
  assert.deepEqual(await view(legacy.json.decision_id), {
    client: "claude-code", session_label: "approval-box / server", work_label: "approval-box / server", connection_label: "dev-pc", via: "connector",
  });

  // 一覧（AI側）にも申請者が付く。同じ接続を分け合う席が、自分の申請を見分けられる。
  const mine = (await ctx.call("GET", "/connector/v1/decisions", { token })).json.items as { title: string; requester?: string }[];
  assert.deepEqual(mine.map((d) => d.requester ?? null).sort(), [null, "サクラ", "トロニー"]);

  const long = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...request, title: "別の件3", requester: "あ".repeat(61) } });
  assert.equal(long.status, 400);
});

test("答えを届ける文は、利用者へ件名で伝えるようAIへ添える", async () => {
  const ctx = setup();
  const token = await paired(ctx);
  const created = await submit(ctx, token, request);
  await ctx.call("POST", `/v1/decisions/${created.json.decision_id}/answer`, { token: ctx.session, body: { option_id: "b", version: 1 } });
  const text = (await ctx.call("GET", "/connector/v1/deliveries", { token })).json.items[0].text as string;
  assert.ok(text.startsWith(`[Approval Box] あなたが request_decision で出した申請 ${created.json.decision_id}「DBの移行をいま実行してよいか」に、利用者が答えました。`), text);
  assert.ok(text.endsWith("利用者へこの申請の話をする時は、件名で伝えてください。アプリには件名・申請者・作業名が出て、申請のIDは出ません。IDは道具を呼ぶ時に使います。"), text);
});

