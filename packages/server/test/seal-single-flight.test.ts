import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { keyWindow } from "login-billing-028/server";
import { openDb } from "../src/db.ts";
import { Vault } from "../src/seal.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parallel opens of one set unwrap the data key once on a cold cache", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "seal-sf-")), "a.db"));
  const inner = keyWindow({ keys: { k: new Uint8Array(32).fill(7) }, current: "k" });
  let unwraps = 0;
  const w = { current: () => inner.current(), wrap: inner.wrap.bind(inner), unwrap: (n: string, b: Uint8Array, a: string) => { unwraps++; return inner.unwrap(n, b, a); } };
  const sealed = await new Vault(db, w).seal("set-1", "d|title", "hello");
  unwraps = 0;
  const cold = new Vault(db, w); // a fresh vault: empty key cache
  const out = await Promise.all(Array.from({ length: 50 }, () => cold.open("set-1", "d|title", sealed)));
  assert.ok(out.every((t) => t === "hello"));
  assert.equal(unwraps, 1);
});
