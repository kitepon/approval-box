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
async function setup() {
  resetKeyCache();
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off", new Set());
  const decisions = new Decisions(db, events);
  const library = createLibrary({ db, publicUrl: ORIGIN, billing: "off", kKey: randomBytes(32).toString("base64url"), passKey: { id: "p1", key: randomBytes(32).toString("base64url") }, appleAudiences: [BUNDLE], googleAudiences: [], exemptK: [], fetch: keysOnly });
  const wakes: { k: string; alert: boolean }[] = [];
  const pc = createPeerChannel({ accounts, library, publicUrl: ORIGIN, mirrorPath: join(dir, `m-${randomBytes(4).toString("hex")}.db`), wake: (k, alert) => { wakes.push({ k, alert }); } });
  const app = createApp({ db, accounts, decisions, events, publicUrl: ORIGIN, library, peerChannel: pc.part, appleAudiences: [BUNDLE] });
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
