#!/usr/bin/env node
// 決裁箱の配送の実機試験。サーバーをこのprocessの中で立て、本物のAI（harness）にコネクタを試験用projectの中だけで登録し、
// AIの申請 → 利用者の答え → AIの会話へ配送、を idle中・作業中・連続で確かめる。セットアップ確認（確認コードの往復）も通す。
// 共有HOMEのユーザー設定（~/.claude/settings.json 等）には触れない。~/.kessaibako の config.json だけ試験中に差し替えて戻す。
// 使い方: npm run build -w packages/connector && node tools/e2e/parent-e2e.mjs <claude-code|codex-cli|cursor-cli|grok-cli>
// Aitermを別の場所から起動する時は AITERM_CMD='["node","/path/to/aiterm-mcp/dist/index.js"]'。
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as steer from "aiterm-steer-delivery";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../../packages/server/src/accounts.ts";
import { openDb } from "../../packages/server/src/db.ts";
import { Decisions } from "../../packages/server/src/decisions.ts";
import { EventHub } from "../../packages/server/src/events.ts";
import { createApp } from "../../packages/server/src/http.ts";
import { PROFILE } from "../../packages/connector/src/profile.ts";

const harness = process.argv[2];
if (!["claude-code", "codex-cli", "cursor-cli", "grok-cli"].includes(harness)) { console.error("usage: parent-e2e.mjs <claude-code|codex-cli|cursor-cli|grok-cli>"); process.exit(2); }
const dist = fileURLToPath(new URL("../../packages/connector/dist/", import.meta.url));
if (!existsSync(join(dist, "cli.mjs"))) { console.error("先に npm run build -w packages/connector"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const node = process.execPath;

// ---- サーバー ----
const work = mkdtempSync(join(tmpdir(), `kb-e2e-${harness}-`));
const db = openDb(join(work, "kb.db"));
const events = new EventHub(db);
const accounts = new Accounts(db, events, "off");
const decisions = new Decisions(db, events);
let port = 0;
const app = createApp({ db, accounts, decisions, events, publicUrl: "http://127.0.0.1" });
const server = await new Promise((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { port = info.port; resolve(s); }); });
const serverUrl = `http://127.0.0.1:${port}`;
const userId = accounts.createUser();
const conn = accounts.createConnection(userId, "e2e", process.platform, [harness]);
const connection = { id: conn.id, user_id: userId };

// ---- コネクタの設定（~/.kessaibako/config.json を試験中だけ差し替える）----
const kbHome = process.env.KESSAIBAKO_HOME ?? join(homedir(), ".kessaibako");
const configFile = join(kbHome, "config.json");
const saved = existsSync(configFile) ? `${configFile}.e2e-saved` : null;
if (saved) copyFileSync(configFile, saved);
mkdirSync(kbHome, { recursive: true });
writeFileSync(configFile, JSON.stringify({ server: serverUrl, token: conn.token }), { mode: 0o600 });
// 別の試験の配送デーモンが残っていれば止める（古いサーバーを見ているため）。
try { const lock = JSON.parse((await import("node:fs")).readFileSync(join(kbHome, "state", "daemon.json"), "utf8")); process.kill(lock.pid); } catch {}

// ---- 試験用project（AIへの登録はここだけ）----
const project = join(work, "project");
mkdirSync(project);
const mcp = { command: node, args: [join(dist, "cli.mjs"), "mcp"] };
if (harness === "claude-code") {
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { kessaibako: { type: "stdio", ...mcp } } }, null, 1));
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true,
    permissions: { allow: ["mcp__kessaibako", "Bash(node:*)", "Bash(sleep:*)"] },
    hooks: steer.claudeParentHookEntries(PROFILE, { command: node, script: join(dist, "kessaibako-claude-hook.mjs") }) }, null, 1));
} else if (harness === "codex-cli") {
  mkdirSync(join(project, ".codex"));
  writeFileSync(join(project, ".codex", "config.toml"), `[mcp_servers.kessaibako]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(mcp.args)}\n`);
} else if (harness === "cursor-cli") {
  const cursorHome = join(project, ".cursor");
  mkdirSync(cursorHome);
  writeFileSync(join(cursorHome, "mcp.json"), JSON.stringify({ mcpServers: { kessaibako: { ...mcp, env: { CURSOR_HOME: cursorHome } } } }, null, 1));
  steer.mergeCursorParentHooks(PROFILE, join(cursorHome, "hooks.json"), { command: node, script: join(dist, "kessaibako-cursor-hook.mjs") });
} else {
  mkdirSync(join(project, ".grok"));
  writeFileSync(join(project, ".grok", "config.toml"), `[mcp_servers.kessaibako]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(mcp.args)}\n`);
}
log("server", serverUrl, "project", project);

