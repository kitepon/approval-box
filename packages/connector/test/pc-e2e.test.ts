// c8c end to end: the Approval Box server in test mode (/pc/v1 mounted), the connector's peer-channel daemon pieces
// (LocalBox + Connector + local socket), the MCP side through LocalApi, and a TS device (@kitepon/peer-channel/testing).
// request → device answer → the answer reaches the AI's channel; the server database holds no title, context or answer.
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import nodeDataChannel from "node-datachannel";
import * as steer from "aiterm-steer-delivery";
import { serve } from "@hono/node-server";
import { b64url, fromHex, generateSealKey, generateSigningKey, signSnapshot, snapshotHash, toJson, type DeviceEntry, type SnapshotBody } from "@kitepon/peer-channel";
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
import type { PeerChannelRuntime } from "../src/pc-daemon.ts";
import { startDaemonPeerChannel, useLocalApi } from "../src/daemon.ts";
import { rebindKeys } from "../src/pc-rebind.ts";
import { admissionFile, pcPrepared, readMode, serverOffersPeerChannel } from "../src/pc-mode.ts";
import { hostedSocket, writeJsonFile } from "../src/config.ts";
import { startPairingBinding } from "@kitepon/peer-channel/pairing";
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
let serverDb: ReturnType<typeof openDb>;
let conn: { id: string; token: string };
let phone: { access: { url: string; headers: Record<string, string> }; sign: ReturnType<typeof generateSigningKey>; seal: Awaited<ReturnType<typeof generateSealKey>> };
let admitted: { snapshot: { body: string; signer: string; sig: string }; hash: string };

