// Proves the test signer on login-billing 0.21.1's own vectors (vectors/keyholes/cases.json at v0.21.1, copied unchanged), through the library's real verify and handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryKeyholeStore, createKeyholes } from "@kitepon/login-billing/server";
import { addText, lowS, makeDevice, parentAdd, requestText } from "./keyhole-signer.ts";

type Req = { k: string; method: string; path: string; body: string; origin: string; t: number; n: string; text: string; header: string };
type Add = { key: string; role: "parent" | "child"; issued: number; signer: string; s: string; text: string };
const cases = JSON.parse(readFileSync(new URL("./vectors/login-billing-0.21.1-keyholes-cases.json", import.meta.url), "utf8")) as {
  appId: string; keys: Record<"parent" | "child" | "stranger", { d: string; pub: string }>; requests: Req[]; adds: Add[];
};
const { appId, keys } = cases;
const T = cases.requests[0]!.t;
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const sOf = (header: string) => BigInt("0x" + Buffer.from(header.split(" s=")[1]!, "base64url").subarray(32).toString("hex"));

test("signer: keys and signed texts reproduce the vectors byte for byte", async () => {
  for (const name of ["parent", "child", "stranger"] as const) assert.equal((await makeDevice({ d: keys[name].d, appId })).publicKey, keys[name].pub, name);
  for (const r of cases.requests) assert.equal(await requestText(appId, r.k, r.method, r.path, r.body, r.origin, r.t, r.n), r.text, r.path);
  for (const a of cases.adds) assert.equal(addText(appId, a), a.text);
  // Our header has the vector's fields in the vector's order; only the (random) signature differs.
  const r0 = cases.requests[0]!;
  const child = await makeDevice({ d: keys.child.d, appId });
  const ours = await child.sign(r0.method, r0.path, r0.body, r0.origin, r0.t, r0.n);
  assert.equal(ours.split(" s=")[0], r0.header.split(" s=")[0]);
  // Low s: a high s is folded to n - s.
  const high = new Uint8Array(64).fill(0xff);
  assert.ok(BigInt("0x" + Buffer.from(lowS(high).subarray(32)).toString("hex")) <= N / 2n);
  for (let i = 0; i < 20; i++) assert.ok(sOf(await child.sign("GET", "/x", "", r0.origin, T)) <= N / 2n);
});

test("signer: the library's verify takes the vector's request (requests[0]) and ours; handle takes the vector's add (adds[0]) and ours (adds[1])", async () => {
  const store = new MemoryKeyholeStore(() => T);
  const keyholes = createKeyholes({ appId, origin: "https://api.example.com", store, now: () => T });
  const parent = await makeDevice({ d: keys.parent.d, appId, origin: "https://api.example.com" });
  const child = await makeDevice({ d: keys.child.d, appId, origin: "https://api.example.com" });
  const stranger = await makeDevice({ d: keys.stranger.d, appId, origin: "https://api.example.com" });
  const call = async (device: typeof parent, path: string, body: unknown) => {
    const text = JSON.stringify(body);
    const res = await keyholes.handle({ method: "POST", path, headers: { "login-billing-key": await device.sign("POST", path, text, undefined, T) }, body: new TextEncoder().encode(text) });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const started = await call(parent, "/api/keys/start", { role: "parent" });
  assert.equal(started.status, 200);
  const entry = started.json.entry as string;
  // The vector's add, as the library's file has it.
  const a0 = cases.adds[0]!;
  assert.deepEqual(await call(child, "/api/keys/accept", { add: { key: a0.key, role: a0.role, issued: a0.issued, signer: a0.signer, s: a0.s } }), { status: 200, json: { entry, role: "child" } });
  // The vector's request, header as written in the file.
  const r0 = cases.requests[0]!;
  assert.deepEqual(await keyholes.verify({ method: r0.method, path: r0.path, headers: { "login-billing-key": r0.header }, body: new TextEncoder().encode(r0.body) }), { entry, key: keys.child.pub, role: "child" });
  // Our own signature of the same request (another nonce) and our own add of adds[1].
  assert.deepEqual(await keyholes.verify({ method: "POST", path: r0.path, headers: { "login-billing-key": await child.sign("POST", r0.path, r0.body, undefined, T) }, body: new TextEncoder().encode(r0.body) }), { entry, key: keys.child.pub, role: "child" });
  const a1 = cases.adds[1]!;
  const ours = await parentAdd(parent, a1.key, a1.role, a1.issued, appId);
  assert.deepEqual({ ...ours, s: undefined }, { key: a1.key, role: a1.role, issued: a1.issued, signer: a1.signer, s: undefined });
  assert.deepEqual(await call(stranger, "/api/keys/accept", { add: ours }), { status: 200, json: { entry, role: "parent" } });
  // A tampered request is refused by the same verify.
  await assert.rejects(keyholes.verify({ method: r0.method, path: r0.path + "x", headers: { "login-billing-key": r0.header }, body: new TextEncoder().encode(r0.body) }), { code: "key_invalid" });
});