// ---- 利用者の操作（アプリの代わり）----
const openOf = () => decisions.list(userId, ["pending", "held"], 50, 0).items;
const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(1500); }
  log("timeout:", label);
  return null;
};
const waitDecision = (title, ms = 240_000) => waitFor(() => openOf().find((d) => d.title === title), ms, `申請「${title}」`);
const answer = (d, option = d.options[0].id) => decisions.answer(userId, d.id, { option_id: option, version: d.version });
const deliveryOf = (id) => decisions.toApi(decisions.forUser(userId, id)).delivery;

// ---- Aitermで本物のAIを起動 ----
const aitermCommand = JSON.parse(process.env.AITERM_CMD ?? '["aiterm-mcp"]');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AITERM_")));
const client = new Client({ name: "kessaibako-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: aitermCommand[0], args: aitermCommand.slice(1), env, stderr: "ignore" }));
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
const clean = (r) => r.content.map((c) => c.text).join("\n").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/gu, "").replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/gu, "");
const seen = new Map();
const screen = async (sid) => {
  const now = clean(await call("pty_read", { session_id: sid, screen: true })) + "\n" + clean(await call("pty_read", { session_id: sid, full: true }));
  const kept = ((seen.get(sid) ?? "") + "\n" + now).slice(-200000);
  seen.set(sid, kept);
  return kept;
};
const waitScreen = async (sid, pattern, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pattern.test(await screen(sid))) return true; await sleep(2000); }
  return false;
};
const send = async (sid, text) => {
  for (const deadline = Date.now() + 300_000; ;) {
    const r = await call("pty_send", { session_id: sid, text });
    const message = r.isError ? clean(r) : "";
    if (!r.isError) return;
    if (!message.includes("完了待ち") || Date.now() > deadline) throw new Error(message);
    await sleep(10000);
  }
};

const background = harness === "cursor-cli" || harness === "grok-cli";
const options = `options [{"id":"a","label":"A"},{"id":"b","label":"B"}]`;
const rules = "You are testing the MCP server kessaibako (決裁箱). Follow these rules for the whole session:\n" +
  "- Whenever text starting with \"[決裁箱]\" reaches you, reply with exactly \"GOT <id>\" where <id> is the decision id in it (like K-ABC234). If that text contains 確認コード, first call the kessaibako tool confirm_setup_test with the decision_id and code written there.\n" +
  (background ? "- When a kessaibako tool result tells you to start a command as a background process, start it in the background (do not wait for it in the foreground). When it completes, its output JSON has deliveries[].text; handle them, then start next_wait_process the same way in the background.\n" : "") +
  "- Never call request_decision unless I ask, and never wait for answers yourself.\n" +
  "Now call the kessaibako tool setup_test. Then reply with exactly STARTED.";

