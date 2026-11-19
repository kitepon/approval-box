import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createSign, generateKeyPairSync, verify } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { type Jwk, resetKeyCache } from "../src/oidc.ts";
import { Play } from "../src/play.ts";
import { Stripe } from "../src/stripe.ts";

const PACKAGE = "dev.kitepon.approvalbox";
const PRODUCT = "approvalbox_monthly";
const AUDIENCE = "https://kb.test/v1/play/notifications";
const PUSH_EMAIL = "push@project.iam.gserviceaccount.com";
const SA_EMAIL = "play@project.iam.gserviceaccount.com";
const DAY = 86400_000;
const PENDING = "ACKNOWLEDGEMENT_STATE_PENDING";
const ACKED = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Googleの代役（OAuth・購入の読み取り・承認）と、Pub/Subのpushに付くOIDC。購入の中身はテストが subs で書き換える。 */
function setup(options: { play?: boolean } = {}) {
  resetKeyCache();
  const serviceKey = rsa();
  const pushKey = rsa();
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const subs = new Map<string, Record<string, unknown>>();
  const acks: { productId: string; token: string; auth: string; body: string }[] = [];
  const state = { tokenCalls: 0, readStatus: 0, ackStatus: 0 };
  const fake = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (u.origin + u.pathname === "https://oauth2.googleapis.com/token") {
      state.tokenCalls++;
      const form = new URLSearchParams(String(init.body));
      const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), serviceKey.publicKey, Buffer.from(s, "base64url")));
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      assert.equal(claims.iss, SA_EMAIL);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      return json({ access_token: "ya29.test", expires_in: 3600 });
    }
    const auth = String((init.headers as Record<string, string>).authorization);
    assert.equal(auth, "Bearer ya29.test");
    const base = `/androidpublisher/v3/applications/${PACKAGE}/`;
    assert.ok(u.pathname.startsWith(base), u.pathname);
    const rest = decodeURIComponent(u.pathname.slice(base.length));
    const read = rest.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (read) {
      if (state.readStatus) return json({ error: { status: "UNAVAILABLE" } }, state.readStatus);
      return subs.has(read[1]!) ? json(subs.get(read[1]!)) : json({ error: { status: "NOT_FOUND" } }, 404);
    }
    const ack = rest.match(/^purchases\/subscriptions\/([^/]+)\/tokens\/(.+):acknowledge$/);
    if (ack) {
      if (state.ackStatus) return json({ error: { status: "INTERNAL" } }, state.ackStatus);
      acks.push({ productId: ack[1]!, token: ack[2]!, auth, body: String(init.body) });
      subs.set(ack[2]!, { ...subs.get(ack[2]!), acknowledgementState: ACKED });
      return new Response("", { status: 200 });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  const keys = async (): Promise<Jwk[]> => [{ ...(pushKey.publicKey.export({ format: "jwk" }) as object), kid: "push-1" } as Jwk];
  const play = new Play(db, accounts, {
    packageName: PACKAGE, productIds: [PRODUCT], serviceAccount: { client_email: SA_EMAIL, private_key: serviceKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string },
    pushAudience: AUDIENCE, pushServiceAccount: PUSH_EMAIL, fetch: fake, keys,
  });
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test", ...(options.play === false ? {} : { play }) });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, body?: unknown, token: string | null = session) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const verifyCall = (token = "tok_1", productId = PRODUCT) => call("POST", "/v1/billing/play/verify", { product_id: productId, purchase_token: token });
  /** Pub/Subのpushに付くOIDC token（署名はテストの鍵）。 */
  const pushToken = (claims: Record<string, unknown> = {}, key = pushKey.privateKey) => {
    const input = `${b64({ alg: "RS256", kid: "push-1", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: AUDIENCE, sub: "1234", email: PUSH_EMAIL, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(key).toString("base64url")}`;
  };
  const notify = async (event: unknown, opts: { token?: string | null; raw?: string } = {}) => {
    const token = opts.token === undefined ? pushToken() : opts.token;
    const body = opts.raw ?? JSON.stringify({ message: { data: Buffer.from(JSON.stringify(event)).toString("base64"), messageId: "1" }, subscription: "projects/p/subscriptions/s" });
    const res = await app.request("/v1/play/notifications", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });
    return { status: res.status, json: await res.json() as any };
  };
  const event = (token = "tok_1", fields: Record<string, unknown> = {}) => ({
    version: "1.0", packageName: PACKAGE, eventTimeMillis: String(Date.now()),
    subscriptionNotification: { version: "1.0", notificationType: 3, purchaseToken: token, subscriptionId: PRODUCT }, ...fields,
  });
  const sub = (fields: Record<string, unknown> = {}, owner = userId) => ({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: PENDING,
    lineItems: [{ productId: PRODUCT, expiryTime: new Date(Date.now() + 30 * DAY).toISOString() }],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: owner }, ...fields,
  });
  const verified = (id = userId) => run(db, "update users set setup_verified_at = ? where id = ?", new Date().toISOString(), id);
  const me = async () => (await call("GET", "/v1/me")).json;
  return { db, accounts, app, call, verifyCall, notify, pushToken, event, sub, subs, acks, state, userId, session, verified, me, rsa };
}

