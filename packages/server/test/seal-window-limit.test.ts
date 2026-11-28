import { test } from "node:test";
import assert from "node:assert/strict";
import { limitWindow } from "../src/seal.ts";

test("limitWindow keeps at most 8 module calls in flight and answers every call", async () => {
  let active = 0, peak = 0;
  const slow = async (data: Uint8Array) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return data; };
  const w = limitWindow({ current: () => "k", wrap: (_n, d) => slow(d), unwrap: (_n, b) => slow(b) });
  const out = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? w.wrap : w.unwrap)("k", new Uint8Array([i]), "a")));
  assert.equal(peak, 8);
  assert.deepEqual(out.map((b) => b[0]), Array.from({ length: 100 }, (_, i) => i));
  assert.equal(w.current(), "k");
});

test("limitWindow frees its slot when a call fails", async () => {
  const w = limitWindow({ current: () => "k", wrap: async () => { throw new Error("denied"); }, unwrap: async (_n, b) => b }, 1);
  await assert.rejects(w.wrap("k", new Uint8Array([1]), "a"));
  assert.deepEqual(await w.unwrap("k", new Uint8Array([2]), "a"), new Uint8Array([2]));
});
