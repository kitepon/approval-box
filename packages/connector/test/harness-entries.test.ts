import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("harness entries are exactly what register writes for Claude and Cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "approval-box-entries-"));
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(root, "claude"), CURSOR_HOME: join(root, "cursor"), APPROVAL_BOX_HOME: join(root, "ab") });
  try {
    const { harnessEntries, register } = await import("../src/harness.ts");
    assert.equal((await register("claude")).status, "registered");
    assert.equal((await register("cursor")).status, "registered");
    const entries = harnessEntries();
    const server = entries.mcpServers["approval-box"];
    assert.deepEqual(readJson(join(root, "claude", ".claude.json")).mcpServers["approval-box"], server.claude);
    assert.deepEqual(readJson(join(root, "claude", "settings.json")).hooks, entries.hooks.claude);
    assert.deepEqual(readJson(join(root, "cursor", "mcp.json")).mcpServers["approval-box"], server.cursor);
    assert.deepEqual(readJson(join(root, "cursor", "hooks.json")).hooks, entries.hooks.cursor);
    assert.deepEqual(readJson(join(root, "cursor", "cli-config.json")).permissions.allow, entries.permissions.cursor.allow);
    // Codex and Grok share registration(); Codex adds only the forwarded env name.
    assert.deepEqual(server.codex, { ...server.cursor, env_vars: ["CODEX_HOME"] });
    assert.deepEqual(server.grok, server.cursor);
    assert.equal(entries.schema, "bellteam.harness-entries.v1");
    for (const name of entries.owns.commandIncludes) assert.ok(JSON.stringify(entries.hooks).includes(name));
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("harness-entries refuses argv errors and a non-installed runtime with empty stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-box-entries-cli-"));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: root, APPROVAL_BOX_HOME: root } });
  try {
    const source = run(["harness-entries", "--json"]);
    assert.equal(source.status, 1);
    assert.equal(source.stdout, "");
    assert.match(source.stderr, /APPROVAL_BOX_RUNTIME_NOT_INSTALLED/);
    const usage = run(["harness-entries"]);
    assert.equal(usage.status, 1);
    assert.equal(usage.stdout, "");
    assert.match(usage.stderr, /Usage: approval-box harness-entries --json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
