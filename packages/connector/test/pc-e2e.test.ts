// c8c end to end: the Approval Box server in test mode (/pc/v1 mounted), the connector's peer-channel daemon pieces
// (LocalBox + Connector + local socket), the MCP side through LocalApi, and a TS device (@kitepon/peer-channel/testing).
// request → device answer → the answer reaches the AI's channel; the server database holds no title, context or answer.
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import nodeDataChannel from "node-datachannel";
import * as steer from "aiterm-steer-delivery";
import { serve } from "@hono/node-server";
import { b64url, generateSealKey, generateSigningKey, hex, signSnapshot, snapshotHash, toJson, type ConnectorEntry, type DeviceEntry, type SnapshotBody } from "@kitepon/peer-channel";
import { TestDevice } from "@kitepon/peer-channel/testing";
import { Accounts } from "../../server/src/accounts.ts";
import { openDb } from "../../server/src/db.ts";
import { Decisions } from "../../server/src/decisions.ts";
import { EventHub } from "../../server/src/events.ts";
import { createApp } from "../../server/src/http.ts";
import { createLibrary } from "../../server/src/lb.ts";
import { createPeerChannel } from "../../server/src/pc.ts";
import { ServerError } from "../src/api.ts";
import { sendChannelAnswer } from "../src/channel-delivery.ts";
import { LocalApi } from "../src/local-api.ts";
import { startPeerChannel, type PeerChannelRuntime } from "../src/pc-daemon.ts";
import { loadOrCreateKeys } from "../src/pc-keys.ts";
import { PROFILE } from "../src/profile.ts";

const ORIGIN = "https://kb.test";
const BUNDLE = "dev.kitepon.approvalbox";
const dir = mkdtempSync(join(tmpdir(), "ab-pc-e2e-"));
const savedHome = process.env.APPROVAL_BOX_HOME;
process.env.APPROVAL_BOX_HOME = join(dir, "home"); // the connector's own state (channels, pc/) lives here
const SECRET = { title: "e2e-secret-title-4b1d", context: "e2e-secret-context-77a0", answer: "e2e-secret-answer-c3f9" };

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "t1", alg: "RS256" };
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (nonce: string, sub: string) => {
  const head = `${enc({ alg: "RS256", kid: "t1" })}.${enc({ iss: "https://appleid.apple.com", aud: BUNDLE, sub, exp: Math.floor(Date.now() / 1000) + 600, nonce: createHash("sha256").update(nonce).digest("hex") })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(rsa.privateKey).toString("base64url")}`;
};

let server: ReturnType<typeof serve>;
let serverPart: ReturnType<typeof createPeerChannel>;
let base = "";
let pc: PeerChannelRuntime;
let mcp: LocalApi;
let device: TestDevice;
let k = "";

before(async () => {
  // --- the server, test mode: library (billing off) and /pc/v1 ---
  const db = openDb(join(dir, "approval-box.db"));
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off", new Set());
  const library = createLibrary({ db, publicUrl: ORIGIN, billing: "off", kKey: randomBytes(32).toString("base64url"), passKey: { id: "p1", key: randomBytes(32).toString("base64url") }, appleAudiences: [BUNDLE], googleAudiences: [], exemptK: [],
    fetch: (async (u: string | URL | Request) => String(u) === "https://appleid.apple.com/auth/keys" ? Response.json({ keys: [jwk] }) : new Response("", { status: 404 })) as typeof fetch });
  serverPart = createPeerChannel({ accounts, library, publicUrl: ORIGIN, mirrorPath: join(dir, "pc-mirror.db"), wake: () => {} });
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: ORIGIN, library, peerChannel: serverPart.part, appleAudiences: [BUNDLE] });
  server = await new Promise((ok) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", createServer: serverPart.createServer }, () => ok(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, token?: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const nonce = ((await (await call("POST", "/auth/v1/signin/nonce")).json()) as { nonce: string }).nonce;
  const signed = (await (await call("POST", "/auth/v1/signin", undefined, { provider: "apple", idToken: idToken(nonce, "owner"), nonce })).json()) as { pass: string; k: string };
  k = signed.k;
  accounts.ensureUser(k);
  const conn = accounts.createConnection(k, "PC", "linux", ["claude-code"]);

  // --- the phone: genesis, then (pairing, contract 5.4) a snapshot that adds the connector's keys ---
  const devSign = generateSigningKey();
  const devSeal = await generateSealKey();
  const keys = await loadOrCreateKeys(join(dir, "home", "state", "pc", "keys.json"));
  const now = Date.now();
  const me: DeviceEntry = { key_id: b64url(devSign.id), sig_pub: b64url(devSign.pub), seal_pub: b64url(devSeal.pub), platform: "ios", protection: "hardware", added_at: now - 1000, added_by: b64url(devSign.id) };
  const connEntry: ConnectorEntry = { key_id: b64url(keys.sign.id), sig_pub: b64url(keys.sign.pub), seal_pub: b64url(keys.seal.pub), connection_id: conn.id, added_at: now, added_by: me.key_id };
  const body = (version: number, connectors: ConnectorEntry[], prev: string[]): SnapshotBody => ({ v: "pc1-registry", account: k, version, prev, created_at: now, devices: [me], connectors, removed: [] });
  const genesis = signSnapshot(body(1, [], []), devSign);
  const v2 = signSnapshot(body(2, [connEntry], [b64url(snapshotHash(genesis))]), devSign);
  for (const s of [genesis, v2]) assert.equal((await call("PUT", "/pc/v1/registry", signed.pass, toJson(s))).status, 204);

  // --- the connector daemon's peer-channel pieces, and the MCP side over the local socket ---
  pc = await startPeerChannel({ server: base, token: conn.token, connectionId: conn.id, account: k, admission: { snapshot: toJson(v2), hash: hex(snapshotHash(v2)) } });
  mcp = new LocalApi();
  device = new TestDevice({ url: base, headers: { authorization: `Bearer ${signed.pass}` } }, devSign, devSeal, connEntry, { product: ["approval-box/decision@1"], answerSchema: "approval-box/answer@1" });
});

