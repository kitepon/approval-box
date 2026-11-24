// The local dev runner (npm run dev:server): loopback only, fake sign-in that yields a real pass from this server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLoopback, startDevServer } from "../src/dev.ts";
import { SIGNED_HEADER } from "../src/keyholes.ts";
import { makeDevice } from "./keyhole-signer.ts";

test("the dev runner refuses a PUBLIC_URL that is not loopback http, and starts nothing", async () => {
  for (const bad of ["https://approval-box-test.kitepon.dev", "http://192.168.1.12:8788", "http://example.com", "https://127.0.0.1:8788", "not a url"]) {
    assert.throws(() => assertLoopback(bad), /loopback|not a URL/, bad);
    await assert.rejects(startDevServer({ port: 0, publicUrl: bad, dataDir: join(tmpdir(), "never-made") }), /loopback|not a URL/);
  }
  for (const ok of ["http://127.0.0.1:8788", "http://localhost:8788", "http://[::1]:8788", "http://127.0.0.2"]) assert.doesNotThrow(() => assertLoopback(ok), ok);
});

test("a device signs in with a fake id token, gets a pass, and passes the paid gate (exempt K)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-"));
  const lines: string[] = [];
  const s = await startDevServer({ port: 0, dataDir: dir, log: (l) => lines.push(l) });
  try {
    const post = (path: string, body: unknown, token?: string) => fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const { nonce } = await (await post("/auth/v1/signin/nonce", {})).json() as { nonce: string };
    const { id_token } = await (await post("/dev/id-token", { provider: "apple", nonce })).json() as { id_token: string };
    const signed = await (await post("/auth/v1/signin", { provider: "apple", idToken: id_token, nonce })).json() as { pass: string; k: string };
    assert.ok(signed.pass && signed.k);
    const list = await fetch(`${s.url}/v1/decisions`, { headers: { authorization: `Bearer ${signed.pass}` } });
    assert.equal(list.status, 200); // a paid route: the fake person's K is exempt
    assert.equal(((await (await fetch(`${s.url}/v1/auth/config`)).json()) as { peer_channel: boolean }).peer_channel, true);
    assert.match(lines.join("\n"), /listening on http:\/\/127\.0\.0\.1:/);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a non-exempt person gets a store pass from /dev/store-purchase through the library's receipt route (google and apple)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-"));
  const s = await startDevServer({ port: 0, dataDir: dir, log: () => {} });
  try {
    const post = (path: string, body: unknown, token?: string) => fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    for (const provider of ["google", "apple"] as const) {
      const sub = `dev-buyer-${provider}`;
      const { nonce } = await (await post("/auth/v1/signin/nonce", {})).json() as { nonce: string };
      const { id_token } = await (await post("/dev/id-token", { provider, sub, nonce })).json() as { id_token: string };
      const signed = await (await post("/auth/v1/signin", { provider, idToken: id_token, nonce })).json() as { pass: string; k: string };
      assert.equal((await fetch(`${s.url}/v1/decisions`, { headers: { authorization: `Bearer ${signed.pass}` } })).status, 402); // not exempt: no store pass yet
      const bought = await (await post("/dev/store-purchase", { provider, k: signed.k })).json() as { route: string; receipts: unknown[] };
      assert.equal(bought.route, "/auth/v1/receipt");
      const got = await (await post(bought.route, { receipts: bought.receipts }, signed.pass)).json() as { pass: string; entitlements: unknown[]; receiptResults: { result: string }[] };
      assert.equal(got.receiptResults[0]?.result, "attached", provider);
      assert.ok(got.entitlements.length > 0, provider);
      assert.equal((await fetch(`${s.url}/v1/decisions`, { headers: { authorization: `Bearer ${got.pass}` } })).status, 200, provider);
    }
    assert.equal((await post("/dev/store-purchase", { provider: "x" })).status, 400);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pcOffer false is production's PC_OFFER=off: peer_channel false, no /pc/v1, and a client works over /v1 end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-"));
  const lines: string[] = [];
  const s = await startDevServer({ port: 0, dataDir: dir, pcOffer: false, log: (l) => lines.push(l) });
  try {
    const post = (path: string, body: unknown, token?: string) => fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal(((await (await fetch(`${s.url}/v1/auth/config`)).json()) as { peer_channel: boolean }).peer_channel, false);
    assert.notEqual((await fetch(`${s.url}/pc/v1/registry`)).status, 200);
    assert.match(lines.join("\n"), /peer_channel off/);
    // the client signs in (fake Google web identity's K is exempt, as in the other tests)
    const { nonce } = await (await post("/auth/v1/signin/nonce", {})).json() as { nonce: string };
    const { id_token } = await (await post("/dev/id-token", { provider: "google", nonce })).json() as { id_token: string };
    const { pass } = await (await post("/auth/v1/signin", { provider: "google", idToken: id_token, nonce })).json() as { pass: string };
    // an AI of the same account files one request through a connection token (two steps: check_token)
    const { token } = await (await post("/v1/tokens", { label: "lab AI" }, pass)).json() as { token: string };
    const ask = { title: "試験の申請", options: [{ id: "ok", label: "はい" }, { id: "no", label: "いいえ" }], session_label: "lab", client: "claude-code", requester: "lab" };
    const first = await post("/connector/v1/decisions", ask, token);
    const check = ((await first.json()) as { error?: { check_token?: string }; check_token?: string });
    const checkToken = check.error?.check_token ?? check.check_token;
    assert.ok(checkToken, "first call returns a check token");
    const filed = await (await post("/connector/v1/decisions", { ...ask, check_token: checkToken }, token)).json() as { decision_id?: string; id?: string };
    const id = filed.decision_id ?? filed.id;
    assert.ok(id);
    // the client reads and answers it over /v1
    const list = await (await fetch(`${s.url}/v1/decisions?status=pending,held`, { headers: { authorization: `Bearer ${pass}` } })).json() as { items: { id: string; version: number }[] };
    const item = list.items.find((d) => d.id === id);
    assert.ok(item);
    const answered = await fetch(`${s.url}/v1/decisions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${pass}`, "idempotency-key": "lab-1" }, body: JSON.stringify({ option_id: "ok", version: item.version }) });
    assert.equal(answered.status, 200);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the dev runner mounts the same keyholes as main.ts: a signed key starts an entry and its signed /v1 call is answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-"));
  // the library signs the origin: a fixed port, since publicUrl is made before the listener binds
  const s = await startDevServer({ port: 18000 + Math.floor(Math.random() * 1000), dataDir: dir, log: () => {} });
  try {
    const device = await makeDevice({ origin: s.url });
    const body = JSON.stringify({ role: "parent" });
    const started = await fetch(`${s.url}/v1/keys/start`, { method: "POST", headers: { "content-type": "application/json", [SIGNED_HEADER]: await device.sign("POST", "/v1/keys/start", body) }, body });
    assert.equal(started.status, 200);
    assert.equal(((await started.json()) as { role: string }).role, "parent");
    const me = await fetch(`${s.url}/v1/me`, { headers: { [SIGNED_HEADER]: await device.sign("GET", "/v1/me") } });
    assert.equal(me.status, 200);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});
