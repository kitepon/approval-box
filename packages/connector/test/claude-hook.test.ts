import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as steer from "aiterm-steer-delivery";
import { PROFILE } from "../src/profile.ts";
import { registered } from "../src/harness.ts";
import { writeJsonFile } from "../src/config.ts";

const script = fileURLToPath(new URL("../src/hooks/claude.ts", import.meta.url));
const entries = steer.claudeParentHookEntries(PROFILE, { command: process.execPath, script });
const command = entries.Stop![0]!.hooks[0]!.command as string;

test("Claude registration migrates legacy hooks and doctor detects missing events", t => {
  const root = mkdtempSync(join(tmpdir(), "ab-hook-register-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(root, "settings.json");
  const registeredScript = join(root, PROFILE.hooks.claude);
  const foreign = { type: "command", command: "echo user-hook" };
  writeJsonFile(file, { hooks: { Stop: [{ hooks: [foreign, {
    type: "command", command: process.execPath, args: [join(root, PROFILE.hooks.claude)],
  }] }] } });
  steer.mergeClaudeParentHooks(PROFILE, file, { command: process.execPath, script: registeredScript });
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(registered("claude").hooks, true);
  assert.deepEqual(document.hooks.Stop[0].hooks, [foreign]);
  assert.equal(document.hooks.Stop[1].hooks[0].args, undefined);
  assert.equal(steer.mergeClaudeParentHooks(PROFILE, file, { command: process.execPath, script: registeredScript }), "unchanged");
  delete document.hooks.PreToolUse;
  writeJsonFile(file, document);
  assert.equal(registered("claude").hooks, false);
});

test("Grok Stop executes the connector hook through its shell command with exit 0", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "ab-grok-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ hookEventName: "Stop", hook_event_name: "Stop" }),
    env: { ...process.env, APPROVAL_BOX_HOME: root }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(root, "state")), false);
});

test("Claude Stop shell hook waits for a channel answer and returns asyncRewake exit 2", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ab-claude-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const hookRoot = join(root, "requests");
  const identity = steer.readRuntimeProcesses().find(p => p.pid === process.pid)!.started_identity;
  writeJsonFile(join(hookRoot, requestId, "request.json"), {
    session_id: sessionId, parent_pid: process.pid, parent_started_identity: identity,
  });
  const channel = steer.openChannel(profile, { kind: "claude", session_id: sessionId, request_id: requestId, hook_root: hookRoot });
  const child = spawn("sh", ["-c", command], { env: { ...process.env, APPROVAL_BOX_HOME: root } });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId }));
  const waiter = join(steer.channelRoot(profile), "claude-sessions", sessionId, "waiter.json");
  for (let i = 0; i < 150 && !existsSync(waiter); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(waiter), true, stderr);
  const deliveryId = randomUUID();
  await steer.sendToChannel(profile, channel.channel_id, deliveryId, "approval-box-stop-answer");
  assert.equal(await done, 2, stderr);
  assert.equal(stderr, "approval-box-stop-answer");
  assert.equal(steer.channelDeliveryState(profile, channel.channel_id, deliveryId), "emitted");
});
