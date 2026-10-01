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

test("ログインのリンクは一度だけsessionに替えられる", async () => {
  const ctx = setup();
  const link = ctx.accounts.createLoginLink(ctx.userId, "owner", "https://kb.test");
  assert.match(link.url, /^https:\/\/kb\.test\/login#code=kll_/);
  const code = link.url.split("#code=")[1];
  const first = await ctx.call("POST", "/v1/auth/link", { body: { code } });
  assert.equal(first.status, 200);
  const me = await ctx.call("GET", "/v1/me", { token: first.json.session });
  assert.equal(me.json.user_id, ctx.userId);
  const again = await ctx.call("POST", "/v1/auth/link", { body: { code } });
  assert.equal(again.status, 401);
  const wrong = await ctx.call("POST", "/v1/auth/link", { body: { code: "kll_wrong-code-value" } });
  assert.equal(wrong.status, 401);
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

test("固定のログインURLは何度でも使え、作り直すと前のURLは使えない", async () => {
  const ctx = setup();
  const made = await ctx.call("POST", "/v1/me/personal-link", { token: ctx.session });
  const code = made.json.url.split("#code=")[1];
  for (let i = 0; i < 2; i++) assert.equal((await ctx.call("POST", "/v1/auth/link", { body: { code } })).status, 200);
  assert.equal((await ctx.call("GET", "/v1/me/personal-link", { token: ctx.session })).json.exists, true);
  const again = await ctx.call("POST", "/v1/me/personal-link", { token: ctx.session });
  assert.equal((await ctx.call("POST", "/v1/auth/link", { body: { code } })).status, 401);
  assert.equal((await ctx.call("POST", "/v1/auth/link", { body: { code: again.json.url.split("#code=")[1] } })).status, 200);
  await ctx.call("DELETE", "/v1/me/personal-link", { token: ctx.session });
  assert.equal((await ctx.call("GET", "/v1/me/personal-link", { token: ctx.session })).json.exists, false);
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
  // IDの無い既存アカウント（コードで入った人）には、最初の1回だけ結べる
  const owner = accounts.createUser();
  const { session } = accounts.issueSession(owner, "code");
  const linked = await post(tokenFor({ sub: "apple-2" }), {}, session);
  assert.equal(linked.json.user.id, owner);
  assert.equal((await post(tokenFor({ sub: "apple-2" }))).json.user.id, owner);
  assert.equal((await post(tokenFor({ sub: "apple-1" }), {}, session)).status, 409); // 別アカウントのApple ID
  assert.equal((await post(tokenFor({ sub: "apple-3" }), {}, session)).status, 409); // 既にIDがある
  const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${session}` } });
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
  assert.notEqual(gj.user.id, first.json.user.id);
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
  assert.equal((await link({})).status, 401); // verifier が無ければ使えない
  assert.equal((await link({ code_verifier: randomBytes(32).toString("base64url") })).status, 401);
  assert.equal((await link({ code_verifier: verifier })).status, 200);
  assert.equal((await link({ code_verifier: verifier })).status, 401); // 一度きり
  // 同じ state は二度使えない・nonce違いは通らない
  assert.equal((await callback({ state: started.state, id_token: idToken(auth.searchParams.get("nonce")!, "apple-w1") })).searchParams.get("error"), "unauthorized");
  const s2 = await startAs();
  assert.equal((await callback({ state: s2.state, id_token: idToken("wrong", "apple-w2") })).searchParams.get("error"), "unauthorized");
  // 取り消しは cancelled で戻る
  const s3 = await startAs();
  assert.equal((await callback({ state: s3.state, error: "user_cancelled_authorize" })).searchParams.get("error"), "cancelled");
  // IDの無い既存アカウントへ結ぶ（Bearer付きで始める）
  const owner = accounts.createUser();
  const { session } = accounts.issueSession(owner, "code");
  const s4 = await startAs(session);
  const b4 = await callback({ state: s4.state, id_token: idToken(new URL(s4.authorization_url).searchParams.get("nonce")!, "apple-w4") });
  const r4 = await app.request("/v1/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: b4.searchParams.get("code"), code_verifier: verifier }) });
  const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${((await r4.json()) as { session: string }).session}` } });
  const mj = (await me.json()) as { user_id: string; login: string };
  assert.equal(mj.user_id, owner);
  assert.equal(mj.login, "apple");
});