before(async () => {
  // --- the server, test mode: library (billing off) and /pc/v1 ---
  const db = openDb(join(dir, "approval-box.db"));
  serverDb = db;
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
  conn = accounts.createConnection(k, "PC", "linux", ["claude-code"]);

  // --- the phone: genesis in the mirror ---
  const devSign = generateSigningKey();
  const devSeal = await generateSealKey();
  const now = Date.now();
  const me: DeviceEntry = { key_id: b64url(devSign.id), sig_pub: b64url(devSign.pub), seal_pub: b64url(devSeal.pub), platform: "ios", protection: "hardware", added_at: now - 1000, added_by: b64url(devSign.id) };
  const genesisBody: SnapshotBody = { v: "pc1-registry", account: k, version: 1, prev: [], created_at: now, devices: [me], connectors: [], removed: [] };
  const genesis = signSnapshot(genesisBody, devSign);
  assert.equal((await call("PUT", "/pc/v1/registry", signed.pass, toJson(genesis))).status, 204);
  const phoneAccess = { url: base, headers: { authorization: `Bearer ${signed.pass}` } };
  const approver = new TestDevice(phoneAccess, devSign, devSeal, { key_id: "", sig_pub: "", seal_pub: "", connection_id: "", added_at: 0, added_by: "" });
  await approver.open();

  // --- setup's pairing (contract 5.4): the server offers peer_channel, the connector shows PC1PAIR, the phone approves it ---
  assert.equal(await serverOffersPeerChannel(base), true);
  const binding = startPairingBinding(await loadOrCreateKeys());
  const [admission] = await Promise.all([
    binding.complete({ server: { url: base, headers: { authorization: `Bearer ${conn.token}` } }, connectionId: conn.id }),
    approver.approveConnector({ text: binding.qrText("ABCD-EFGH"), registry: { body: genesisBody, hash: snapshotHash(genesis) } }),
  ]);
  approver.close();
  assert.equal(admission.account, k); // peer-channel 0.6.0: the registry label comes from the device's tag-checked pc1-admit, not from the server
  writeJsonFile(admissionFile(), admission); // what setup's finishBinding writes
  admitted = admission;
  phone = { access: phoneAccess, sign: devSign, seal: devSeal };
  assert.equal(pcPrepared(), true);

  // --- the daemon decides the mode (flag on + admitted) and starts the endpoint; MCP follows the daemon's mode ---
  const lines: string[] = [];
  const self = { schema: "approval-box.daemon-status.v1" as const, mode: "pc" as const, paired: true, reason: "running", version: "test", pid: process.pid };
  pc = (await startDaemonPeerChannel({ server: base, token: conn.token }, (l) => lines.push(l), undefined, undefined, () => self))!;
  assert.ok(pc, lines.join("\n"));
  assert.equal(readMode()?.mode, "pc");
  writeJsonFile(join(dir, "home", "state", "daemon.json"), { pid: process.pid, entry: "test" }); // this process plays the daemon for useLocalApi
  assert.equal(await useLocalApi(), true);
  mcp = new LocalApi();
  assert.deepEqual(await mcp.call("GET", "/status"), self); // c8h: the running endpoint answers GET /status on the same socket
  const connEntry = (JSON.parse(Buffer.from(admission.snapshot.body, "base64url").toString("utf8")) as SnapshotBody).connectors[0]!;
  assert.equal(connEntry.connection_id, conn.id);
  device = new TestDevice(phoneAccess, devSign, devSeal, connEntry, { product: ["approval-box/decision@1"], answerSchema: "approval-box/answer@1" });
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

test("request images and answer attachments travel only between PC and phone; a device hold shows as held", { timeout: 60_000 }, async () => {
  const image = Buffer.concat([Buffer.from("e2e-image-marker-51aa"), randomBytes(30_000)]);
  const photo = Buffer.concat([Buffer.from("e2e-photo-marker-0d2c"), randomBytes(20_000)]);
  const { id: upload } = await mcp.uploadRequestImage(image, "screen.png", "image/png");
  const body = { title: "画像つき", context: "", options: [{ id: "ok", label: "OK" }, { id: "no", label: "NO" }], requester: "ナユタ", session_label: "e2e", client: "claude-code", route: { channel_id: "c-img", harness: "other" }, request_attachment_ids: [upload] };
  const first = await mcp.call("POST", "/decisions", { ...body, request_attachment_ids: undefined }).catch((e: unknown) => e) as ServerError;
  const d = await mcp.call<{ decision_id: string; request_attachments: { id: string; name: string }[] }>("POST", "/decisions", { ...body, check_token: first.body.check_token });
  assert.deepEqual(d.request_attachments.map((a) => a.name), ["screen.png"]);

  const req = await device.next("request", 15_000);
  assert.equal(req.body.content.decision_id, d.decision_id);
  assert.ok(Buffer.from(req.blobs![0]!.bytes).equals(image), "the image reached the phone byte-identical");
  device.ack(req.body.id);

  device.hold(req, true);
  assert.equal((await device.next("ack")).body.result, "ok");
  for (let i = 0; i < 50 && (await mcp.call<{ status: string }>("GET", `/decisions/${d.decision_id}`)).status !== "held"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await mcp.call<{ status: string }>("GET", `/decisions/${d.decision_id}`)).status, "held");

  device.answer(req, { option_id: "ok" }, [{ bytes: photo, content_type: "image/jpeg", name: "photo.jpg" }]);
  assert.equal((await device.next("ack")).body.result, "ok");
  let item: { text: string; attachments?: { id: string; sha256: string }[] } | undefined;
  for (let i = 0; i < 100 && !item; i++) { item = (await mcp.call<{ items: { decision_id: string; text: string; attachments?: { id: string; sha256: string }[] }[] }>("GET", "/deliveries")).items.find((x) => x.decision_id === d.decision_id); if (!item) await new Promise((r) => setTimeout(r, 20)); }
  assert.match(item!.text, /添付 1件/);
  const got = await mcp.download(`/decisions/${d.decision_id}/attachments/${item!.attachments![0]!.id}`);
  assert.ok(got.equals(photo), "the answer attachment is on the PC byte-identical");
  assert.ok((await mcp.download(`/decisions/${d.decision_id}/attachments/${d.request_attachments[0]!.id}`)).equals(image));

  const written = readdirSync(dir).filter((f) => /^(approval-box\.db|pc-mirror\.db)/.test(f) && statSync(join(dir, f)).isFile()).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
  for (const marker of ["e2e-image-marker-51aa", "e2e-photo-marker-0d2c", "画像つき"]) assert.ok(!written.includes(marker), marker);
});

test("the setup test passes on the PC; the server gets only the passed bit (Q8)", { timeout: 60_000 }, async () => {
  const t = await mcp.call<{ decision_id: string }>("POST", "/setup-test", { client: "claude-code", session_label: "接続テスト", route: { channel_id: "c-setup", harness: "other" } });
  const req = await device.next("request", 15_000);
  assert.equal(req.body.content.decision_id, t.decision_id);
  device.ack(req.body.id);
  device.answer(req, { option_id: "ok" });
  assert.equal((await device.next("ack")).body.result, "ok");
  let text = "";
  for (let i = 0; i < 100 && !/確認コード/.test(text); i++) { text = (await mcp.call<{ answer_text?: string }>("GET", `/decisions/${t.decision_id}`)).answer_text ?? ""; if (!/確認コード/.test(text)) await new Promise((r) => setTimeout(r, 20)); }
  const code = /確認コード: (\d{6})/.exec(text)![1]!;
  assert.deepEqual(await mcp.call("POST", "/setup-test/confirm", { decision_id: t.decision_id, code }), { status: "passed", client: "claude-code" });
  let row: any;
  for (let i = 0; i < 100 && !row; i++) { row = serverDb.prepare("select status, decision_id, code from setup_checks where connection_id = ? and client = ?").get(conn.id, "claude-code"); if (!row) await new Promise((r) => setTimeout(r, 30)); }
  assert.deepEqual([row.status, row.decision_id, row.code], ["passed", null, null]);
  assert.ok((serverDb.prepare("select setup_verified_at from users where id = ?").get(k) as any).setup_verified_at);
});

test("a seat on the hosted daemon (a514n): use-hosted, the seat's tools file into the hosted socket, the seat's own daemon delivers into the seat's channel", { timeout: 60_000 }, async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const profileTs = fileURLToPath(new URL("../src/profile.ts", import.meta.url));
  const seat = join(dir, "seat"); // another home (in BellTeam: another user) than the hosted daemon's
  const sock = join(dir, "home", "state", "pc", "daemon.sock");
  const env = { ...process.env, APPROVAL_BOX_HOME: seat };
  const cliRun = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  // The seat's channel tools run in the seat's home: open the channel there, read it there.
  const atSeat = (code: string) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as steer from "aiterm-steer-delivery"; import { PROFILE } from ${JSON.stringify(profileTs)}; ${code}`], { env, encoding: "utf8", cwd: process.cwd() });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  const on = cliRun("use-hosted", "--socket", sock);
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(JSON.parse(on.stdout), { schema: "approval-box.use-hosted.v1", socket: sock });
  const channelId = atSeat("process.stdout.write(steer.openChannel(PROFILE, null).channel_id)");
  const relay = spawn(process.execPath, [cli, "daemon"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  relay.stderr.on("data", (d) => { log += d; });
  try {
    const tools = new LocalApi(sock); // what the seat's MCP builds from hosted.json (no config.json, no keys in the seat's home)
    const { id: upload } = await tools.uploadRequestImage(Buffer.from("relay-image-7e21"), "seat.png", "image/png");
    const body = { title: "席から", context: "", options: [{ id: "ok", label: "OK" }, { id: "no", label: "NO" }], requester: "ナユタ", session_label: "relay", client: "claude-code", route: { channel_id: channelId, harness: "other" }, request_attachment_ids: [upload] };
    const first = await tools.call("POST", "/decisions", body).catch((e: unknown) => e) as ServerError;
    const d = await tools.call<{ decision_id: string }>("POST", "/decisions", { ...body, check_token: first.body.check_token });
    const req = await device.next("request", 15_000);
    assert.equal(req.body.content.decision_id, d.decision_id);
    assert.equal(Buffer.from(req.blobs![0]!.bytes).toString(), "relay-image-7e21");
    device.ack(req.body.id);
    device.answer(req, { option_id: "ok" });
    assert.equal((await device.next("ack")).body.result, "ok");

    // The seat's daemon reads the hosted deliveries and puts the answer into the seat's channel; the AI reads it there.
    let text = "";
    for (let i = 0; i < 100 && !text; i++) {
      text = atSeat(`const r = await steer.receiveFromChannel(PROFILE, ${JSON.stringify(channelId)}, { wait_ms: 0 }); if (r.outcome === "delivered") process.stdout.write(r.deliveries.map((x) => x.text).join("\\n"));`);
      if (!text) await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(text, /答え: OK（option_id=ok）/, log);
    let delivery = "";
    for (let i = 0; i < 100 && delivery !== "delivered"; i++) { delivery = (await tools.call<{ delivery?: string }>("GET", `/decisions/${d.decision_id}`)).delivery ?? ""; if (delivery !== "delivered") await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(delivery, "delivered", log);
    assert.match(log, /本体のデーモンのソケット/);
    assert.ok(!existsSync(join(seat, "state", "pc")), "the seat holds no keys or decisions of its own");
    assert.equal(hostedSocket(), undefined, "the hosted daemon's own home has no hosted.json");
  } finally {
    relay.kill("SIGTERM");
  }
  const off = cliRun("use-hosted", "--off");
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout), { schema: "approval-box.use-hosted.v1", socket: null });
  assert.ok(!existsSync(join(seat, "hosted.json")));
});

test("setup --rebind (0.5.3): a new key set without a new product pairing; requests keep flowing with the new key", { timeout: 60_000 }, async () => {
  const before = readFileSync(join(dir, "home", "state", "pc", "keys.json"), "utf8");
  let shown!: (text: string) => void;
  const text = new Promise<string>((ok) => { shown = ok; });
  const approver = new TestDevice(phone.access, phone.sign, phone.seal, { key_id: "", sig_pub: "", seal_pub: "", connection_id: "", added_at: 0, added_by: "" });
  await approver.open();
  const registry = { body: JSON.parse(Buffer.from(admitted.snapshot.body, "base64url").toString("utf8")) as SnapshotBody, hash: fromHex(admitted.hash) };
  await Promise.all([
    rebindKeys({ server: base, token: conn.token }, {
      show: (t) => shown(t),
      restart: async () => { device.close(); await pc.stop(); pc = (await startDaemonPeerChannel({ server: base, token: conn.token }, () => {}))!; },
    }),
    text.then((t) => { assert.match(t, /^PC1PAIR::/); return approver.approveConnector({ text: t, registry }); }),
  ]);
  approver.close();
  assert.notEqual(readFileSync(join(dir, "home", "state", "pc", "keys.json"), "utf8"), before, "the keys were replaced");
  const admission = JSON.parse(readFileSync(admissionFile(), "utf8")) as typeof admitted;
  const body = JSON.parse(Buffer.from(admission.snapshot.body, "base64url").toString("utf8")) as SnapshotBody;
  const active = body.connectors.filter((c) => !body.removed.some((r) => r.key_id === c.key_id));
  assert.equal(active.length, 1);
  assert.equal(readMode()?.mode, "pc");
  device = new TestDevice(phone.access, phone.sign, phone.seal, active[0]!, { product: ["approval-box/decision@1"], answerSchema: "approval-box/answer@1" });
  await device.open();
  const r = { title: "結び直しの後", context: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], requester: "ナユタ", session_label: "e2e", client: "claude-code", route: { channel_id: "c-rebind", harness: "other" } };
  const first = await mcp.call("POST", "/decisions", r).catch((e: unknown) => e) as ServerError;
  const d = await mcp.call<{ decision_id: string }>("POST", "/decisions", { ...r, check_token: first.body.check_token });
  await device.dial((await device.join()).at(-1)!);
  let req = await device.next("request", 15_000);
  while (req.body.content.decision_id !== d.decision_id) { device.ack(req.body.id); req = await device.next("request", 15_000); } // the kept outbox comes again
  device.ack(req.body.id);
  device.answer(req, { option_id: "a" });
  assert.equal((await device.next("ack")).body.result, "ok");
});

test("a server without /pc/v1 says peer_channel false; the daemon picks today's path with a named line", { timeout: 30_000 }, async () => {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const app = createApp({ db, accounts: new Accounts(db, events, "off", new Set()), decisions: new Decisions(db, events), events, publicUrl: ORIGIN });
  const plain = await new Promise<ReturnType<typeof serve>>((ok) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => ok(s)); });
  try {
    const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    assert.equal(await serverOffersPeerChannel(url), false);
    const lines: string[] = [];
    assert.equal(await startDaemonPeerChannel({ server: url, token: "t" }, (l) => lines.push(l)), undefined);
    assert.equal(readMode()?.mode, "server");
    assert.match(lines.join("\n"), /サーバーが peer_channel を出していないので、今の道で動きます/);
    assert.equal(await useLocalApi(), false);
  } finally {
    await new Promise<void>((ok) => plain.close(() => ok()));
  }
});
