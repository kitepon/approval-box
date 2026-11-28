import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateKeys } from "../src/pc-keys.ts";

test("keys whose scalar starts with a zero byte load (saved short before the fix)", async () => {
  let e;
  do { e = createECDH("prime256v1"); e.generateKeys(); } while (e.getPrivateKey("hex").length === 64);
  const file = join(mkdtempSync(join(tmpdir(), "pc-keys-")), "keys.json");
  writeFileSync(file, JSON.stringify({ v: 1, sig_d: e.getPrivateKey("hex"), seal_d: e.getPrivateKey("hex"), seal_pub: e.getPublicKey("hex", "uncompressed") }));
  const keys = await loadOrCreateKeys(file);
  assert.ok(keys.seal.priv);
});
