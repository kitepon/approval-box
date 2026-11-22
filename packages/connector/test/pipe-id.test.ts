// SEC-087: the Windows pipe name carries a random id from state/pc/pipe-id, so another account cannot derive it from the state root.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pipeId, pipeName, socketPath } from "../src/local-api.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ab-pipeid-"));

test("pipeName depends on the id, not on the root alone", () => {
  const a = pipeName("/r", "a".repeat(32));
  const b = pipeName("/r", "b".repeat(32));
  assert.notEqual(a, b);
  assert.ok(a.includes("a".repeat(32)));
  assert.match(a, /^\\\\\.\\pipe\\approval-box-[0-9a-f]{16}-a{32}$/);
});

test("pipeId: read-only finds nothing, create writes 0600 under a 0700 pc dir and the next call reuses it", () => {
  const root = tmp();
  try {
    assert.equal(pipeId(root), undefined);
    assert.equal(pipeId(root, { create: false }), undefined);
    const id = pipeId(root, { create: true })!;
    assert.match(id, /^[0-9a-f]{32}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(root, "pc")).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "pc", "pipe-id")).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(join(root, "pc", "pipe-id"), "utf8").trim(), id);
    assert.equal(pipeId(root, { create: true }), id);
    assert.equal(pipeId(root), id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pipeId: a damaged file is read as missing and replaced only by the daemon", () => {
  const root = tmp();
  try {
    pipeId(root, { create: true });
    writeFileSync(join(root, "pc", "pipe-id"), "../evil");
    assert.equal(pipeId(root), undefined);
    assert.match(pipeId(root, { create: true })!, /^[0-9a-f]{32}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two state roots with different ids give different names; socketPath on non-win32 is unchanged", () => {
  const root = tmp();
  try {
    assert.notEqual(pipeId(root, { create: true }), undefined);
    if (process.platform !== "win32") assert.equal(socketPath(root), join(root, "pc", "daemon.sock"));
    if (process.platform !== "win32") assert.equal(socketPath(root, true), join(root, "pc", "daemon.sock"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("socketPath with platform win32: name follows the id file; a client without the file gets a fresh unopenable name and creates nothing", () => {
  const root = tmp();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const first = socketPath(root);
    assert.notEqual(first, socketPath(root));
    assert.equal(pipeId(root), undefined);
    const made = socketPath(root, true);
    assert.equal(made, pipeName(root, pipeId(root)!));
    assert.equal(socketPath(root), made);
  } finally { Object.defineProperty(process, "platform", platform); rmSync(root, { recursive: true, force: true }); }
});
