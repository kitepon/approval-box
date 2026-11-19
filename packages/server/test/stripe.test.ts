import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { Stripe } from "../src/stripe.ts";

const WHSEC = "whsec_test";
const DAY = 86400;

/** Stripeの代役。契約の中身は、テストが書き換える subs から返す。 */
function setup(options: { stripeDown?: boolean } = {}) {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store", true);
  const decisions = new Decisions(db, events);
  const subs = new Map<string, Record<string, unknown>>();
  const sent: { method: string; path: string; form: URLSearchParams }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    if (options.stripeDown) throw new Error("down");
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    sent.push({ method: String(init.method), path, form: new URLSearchParams(String(init.body ?? "")) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/checkout/sessions") return json({ id: "cs_1", url: "https://checkout.stripe.test/c/cs_1" });
    if (path === "/billing_portal/sessions") return json({ url: "https://billing.stripe.test/p/1" });
    const id = path.split("/")[2]!;
    if (init.method === "DELETE") { subs.set(id, { ...subs.get(id), status: "canceled" }); return json(subs.get(id)); }
    return subs.has(id) ? json(subs.get(id)) : json({ error: { type: "invalid_request_error" } }, 404);
  }) as unknown as typeof fetch;
  const stripe = new Stripe(db, accounts, { secretKey: "rk_test", webhookSecret: WHSEC, priceId: "price_1", portalConfiguration: "bpc_1", publicUrl: "https://kb.test", fetch: fake });
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test", stripe });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, body?: unknown, token: string | null = session) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const hook = async (event: unknown, opts: { secret?: string; at?: number } = {}) => {
    const raw = JSON.stringify(event);
    const t = String(opts.at ?? Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", opts.secret ?? WHSEC).update(`${t}.${raw}`).digest("hex");
    const res = await app.request("/v1/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body: raw });
    return { status: res.status, json: await res.json() as any };
  };
  const sub = (fields: Record<string, unknown> = {}) => ({
    id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY, price: { id: "price_1" } }] }, metadata: { user_id: userId }, ...fields,
  });
  const verified = () => run(db, "update users set setup_verified_at = ? where id = ?", new Date().toISOString(), userId);
  return { db, accounts, call, hook, sub, subs, sent, userId, session, verified, app };
}

const subscriptionEvent = (type: string, id = "sub_1") => ({ type, data: { object: { id } } });

test("Stripe: 確認前は買えず、確認後は決済のURLを返し、利用者の印を付けて送る", async () => {
  const t = setup();
  assert.equal((await t.call("POST", "/v1/billing/stripe/checkout")).json.error.code, "setup_not_verified");
  t.verified();
  const res = await t.call("POST", "/v1/billing/stripe/checkout");
  assert.equal(res.json.url, "https://checkout.stripe.test/c/cs_1");
  const form = t.sent[0]!.form;
  assert.equal(form.get("client_reference_id"), t.userId);
  assert.equal(form.get("subscription_data[metadata][user_id]"), t.userId);
  assert.equal(form.get("automatic_tax[enabled]"), "true");
  assert.equal(form.get("line_items[0][price]"), "price_1");
  assert.equal(form.get("subscription_data[trial_period_days]"), "30");
  assert.equal((await t.call("GET", "/v1/me")).json.web_billing, true);
});

test("Stripe: 無料期間（trialing）は契約中として使え、買い直しには無料期間を付けない", async () => {
  const t = setup();
  t.verified();
  t.subs.set("sub_1", t.sub({ status: "trialing" }));
  await t.hook(subscriptionEvent("customer.subscription.created"));
  const me = (await t.call("GET", "/v1/me")).json;
  assert.equal(me.plan, "active");
  assert.equal(me.store, "web");
  t.subs.set("sub_1", t.sub({ status: "canceled" }));
  await t.hook(subscriptionEvent("customer.subscription.deleted"));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
  await t.call("POST", "/v1/billing/stripe/checkout");
  assert.equal(t.sent.at(-1)!.form.get("subscription_data[trial_period_days]"), null);
});

test("Stripe: 通知でStripeから読み直し、/me は契約中・web・期末になる", async () => {
  const t = setup();
  const sub = t.sub();
  t.subs.set("sub_1", sub);
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "trial");
  const res = await t.hook(subscriptionEvent("customer.subscription.created"));
  assert.equal(res.json.applied, true);
  const me = (await t.call("GET", "/v1/me")).json;
  assert.equal(me.plan, "active");
  assert.equal(me.store, "web");
  assert.equal(me.expires_at, new Date((sub.items as any).data[0].current_period_end * 1000).toISOString());
  // 同じ通知がもう一度来ても変わらない
  assert.equal((await t.hook(subscriptionEvent("customer.subscription.created"))).json.applied, true);
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "active");
});