after(async () => {
  device?.close();
  await pc?.stop();
  serverPart?.part.close();
  await new Promise<void>((ok) => { server?.close(() => ok()); (server as { closeAllConnections?: () => void })?.closeAllConnections?.(); });
  nodeDataChannel.cleanup();
  if (savedHome === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

test("request → device answer → the AI's channel; the server keeps no title, context or answer", { timeout: 60_000 }, async () => {
  const channel = steer.openChannel(PROFILE, null);
  const request = { title: SECRET.title, context: SECRET.context, options: [{ id: "go", label: "出す" }, { id: "wait", label: "待つ" }], requester: "ナユタ", session_label: "e2e", client: "claude-code", route: { channel_id: channel.channel_id, harness: "other" } };

  // The check_token flow, computed locally (MCP request_decision → confirm_required → again with the token).
  const first = await mcp.call("POST", "/decisions", request).catch((e: unknown) => e);
  assert.ok(first instanceof ServerError && first.code === "confirm_required");
  const decision = await mcp.call<{ decision_id: string; status: string }>("POST", "/decisions", { ...request, check_token: first.body.check_token });
  assert.equal(decision.status, "pending");
  const dup = await mcp.call("POST", "/decisions", { ...request, check_token: "x" }).catch((e: unknown) => e);
  assert.ok(dup instanceof ServerError && (dup.code === "confirm_required" || dup.code === "duplicate_suspected"));

  // The phone is woken, dials the connector, and receives the request over the data channel.
  await device.open();
  const waits = await device.join();
  assert.equal(waits.length, 1);
  await device.dial(waits[0]!);
  const req = await device.next("request", 15_000);
  assert.equal(req.body.schema, "approval-box/decision@1");
  assert.equal(req.body.content.title, SECRET.title);
  assert.equal(req.body.content.decision_id, decision.decision_id);
  device.ack(req.body.id);

  // A choice that is not one of this request's options is refused (validate with rid); a valid one is accepted.
  device.answer(req, { option_id: "nope" });
  assert.equal((await device.next("ack")).body.result, "refused:invalid");
  device.answer(req, { option_id: "go", text: SECRET.answer });
  assert.equal((await device.next("ack")).body.result, "ok");
  assert.equal((await device.next("result")).body.status, "answered");

  // The daemon's delivery path: the waiting delivery → the channel → the AI reads it; then the report.
  for (let i = 0; i < 50 && !(await mcp.call<{ items: unknown[] }>("GET", "/deliveries")).items.length; i++) await new Promise((r) => setTimeout(r, 20));
  const [item] = (await mcp.call<{ items: { decision_id: string; delivery_id: string; route: { channel_id: string }; text: string }[] }>("GET", "/deliveries")).items;
  assert.equal(item?.decision_id, decision.decision_id);
  assert.equal(item.route.channel_id, channel.channel_id);
  await sendChannelAnswer(item.route.channel_id, item.delivery_id, item.text);
  const received = await steer.receiveFromChannel(PROFILE, channel.channel_id, { wait_ms: 0 });
  assert.equal(received.outcome, "delivered");
  const text = received.outcome === "delivered" ? received.deliveries.map((d) => d.text).join("\n") : "";
  assert.match(text, /答え: 出す（option_id=go）/);
  assert.match(text, new RegExp(SECRET.answer));
  assert.deepEqual(await mcp.call("POST", `/deliveries/${decision.decision_id}`, { state: "delivered" }), { decision_id: decision.decision_id, delivery: "delivered" });
  const got = await mcp.call<{ status: string; answer_text: string }>("GET", `/decisions/${decision.decision_id}`);
  assert.equal(got.status, "answered");
  assert.match(got.answer_text, /e2e-secret-answer/);

  // Nothing the server wrote holds the content.
  const files = readdirSync(dir).filter((f) => /^(approval-box\.db|pc-mirror\.db)/.test(f) && statSync(join(dir, f)).isFile());
  assert.ok(files.length >= 2);
  const written = files.map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
  for (const s of Object.values(SECRET)) assert.ok(!written.includes(s), s);
  // The connector's own records are 0600 on the PC.
  const local = join(dir, "home", "state", "pc", "decisions.json");
  assert.ok(readFileSync(local, "utf8").includes(SECRET.title));
  if (process.platform !== "win32") assert.equal(statSync(local).mode & 0o777, 0o600);
  steer.closeChannel(PROFILE, channel.channel_id);
});