test("Play: 確認後に購入を照合し、契約中・google_play・期末にして、承認を一度だけ送る", async () => {
  const t = setup();
  t.verified();
  const s = t.sub();
  t.subs.set("tok_1", s);
  const res = await t.verifyCall();
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.plan, "active");
  assert.equal(res.json.store, "google_play");
  assert.equal(res.json.expires_at, (s.lineItems as any)[0].expiryTime);
  assert.equal(t.acks.length, 1);
  assert.deepEqual([t.acks[0]!.productId, t.acks[0]!.token, t.acks[0]!.body], [PRODUCT, "tok_1", "{}"]);
  // 承認済みになった購入を送り直しても、承認はもう送らず、OAuthも使い回す
  assert.equal((await t.verifyCall()).status, 200);
  assert.equal(t.acks.length, 1);
  assert.equal(t.state.tokenCalls, 1);
  assert.equal((await t.me()).store, "google_play");
});

test("Play: 扱わない商品・商品と合わない購入・Googleが知らないトークンは400", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  assert.equal((await t.verifyCall("tok_1", "other_product")).json.error.code, "validation_failed");
  t.subs.set("tok_2", t.sub({ lineItems: [{ productId: "other_product", expiryTime: new Date(Date.now() + DAY).toISOString() }] }));
  assert.equal((await t.verifyCall("tok_2")).json.error.code, "validation_failed");
  assert.equal((await t.verifyCall("tok_missing")).status, 400);
  assert.equal((await t.call("POST", "/v1/billing/play/verify", { product_id: PRODUCT })).status, 400);
  assert.equal((await t.me()).plan, "trial");
});

test("Play: 別のアカウントの印が付いた購入・別のアカウントに結ばれた購入は409", async () => {
  const t = setup();
  t.verified();
  const other = t.accounts.createUser();
  t.subs.set("tok_1", t.sub({}, other));
  assert.equal((await t.verifyCall()).json.error.code, "conflict");
  assert.equal((await t.me()).plan, "trial");
  // 印は自分でも、すでに別の利用者へ結ばれたトークンは受け付けない
  t.subs.set("tok_2", t.sub());
  run(t.db, "insert into play_subscriptions (purchase_token, user_id, product_id, state, expires_at, test, updated_at) values ('tok_2', ?, ?, 'ACTIVE', ?, 0, ?)", other, PRODUCT, new Date(Date.now() + DAY).toISOString(), new Date().toISOString());
  assert.equal((await t.verifyCall("tok_2")).json.error.code, "conflict");
  assert.equal(t.acks.length, 0);
});

test("Play: 本物の購入は確認の前に受け付けず、試験用購入（testPurchase）は関門を通す", async () => {
  const t = setup();
  t.subs.set("tok_1", t.sub());
  assert.equal((await t.verifyCall()).json.error.code, "setup_not_verified");
  assert.equal(t.acks.length, 0);
  t.subs.set("tok_2", t.sub({ testPurchase: {} }));
  const res = await t.verifyCall("tok_2");
  assert.equal(res.status, 200);
  assert.equal(res.json.plan, "active");
  assert.equal(res.json.store, "google_play");
});

