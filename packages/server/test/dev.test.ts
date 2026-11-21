// The local dev runner (npm run dev:server): loopback only, fake sign-in that yields a real pass from this server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLoopback, startDevServer } from "../src/dev.ts";

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
