// peer-channel の server part を /pc/v1 に置いた形（c8b）。端末＝ライブラリの通行証、コネクタ＝接続トークン、onPassEnded、中身の無い起こし。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { b64url, generateSigningKey, signSnapshot, toJson } from "@kitepon/peer-channel";
import { Accounts } from "../src/accounts.ts";
import { run, openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { createLibrary } from "../src/lb.ts";
import { deriveKWith } from "@kitepon/login-billing/server";
import { type AppLinks, parseAppLinks } from "../src/applinks.ts";
import { resetKeyCache } from "../src/oidc.ts";
import { authenticate, createPeerChannel } from "../src/pc.ts";
import { Waker } from "../src/push.ts";

const ORIGIN = "https://kb.test";
const BUNDLE = "dev.kitepon.approvalbox";
const dir = mkdtempSync(join(tmpdir(), "ab-pc-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "t1", alg: "RS256" };
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(nonce: string, sub: string) {
  const head = `${enc({ alg: "RS256", kid: "t1" })}.${enc({ iss: "https://appleid.apple.com", aud: BUNDLE, sub, exp: Math.floor(Date.now() / 1000) + 600, nonce: createHash("sha256").update(nonce).digest("hex") })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(rsa.privateKey).toString("base64url")}`;
}
const keysOnly = (async (input: string | URL | Request) =>
  String(input) === "https://appleid.apple.com/auth/keys" ? Response.json({ keys: [jwk] }) : new Response("", { status: 404 })) as typeof fetch;

/** ライブラリ・アプリ・peer-channel を、本番と同じ serve の createServer で立てる。起こしは記録するだけ。 */
async function setup(opts: { billing?: "off" | "store"; exemptSubs?: string[]; offset?: { value: number }; appLinks?: AppLinks } = {}) {
  resetKeyCache();
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const kKey = randomBytes(32).toString("base64url");
  const exempt = await Promise.all((opts.exemptSubs ?? []).map((sub) => deriveKWith(Buffer.from(kKey, "base64url"), "apple", sub)));
  const billing = opts.billing ?? "off";
  const accounts = new Accounts(db, events, billing, new Set(exempt));
  const decisions = new Decisions(db, events);
  const offset = opts.offset ?? { value: 0 };
  const library = createLibrary({ db, publicUrl: ORIGIN, billing, kKey, passKey: { id: "p1", key: randomBytes(32).toString("base64url") }, appleAudiences: [BUNDLE], googleAudiences: [], exemptK: exempt, fetch: keysOnly, now: () => Date.now() + offset.value });
  const wakes: { k: string; alert: boolean }[] = [];
  const pc = createPeerChannel({ accounts, library, publicUrl: ORIGIN, mirrorPath: join(dir, `m-${randomBytes(4).toString("hex")}.db`), wake: (k, alert) => { wakes.push({ k, alert }); } });
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, library, peerChannel: pc.part, appleAudiences: [BUNDLE], ...(opts.appLinks ? { appLinks: opts.appLinks } : {}) });
  const server = await new Promise<ReturnType<typeof serve>>((ok) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", createServer: pc.createServer }, () => ok(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const signIn = async (sub: string) => {
    const nonce = ((await (await call("POST", "/auth/v1/signin/nonce")).json()) as { nonce: string }).nonce;
    const res = await call("POST", "/auth/v1/signin", undefined, { provider: "apple", idToken: idToken(nonce, sub), nonce });
    assert.equal(res.status, 200);
    return (await res.json()) as { pass: string; k: string };
  };
  const close = () => new Promise<void>((ok) => { pc.part.close(); server.close(() => ok()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); });
  return { db, accounts, library, pc, wakes, base, call, signIn, close };
}

const req = (authorization?: string) => ({ url: "/pc/v1/registry", method: "GET", headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage;

test("authenticate: pass → device (pid, pass kind); connection token → connector of its K; nothing → null; refused pass → its code", async () => {
  const x = await setup();
  try {
    const { pass, k } = await x.signIn("alice");
    x.accounts.ensureUser(k);
    const conn = x.accounts.createConnection(k, "pc", "linux", ["claude-code"]);
    const auth = authenticate(x.accounts, x.library, ORIGIN);
    const device = await auth(req(`Bearer ${pass}`));
    assert.ok(device && !("refused" in device));
    assert.equal(device.k, k);
    assert.equal(device.kind, "device");
    assert.equal(device.pass_kind, "store");
    assert.match(device.endpoint_ref, /\S{8,}/);
    assert.deepEqual(await auth(req(`Bearer ${conn.token}`)), { k, kind: "connector", endpoint_ref: conn.id });
    assert.equal(await auth(req()), null);
    assert.equal(await auth(req("Bearer not-a-token")), null);
    assert.equal((await x.call("POST", "/auth/v1/signout", pass)).status, 200);
    const refused = await auth(req(`Bearer ${pass}`));
    assert.ok(refused && "refused" in refused, JSON.stringify(refused));
    // The same four over HTTP: 200 / 200 / 401 / 403.
    assert.equal((await x.call("GET", "/pc/v1/registry", conn.token)).status, 200);
    assert.equal((await x.call("GET", "/pc/v1/registry")).status, 401);
    const r = await x.call("GET", "/pc/v1/registry", pass);
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { error: string }).error, (refused as { refused: string }).refused);
  } finally { await x.close(); }
});

test("mirror round trip through /pc/v1/registry; a sign-out frees the pass's slot at once (onPassEnded)", async () => {
  const x = await setup();
  try {
    const { pass, k } = await x.signIn("bob");
    x.accounts.ensureUser(k);
    const conn = x.accounts.createConnection(k, "pc", "linux", []);
    const key = generateSigningKey();
    const me = { key_id: b64url(key.id), sig_pub: b64url(key.pub), seal_pub: b64url(key.pub), platform: "ios" as const, protection: "hardware" as const, added_at: Date.now(), added_by: b64url(key.id) };
    const genesis = toJson(signSnapshot({ v: "pc1-registry", account: k, version: 1, prev: [], created_at: Date.now(), devices: [me], connectors: [], removed: [] }, key));
    assert.equal((await x.call("PUT", "/pc/v1/registry", conn.token, genesis)).status, 403); // connectors never upload
    assert.equal((await x.call("PUT", "/pc/v1/registry", pass, genesis)).status, 204);
    assert.deepEqual(await (await x.call("GET", "/pc/v1/registry", conn.token)).json(), { slots: [genesis] }); // same K, read by the connector
    const other = await x.signIn("carol");
    assert.deepEqual(await (await x.call("GET", "/pc/v1/registry", other.pass)).json(), { slots: [] }); // never another K
    assert.equal((await x.call("POST", "/auth/v1/signout", pass)).status, 200);
    assert.deepEqual(await (await x.call("GET", "/pc/v1/registry", conn.token)).json(), { slots: [] });
    assert.equal((await x.call("DELETE", "/pc/v1/registry", other.pass)).status, 405); // there is no delete
  } finally { await x.close(); }
});

test("/v1/auth/config says peer_channel when /pc/v1 is mounted (the connector's switch, c8c)", async () => {
  const x = await setup();
  try {
    assert.equal(((await (await x.call("GET", "/v1/auth/config")).json()) as { peer_channel: boolean }).peer_channel, true);
  } finally { await x.close(); }
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const app = createApp({ db, accounts: new Accounts(db, events, "off", new Set()), decisions: new Decisions(db, events), events, publicUrl: ORIGIN });
  assert.equal(((await (await app.request("/v1/auth/config")).json()) as { peer_channel: boolean }).peer_channel, false);
});

test("TURN without settings answers an empty list", async () => {
  const x = await setup();
  try {
    const { pass } = await x.signIn("dave");
    const t = (await (await x.call("POST", "/pc/v1/turn", pass)).json()) as { urls: string[]; ttl: number };
    assert.deepEqual(t.urls, []);
    assert.equal(t.ttl, 600);
  } finally { await x.close(); }
});

test("a connector's wait.open wakes its account through the server part", async () => {
  const x = await setup();
  try {
    const { k } = await x.signIn("erin");
    x.accounts.ensureUser(k);
    const conn = x.accounts.createConnection(k, "pc", "linux", []);
    const ws = new WebSocket(`${x.base.replace("http", "ws")}/pc/v1/signal`, { headers: { authorization: `Bearer ${conn.token}` } } as never);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    ws.send(JSON.stringify({ type: "wait.open", wait_id: b64url(randomBytes(16)), alert: true }));
    for (let i = 0; i < 50 && !x.wakes.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(x.wakes, [{ k, alert: true }]);
    ws.close();
  } finally { await x.close(); }
});

test("a wake carries no content: fixed APNs and FCM payloads, no title, requester, id or badge", async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  new Accounts(db, events, "off", new Set()).ensureUser("K1");
  run(db, "insert into devices (id, user_id, platform, push_key, apns_token, apns_env, created_at, updated_at) values ('d1', 'K1', 'ios', 'p1', 'tok-ios', 'sandbox', 'x', 'x')");
  run(db, "insert into devices (id, user_id, platform, push_key, fcm_token, created_at, updated_at) values ('d2', 'K1', 'android', 'p2', 'tok-android', 'x', 'x')");
  run(db, `insert into decisions (id, user_id, title, norm_title, context, options, urgency, client, session_label, via, test, status, resume_phrase, created_at, updated_at, version)
    values ('dec1', 'K1', 'secret title', 'secret title', 'secret context', '[]', 'normal', 'claude-code', 'secret session', 'connector', 0, 'pending', 'r', 'x', 'x', 1)`);
  const sent: unknown[] = [];
  const waker = new Waker(db, {
    apns: async (env, token, headers, payload) => { sent.push({ via: "apns", env, token, headers, payload }); return { status: 200 }; },
    fcm: async (token, data, priority) => { sent.push({ via: "fcm", token, data, priority }); return { status: 200 }; },
  });
  await waker.wake("K1", true);
  await waker.wake("K1", false);
  await waker.wake("nobody", true);
  assert.deepEqual(sent, [
    { via: "apns", env: "sandbox", token: "tok-ios", headers: { "apns-push-type": "alert", "apns-priority": "10" }, payload: { aps: { alert: { "loc-key": "PC_NEW" }, "mutable-content": 1, sound: "default" }, pc: 1 } },
    { via: "fcm", token: "tok-android", data: { pc: "1", a: "1" }, priority: "high" },
    { via: "apns", env: "sandbox", token: "tok-ios", headers: { "apns-push-type": "background", "apns-priority": "5" }, payload: { aps: { "content-available": 1 }, pc: 1 } },
    { via: "fcm", token: "tok-android", data: { pc: "1", a: "0" }, priority: "normal" },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /secret|dec1|badge|title|body/);
});

/** A socket on /pc/v1/signal and the next message it receives. */
async function socket(base: string, token: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/pc/v1/signal`, { headers: { authorization: `Bearer ${token}` } } as never);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  const next = async () => { for (let i = 0; i < 100 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 20)); return inbox.shift(); };
  return { ws, next, send: (m: object) => ws.send(JSON.stringify(m)) };
}

test("contract 10.2: a device pass without the subscription is refused at join (no_entitlement); an exempt account joins", async () => {
  const x = await setup({ billing: "store", exemptSubs: ["owner"] });
  try {
    const unpaid = await x.signIn("frank");
    const owner = await x.signIn("owner");
    const auth = authenticate(x.accounts, x.library, ORIGIN);
    const id = await auth(req(`Bearer ${unpaid.pass}`));
    assert.equal(id && !("refused" in id) && id.not_entitled, "no_entitlement");
    const a = await socket(x.base, unpaid.pass);
    a.send({ type: "join" });
    assert.deepEqual(await a.next(), { type: "error", code: "no_entitlement", of: "join" });
    assert.equal((await x.call("GET", "/pc/v1/registry", unpaid.pass)).status, 200); // the mirror stays readable (admission needs it)
    const b = await socket(x.base, owner.pass);
    b.send({ type: "join" });
    assert.deepEqual(await b.next(), { type: "waits", waits: [] });
    a.ws.close(); b.ws.close();
  } finally { await x.close(); }
});

test("G2 on /pc/v1: a connector of an account without a contract may connect but not open a wait (subscription_expired), as on /connector/v1", async () => {
  const x = await setup({ billing: "store", exemptSubs: ["owner"] });
  try {
    const unpaid = await x.signIn("gina");
    const owner = await x.signIn("owner");
    for (const k of [unpaid.k, owner.k]) x.accounts.ensureUser(k);
    const c1 = await socket(x.base, x.accounts.createConnection(unpaid.k, "pc", "linux", []).token);
    c1.send({ type: "wait.open", wait_id: b64url(randomBytes(16)), alert: true });
    assert.deepEqual(await c1.next(), { type: "error", code: "subscription_expired", of: "wait.open" });
    const c2 = await socket(x.base, x.accounts.createConnection(owner.k, "pc", "linux", []).token);
    c2.send({ type: "wait.open", wait_id: b64url(randomBytes(16)), alert: true });
    for (let i = 0; i < 50 && !x.wakes.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(x.wakes, [{ k: owner.k, alert: true }]);
    c1.ws.close(); c2.ws.close();
  } finally { await x.close(); }
});

test("a renewed pass comes back in Login-Billing-Pass on /pc/v1 HTTP answers, as on /v1", async () => {
  const offset = { value: 0 };
  const x = await setup({ offset });
  try {
    const { pass } = await x.signIn("hana");
    assert.equal((await x.call("GET", "/pc/v1/registry", pass)).headers.get("login-billing-pass"), null);
    offset.value = 25 * 3600_000;
    const renewed = (await x.call("GET", "/pc/v1/registry", pass)).headers.get("login-billing-pass");
    assert.ok(renewed && renewed !== pass);
    assert.equal((await x.call("GET", "/pc/v1/registry", renewed)).status, 200);
  } finally { await x.close(); }
});

test("/.well-known app links: served from the settings as JSON without redirect, 404 when unset, malformed entries left out", async () => {
  const fp = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, "0")).join(":");
  const parsed = parseAppLinks(`dev.kitepon.approvalbox=${fp};bad package=XX`, "ABCDE12345.dev.kitepon.approvalbox,notanid");
  assert.deepEqual(parsed.problems, ["AB_ANDROID_APP_LINKS entry 2", "AB_APPLE_APP_IDS entry 2"]);
  const x = await setup({ appLinks: parsed.links });
  try {
    const android = await x.call("GET", "/.well-known/assetlinks.json");
    assert.equal(android.status, 200);
    assert.equal(android.headers.get("content-type"), "application/json");
    assert.deepEqual(await android.json(), [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "dev.kitepon.approvalbox", sha256_cert_fingerprints: [fp.toUpperCase()] } }]);
    const apple = await fetch(`${x.base}/.well-known/apple-app-site-association`, { redirect: "manual" });
    assert.equal(apple.status, 200);
    assert.equal(apple.headers.get("content-type"), "application/json");
    assert.deepEqual(await apple.json(), { applinks: { details: [{ appIDs: ["ABCDE12345.dev.kitepon.approvalbox"], components: [{ "/": "/app/websignin", comment: "web sign-in return (login-billing 1.20)" }] }] } });
  } finally { await x.close(); }
  const y = await setup();
  try {
    assert.equal((await y.call("GET", "/.well-known/assetlinks.json")).status, 404);
    assert.equal((await y.call("GET", "/.well-known/apple-app-site-association")).status, 404);
  } finally { await y.close(); }
});

test("the test server's Android app-links value parses as written in login-pass.md", () => {
  const play = "29:80:1A:79:E6:33:85:82:26:D8:C4:30:96:E9:F4:DD:A8:91:01:6B:C8:47:01:C7:CA:BD:B7:D8:C5:BD:97:36";
  const upload = "7B:8B:69:03:39:83:C7:DE:D4:64:7C:B8:1F:6E:29:0C:2E:45:81:81:6F:4B:A0:D0:FC:1F:A1:7B:B9:37:69:96";
  const debug = "32:38:26:CF:84:B5:17:5A:E3:A0:88:85:BB:29:44:2D:64:BE:2D:E3:A9:C3:2E:5D:DC:EC:7D:96:FA:76:61:B0";
  const parsed = parseAppLinks(`dev.kitepon.approvalbox=${play},${upload},${debug};dev.kitepon.approvalbox.debug=${debug}`);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.links.android, [
    { packageName: "dev.kitepon.approvalbox", fingerprints: [play, upload, debug] },
    { packageName: "dev.kitepon.approvalbox.debug", fingerprints: [debug] },
  ]);
});
