// Cloudflare Realtime TURN (c8h): one POST per request with the key's API token; STUN and TURN urls pass, port 53 is dropped; failures throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareTurn } from "../src/pc.ts";

test("cloudflareTurn mints short-lived credentials and keeps the wire form", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = { iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
  ] };
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(reply), { status: 201 }); }) as unknown as typeof fetch;
  const t = await cloudflareTurn("key1", "tok", fake).generate();
  assert.deepEqual(t, { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c", ttl: 600 });
  assert.equal(calls[0]!.url, "https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate-ice-servers");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ttl: 600 });
  const down = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(cloudflareTurn("key1", "bad", down).generate(), /cloudflare_turn_401/);
});