test("Stripe: 決済完了の通知は client_reference_id で利用者に結ぶ（契約の印が無くても）", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub({ metadata: {} }));
  const res = await t.hook({ type: "checkout.session.completed", data: { object: { subscription: "sub_1", client_reference_id: t.userId } } });
  assert.equal(res.json.applied, true);
  assert.equal((await t.call("GET", "/v1/me")).json.store, "web");
});

test("Stripe: 解約しても期末までは契約中。期末を過ぎるか、すぐ止めれば期限切れ", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub({ cancel_at_period_end: true }));
  await t.hook(subscriptionEvent("customer.subscription.updated"));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "active");
  t.subs.set("sub_1", t.sub({ status: "canceled" }));
  await t.hook(subscriptionEvent("customer.subscription.deleted"));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
  t.subs.set("sub_1", t.sub({ status: "active", items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) - 10 }] } }));
  await t.hook(subscriptionEvent("customer.subscription.updated"));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
});

test("Stripe: 支払いに失敗した契約（past_due）は払い済みとして扱わない", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub({ status: "past_due" }));
  await t.hook(subscriptionEvent("customer.subscription.updated"));
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "expired");
});

test("Stripe: 署名が違う・古い通知は断り、何も書かない", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub());
  assert.equal((await t.hook(subscriptionEvent("customer.subscription.created"), { secret: "whsec_other" })).status, 400);
  assert.equal((await t.hook(subscriptionEvent("customer.subscription.created"), { at: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  const bare = await t.app.request("/v1/stripe/webhook", { method: "POST", body: "{}" });
  assert.equal(bare.status, 400);
  assert.equal((await t.call("GET", "/v1/me")).json.plan, "trial");
});

test("Stripe: 別の利用者の印が付いた契約や、消えたアカウントの通知は結ばない", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub());
  await t.hook(subscriptionEvent("customer.subscription.created"));
  // 同じ契約を別の利用者の印で名乗っても、最初の持ち主のまま
  const other = t.accounts.createUser();
  t.subs.set("sub_1", t.sub({ metadata: { user_id: other } }));
  assert.equal((await t.hook(subscriptionEvent("customer.subscription.updated"))).json.applied, false);
  t.subs.set("sub_2", t.sub({ id: "sub_2", metadata: { user_id: "00000000-0000-4000-8000-000000000000" } }));
  assert.equal((await t.hook(subscriptionEvent("customer.subscription.created", "sub_2"))).json.applied, false);
  assert.equal((await t.hook({ type: "invoice.paid", data: { object: { id: "in_1" } } })).json.applied, false);
});

test("Stripe: 契約中は二重に買わせない。ポータルは契約のある利用者だけ", async () => {
  const t = setup();
  t.verified();
  assert.equal((await t.call("POST", "/v1/billing/stripe/portal")).status, 404);
  t.subs.set("sub_1", t.sub());
  await t.hook(subscriptionEvent("customer.subscription.created"));
  assert.equal((await t.call("POST", "/v1/billing/stripe/checkout")).json.error.code, "conflict");
  const portal = await t.call("POST", "/v1/billing/stripe/portal");
  assert.equal(portal.json.url, "https://billing.stripe.test/p/1");
  assert.equal(t.sent.at(-1)!.form.get("customer"), "cus_1");
  assert.equal(t.sent.at(-1)!.form.get("configuration"), "bpc_1");
});

test("App StoreとStripeが両方ある時は、期末が遅い方が決め、片方が切れても残る", async () => {
  const t = setup();
  run(t.db, "insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, revoked, updated_at) values ('1', ?, 'Sandbox', 'p', ?, 0, ?)",
    t.userId, new Date(Date.now() + 5 * DAY * 1000).toISOString(), new Date().toISOString());
  t.accounts.syncPlan(t.userId);
  assert.equal((await t.call("GET", "/v1/me")).json.store, "app_store");
  t.subs.set("sub_1", t.sub());
  await t.hook(subscriptionEvent("customer.subscription.created"));
  assert.equal((await t.call("GET", "/v1/me")).json.store, "web");
  t.subs.set("sub_1", t.sub({ status: "canceled" }));
  await t.hook(subscriptionEvent("customer.subscription.deleted"));
  const me = (await t.call("GET", "/v1/me")).json;
  assert.equal(me.plan, "active");
  assert.equal(me.store, "app_store");
});

