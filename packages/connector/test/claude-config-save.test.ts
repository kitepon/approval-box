import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJsonFileInPlace } from "../src/config.ts";
import { register, unregister } from "../src/harness.ts";

test("direct save preserves the original on conflict or caught write failure, retaining recovery only if rollback fails", t => {
  const root = fs.mkdtempSync(join(tmpdir(), "ab-direct-save-"));
  const file = join(root, ".claude.json");
  const original = '\uFEFF{"other":"original configuration longer than replacement"}\n';
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, original);
  assert.throws(() => writeJsonFileInPlace(file, {}, "stale"), /変更/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(root), [".claude.json"]);
  const write = fs.writeSync;
  let calls = 0;
  const partial = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    calls++;
    if (calls === 1) return write(args[0], args[1] as Buffer, 0, 2, 0);
    if (calls === 2) throw new Error("fixture disk write failure");
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeJsonFileInPlace(file, { ok: true }, original), /fixture disk write failure/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(root), [".claude.json"]);
    calls = 0;
    partial.mock.mockImplementation(() => { throw new Error("fixture persistent write failure"); });
    assert.throws(() => writeJsonFileInPlace(file, {}, original), /元の内容の控え/);
    const recovery = fs.readdirSync(root).find(name => name.includes(".approval-box-restore-"))!;
    assert.equal(fs.readFileSync(join(root, recovery), "utf8"), original);
    fs.rmSync(join(root, recovery));
  } finally { partial.mock.restore(); syncBuiltinESMExports(); }
  writeJsonFileInPlace(file, { ok: true }, original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: true });
  assert.deepEqual(fs.readdirSync(root), [".claude.json"]);
  fs.rmSync(file);
  writeJsonFileInPlace(file, { created: true }, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { created: true });
  assert.throws(() => writeJsonFileInPlace(file, {}, null), { code: "EEXIST" });
});

test("only Windows Claude register/removal falls back from rename EPERM/EACCES, keeping foreign settings and MCPs", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "ab-claude-save-"));
  const file = join(root, ".claude.json");
  const original = { other: "keep", mcpServers: { foreign: { command: "foreign-command" } } };
  fs.writeFileSync(file, JSON.stringify(original));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const priorClaude = process.env.CLAUDE_CONFIG_DIR, priorHome = process.env.APPROVAL_BOX_HOME;
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.APPROVAL_BOX_HOME = join(root, "product");
  Object.defineProperty(process, "platform", { value: "win32" });
  const rename = fs.renameSync;
  let code = "EPERM", syscall = "rename";
  const blocked = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file) throw Object.assign(new Error("fixture denial"), { code, syscall });
    return rename(from, to);
  });
  const noWait = t.mock.method(Atomics, "wait", () => "timed-out" as const);
  syncBuiltinESMExports();
  try {
    assert.equal((await register("claude")).status, "registered");
    let saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.other, original.other);
    assert.deepEqual(saved.mcpServers.foreign, original.mcpServers.foreign);
    assert.equal(saved.mcpServers["approval-box"].type, "stdio");
    code = "EACCES";
    assert.equal((await unregister("claude")).status, "removed");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    for (const denied of ["EBUSY", "EIO"]) {
      code = denied;
      assert.equal((await register("claude")).status, "failed");
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    }
    code = "EPERM"; syscall = "open";
    assert.equal((await register("claude")).status, "failed");
    syscall = "rename";
    Object.defineProperty(process, "platform", { value: "linux" });
    assert.equal((await register("claude")).status, "failed");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    assert.equal(fs.readdirSync(root).filter(name => name.endsWith(".tmp") || name.includes(".approval-box-restore-")).length, 0);
  } finally {
    blocked.mock.restore(); noWait.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    if (priorHome === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