test("Play: 承認に失敗したら500で、記録は残り、送り直すと承認される", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  t.state.ackStatus = 500;
  assert.equal((await t.verifyCall()).status, 500);
  assert.equal((await t.me()).plan, "active");
  t.state.ackStatus = 0;
  assert.equal((await t.verifyCall()).status, 200);
  assert.equal(t.acks.length, 1);
});

test("Play: 払い済みでない購入（保留）は承認せず、契約中にもしない", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }));
  const res = await t.verifyCall();
  assert.equal(res.status, 200);
  assert.equal(res.json.plan, "expired");
  assert.equal(t.acks.length, 0);
});

test("Play通知: 解約（CANCELED）は期末まで契約中、失効（EXPIRED）で期限切れ。Googleから読み直す", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  await t.verifyCall();
  t.subs.set("tok_1", t.sub({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", acknowledgementState: ACKED }));
  assert.equal((await t.notify(t.event())).json.applied, true);
  assert.equal((await t.me()).plan, "active");
  t.subs.set("tok_1", t.sub({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", acknowledgementState: ACKED, lineItems: [{ productId: PRODUCT, expiryTime: new Date(Date.now() - 1000).toISOString() }] }));
  assert.equal((await t.notify(t.event())).json.applied, true);
  const me = await t.me();
  assert.equal(me.plan, "expired");
  assert.equal(me.store, "google_play");
  // 遅れて届いた二重の通知も、今のGoogleの状態を読むので巻き戻らない
  assert.equal((await t.notify(t.event())).json.applied, true);
  assert.equal((await t.me()).plan, "expired");
});

test("Play通知: まだ記録の無い購入は、Googleの印の利用者へ結ぶ（先に通知が届いた時）", async () => {
  const t = setup();
  t.subs.set("tok_1", t.sub());
  assert.equal((await t.notify(t.event())).json.applied, true);
  const me = await t.me();
  assert.equal(me.plan, "active");
  assert.equal(me.store, "google_play");
});

test("Play通知: 送り手を確かめられない通知は401で、何も書かない", async () => {
  const t = setup();
  t.subs.set("tok_1", t.sub());
  const other = t.rsa();
  const bad = [
    null,
    "not.a.jwt",
    t.pushToken({ aud: "https://evil.test/" }),
    t.pushToken({ email: "someone@else.example" }),
    t.pushToken({ email_verified: false }),
    t.pushToken({ email_verified: undefined }),
    t.pushToken({ iss: "https://evil.test" }),
    t.pushToken({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    t.pushToken({}, other.privateKey),
  ];
  for (const token of bad) assert.equal((await t.notify(t.event(), { token })).status, 401, String(token));
  assert.equal((await t.me()).plan, "trial");
  assert.equal(t.state.tokenCalls, 0);
});

test("Play通知: 対象外・読めない・持ち主が合わない通知は、再送されないよう200で受け流す", async () => {
  const t = setup();
  t.subs.set("tok_1", t.sub());
  const ignored = [
    t.event("tok_1", { packageName: "other.app" }),
    { version: "1.0", packageName: PACKAGE, testNotification: { version: "1.0" } },
    { version: "1.0", packageName: PACKAGE, voidedPurchaseNotification: { purchaseToken: "tok_1" } },
    t.event("tok_unknown"),
  ];
  for (const e of ignored) assert.deepEqual((await t.notify(e)).json, { applied: false });
  assert.deepEqual((await t.notify(null, { raw: "{}" })).json, { applied: false });
  assert.deepEqual((await t.notify(null, { raw: "nonsense" })).json, { applied: false });
  // 知らない商品、消えたアカウント、結ばれた持ち主と印が食い違うもの
  t.subs.set("tok_2", t.sub({ lineItems: [{ productId: "other_product", expiryTime: new Date(Date.now() + DAY).toISOString() }] }));
  assert.equal((await t.notify(t.event("tok_2"))).json.applied, false);
  t.subs.set("tok_3", t.sub({}, "00000000-0000-4000-8000-000000000000"));
  assert.equal((await t.notify(t.event("tok_3"))).json.applied, false);
  const other = t.accounts.createUser();
  t.subs.set("tok_4", t.sub({}, other));
  run(t.db, "insert into play_subscriptions (purchase_token, user_id, product_id, state, expires_at, test, updated_at) values ('tok_4', ?, ?, 'EXPIRED', null, 0, ?)", t.userId, PRODUCT, new Date().toISOString());
  assert.equal((await t.notify(t.event("tok_4"))).json.applied, false);
  assert.equal((await t.me()).plan, "trial");
});

test("Play通知: Googleから読めない（接続・障害）時は500で、再送を求める", async () => {
  const t = setup();
  t.subs.set("tok_1", t.sub());
  t.state.readStatus = 503;
  assert.equal((await t.notify(t.event())).status, 500);
  t.state.readStatus = 0;
  assert.equal((await t.notify(t.event())).status, 200);
});

test("Play: サービスアカウントの鍵が使えない時は購入を受け付けず500（記録は書かない）", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  const broken = new Play(t.db, t.accounts, { packageName: PACKAGE, productIds: [PRODUCT], serviceAccount: { client_email: SA_EMAIL, private_key: "not a key" }, pushAudience: AUDIENCE, pushServiceAccount: PUSH_EMAIL, fetch: (async () => { throw new Error("unreachable"); }) as unknown as typeof fetch });
  await assert.rejects(() => broken.verifyPurchase(t.userId, PRODUCT, "tok_1"), (e: any) => e.code === "internal");
  assert.equal((await t.me()).plan, "trial");
});

test("Play: 設定が無いサーバーでは、購入の窓口も通知も404（購入は確認前の関門が先）", async () => {
  const t = setup({ play: false });
  assert.equal((await t.verifyCall()).json.error.code, "setup_not_verified");
  t.verified();
  assert.equal((await t.verifyCall()).status, 404);
  assert.equal((await t.notify(t.event())).status, 404);
  // 窓口の置き場だったprefixの知らないpathは、JSONの404
  assert.equal((await t.call("POST", "/v1/billing/unknown/verify")).status, 404);
});

test("Play: BellTeamの許可（client session）は購入を照合できない", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  const { session } = t.accounts.issueSession(t.userId, "BellTeam", "bellteam");
  assert.equal((await t.call("POST", "/v1/billing/play/verify", { product_id: PRODUCT, purchase_token: "tok_1" }, session)).status, 403);
});

test("App StoreとPlayが両方ある時は、期末が遅い方が決める", async () => {
  const t = setup();
  t.verified();
  run(t.db, "insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, revoked, updated_at) values ('1', ?, 'Sandbox', 'p', ?, 0, ?)",
    t.userId, new Date(Date.now() + 5 * DAY).toISOString(), new Date().toISOString());
  t.accounts.syncPlan(t.userId);
  assert.equal((await t.me()).store, "app_store");
  t.subs.set("tok_1", t.sub());
  await t.verifyCall();
  assert.equal((await t.me()).store, "google_play");
  t.subs.set("tok_1", t.sub({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", acknowledgementState: ACKED }));
  await t.notify(t.event());
  const me = await t.me();
  assert.equal(me.plan, "active");
  assert.equal(me.store, "app_store");
});

test("Playの契約の記録があれば、Stripeの無料期間は付けない", async () => {
  const t = setup();
  t.verified();
  const sent: URLSearchParams[] = [];
  const stripeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.test/c/cs_1" }));
  }) as unknown as typeof fetch;
  const stripe = new Stripe(t.db, t.accounts, { secretKey: "rk_test", webhookSecret: "whsec_test", priceId: "price_1", publicUrl: "https://kb.test", fetch: stripeFetch });
  await stripe.checkout(t.userId);
  assert.equal(sent[0]!.get("subscription_data[trial_period_days]"), "30");
  // 期限切れのPlay契約でも、記録があれば無料期間は一度きり
  t.subs.set("tok_1", t.sub({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: PRODUCT, expiryTime: new Date(Date.now() - DAY).toISOString() }] }));
  await t.verifyCall();
  await stripe.checkout(t.userId);
  assert.equal(sent[1]!.get("subscription_data[trial_period_days]"), null);
});

test("Play: アカウントを削除すると記録も消える", async () => {
  const t = setup();
  t.verified();
  t.subs.set("tok_1", t.sub());
  await t.verifyCall();
  assert.equal((await t.call("DELETE", "/v1/me")).status, 200);
  assert.equal((await t.notify(t.event())).json.applied, false);
});