const result = { harness, checks: {}, deliveries: {} };
let sid = null;
try {
  const launch = await call("agent_launch", { harness, cwd: project, trust_project: true, ...(harness === "cursor-cli" ? { model: "auto" } : {}) });
  if (launch.isError) throw new Error(clean(launch));
  sid = launch.structuredContent.session_id;
  log("session", sid);
  await send(sid, rules);

  // 1. セットアップ確認（idle中の配送 + AIが確認コードを返す）
  const test = await waitDecision("決裁箱の接続テスト", 300_000);
  result.checks.setup_requested = !!test;
  if (!test) throw new Error("接続テストの申請が来ません");
  await waitScreen(sid, /STARTED/u, 120_000);
  await sleep(harness === "claude-code" ? 5000 : 15000);
  answer(test);
  result.checks.setup_passed = !!(await waitFor(() => accounts.me(userId).setup.checks.find((c) => c.status === "passed"), 240_000, "セットアップ確認"));
  result.checks.idle1 = await waitScreen(sid, new RegExp(`GOT ${test.id}`, "u"), 120_000);
  result.deliveries[test.id] = deliveryOf(test.id);
  log("setup", result.checks.setup_passed, "idle1", result.checks.idle1);

  // 2. idle中の二通目
  await send(sid, `Call kessaibako request_decision with title "E2E idle", ${options}, session_label "e2e". Then reply with exactly REQUESTED1.`);
  const idle = await waitDecision("E2E idle");
  await waitScreen(sid, /REQUESTED1/u, 120_000);
  await sleep(10000);
  if (idle) answer(idle);
  result.checks.idle2 = !!idle && await waitScreen(sid, new RegExp(`GOT ${idle.id}`, "u"), 180_000);
  if (idle) result.deliveries[idle.id] = deliveryOf(idle.id);
  log("idle2", result.checks.idle2);

  // 3. 作業中の一通（AIが45秒のコマンドを前面で実行している間に答える）
  await send(sid, `Call kessaibako request_decision with title "E2E busy", ${options}, session_label "e2e". Then run this shell command in the foreground and wait for it: node -e "setTimeout(()=>console.log('SLEPT'),45000)" . After it finishes reply with exactly BUSYDONE.`);
  const busy = await waitDecision("E2E busy");
  await sleep(15000);
  if (busy) answer(busy);
  result.checks.busy = !!busy && await waitScreen(sid, new RegExp(`GOT ${busy.id}`, "u"), 240_000);
  result.checks.busy_done = await waitScreen(sid, /BUSYDONE/u, 180_000);
  if (busy) result.deliveries[busy.id] = deliveryOf(busy.id);
  log("busy", result.checks.busy, result.checks.busy_done);

  // 4. 連続の二通
  await send(sid, `Call kessaibako request_decision twice: title "E2E burst 1" and title "E2E burst 2", both with ${options}, session_label "e2e". Then reply with exactly REQUESTED2.`);
  const b1 = await waitDecision("E2E burst 1");
  const b2 = await waitDecision("E2E burst 2");
  await waitScreen(sid, /REQUESTED2/u, 120_000);
  await sleep(10000);
  if (b1) answer(b1);
  if (b2) answer(b2, "b");
  result.checks.burst = !!(b1 && b2) && await waitScreen(sid, new RegExp(`GOT ${b1.id}[\\s\\S]*GOT ${b2.id}|GOT ${b2.id}[\\s\\S]*GOT ${b1.id}`, "u"), 240_000);
  await sleep(8000);
  for (const d of [b1, b2]) if (d) result.deliveries[d.id] = deliveryOf(d.id);
  log("burst", result.checks.burst);
} catch (e) {
  result.error = e instanceof Error ? e.message.slice(0, 600) : String(e);
} finally {
  if (sid) {
    result.tail = (await screen(sid).catch(() => "")).split("\n").filter(Boolean).slice(-25).join("\n");
    await call("pty_close", { session_id: sid }).catch(() => {});
  }
  await sleep(5000);
  try { const lock = JSON.parse((await import("node:fs")).readFileSync(join(kbHome, "state", "daemon.json"), "utf8")); process.kill(lock.pid); } catch {}
  if (saved) { copyFileSync(saved, configFile); rmSync(saved); } else rmSync(configFile, { force: true });
  const table = process.platform === "win32"
    ? execFileSync("pwsh", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process).CommandLine"], { encoding: "utf8" })
    : execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
  result.leftover = table.split(/\r?\n/).filter((line) => line.includes(project) && !line.includes("ps -eo"));
  server.close();
  await client.close();
}
result.ok = Object.values(result.checks).every(Boolean) && Object.values(result.deliveries).every((d) => d === "delivered") && !result.error;
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