test("Stripe: BellTeamの許可（client session）は決済を始められない", async () => {
  const t = setup();
  t.verified();
  const { session } = t.accounts.issueSession(t.userId, "BellTeam", "bellteam");
  assert.equal((await t.call("POST", "/v1/billing/stripe/checkout", undefined, session)).status, 403);
  assert.equal((await t.call("POST", "/v1/billing/stripe/portal", undefined, session)).status, 403);
  assert.equal((await t.call("GET", "/v1/me", undefined, session)).status, 200);
});

test("Stripe: アカウント削除の前に契約を止め、止められなければ消さない", async () => {
  const t = setup();
  t.subs.set("sub_1", t.sub());
  await t.hook(subscriptionEvent("customer.subscription.created"));
  const down = setup({ stripeDown: true });
  run(down.db, "insert into stripe_subscriptions (subscription_id, user_id, customer_id, status, current_period_end, cancel_at_period_end, updated_at) values ('sub_9', ?, 'cus_9', 'active', ?, 0, ?)",
    down.userId, new Date(Date.now() + DAY * 1000).toISOString(), new Date().toISOString());
  assert.equal((await down.call("DELETE", "/v1/me")).status, 500);
  assert.equal((await down.call("GET", "/v1/me")).status, 200);
  const ok = await t.call("DELETE", "/v1/me");
  assert.equal(ok.status, 200);
  assert.equal(t.subs.get("sub_1")!.status, "canceled");
  assert.equal((await t.call("GET", "/v1/me")).status, 401);
});

test("Stripeが設定されていないサーバーでは、窓口は404でweb_billingも出ない", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test" });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "t");
  run(db, "update users set setup_verified_at = ? where id = ?", new Date().toISOString(), userId);
  const res = await app.request("/v1/billing/stripe/checkout", { method: "POST", headers: { authorization: `Bearer ${session}` } });
  assert.equal(res.status, 404);
  const hook = await app.request("/v1/stripe/webhook", { method: "POST", body: "{}" });
  assert.equal(hook.status, 404);
  const me = await (await app.request("/v1/me", { headers: { authorization: `Bearer ${session}` } })).json() as any;
  assert.equal(me.web_billing, undefined);
});

test("課金の対象外のアカウントは、契約が切れていても契約中として使える。ほかの利用者は変わらない", () => {
  const t = setup();
  const other = t.accounts.createUser();
  for (const id of [t.userId, other]) run(t.db, "update users set plan = 'expired', plan_expires_at = '2020-01-01T00:00:00.000Z', store = 'web' where id = ?", id);
  const free = new Accounts(t.db, new EventHub(t.db), "store", true, new Set([t.userId]));
  assert.equal(free.me(t.userId).plan, "active");
  assert.equal("expires_at" in free.me(t.userId), false);
  assert.doesNotThrow(() => free.assertCanUse(t.userId));
  assert.equal(free.me(other).plan, "expired");
  assert.throws(() => free.assertCanUse(other));
});

test("Stripe: 共有アカウントの他製品の契約・決済は、同じ印が付いていても200で何も変えない", async () => {
  const t = setup();
  t.verified();
  // 他製品も metadata.user_id を使う。値が同じでも、価格が違えば別製品。
  t.subs.set("sub_other", t.sub({ id: "sub_other", items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY, price: { id: "price_reminderbot" } }] } }));
  for (const type of ["customer.subscription.created", "customer.subscription.updated"]) {
    const res = await t.hook(subscriptionEvent(type, "sub_other"));
    assert.equal(res.status, 200);
  }
  assert.equal((await t.hook({ type: "checkout.session.completed", data: { object: { subscription: "sub_other", client_reference_id: t.userId } } })).status, 200);
  for (const type of ["invoice.paid", "charge.succeeded"]) assert.equal((await t.hook({ type, data: { object: { id: "x" } } })).status, 200);
  assert.equal((await t.call("GET", "/v1/me")).json.plan === "active", false);
  assert.equal(t.db.prepare("select count(*) as n from stripe_subscriptions").get()!.n, 0);
});
