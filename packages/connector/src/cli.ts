#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { Api, ServerError } from "./api.ts";
import { OFFICIAL_SERVER, readConfig, requireConfig, writeConfig } from "./config.ts";
import { daemonStatus, ensureDaemon, runDaemon } from "./daemon.ts";
import { CLIENT, HARNESSES, LABEL, type Target, detect, filesOf, register, registered, unregister } from "./harness.ts";
import { runMcp } from "./mcp.ts";
import { home } from "./profile.ts";
import { runtimeDir } from "./runtime.ts";
import { VERSION, osName } from "./version.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const out = (line = "") => process.stdout.write(`${line}\n`);

type Check = { connection_id: string; client: string; status: string; failed_step?: string; detail?: string; tested_at?: string };
const STATUS_LABEL: Record<string, string> = {
  untested: "未テスト", waiting_answer: "答え待ち（アプリかWeb版で答えてください）", waiting_ai: "AIへ配送中", passed: "✓ 確認済み", failed: "✗ 失敗",
};
const FAILED_HINT: Record<string, string> = {
  request: "AIに決裁箱が登録されていません。kessaibako setup をやり直し、AIを再起動してください。",
  notify: "アプリの通知が届いていません。アプリの通知の許可を確かめてください。",
  delivery: "答えがAIへ届きませんでした。kessaibako doctor で原因を確かめてください。",
};

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** 実行に要るファイルを ~/.kessaibako/runtime/<版> へ複製する。hookには絶対pathが書かれるため、npxのキャッシュを指させない。 */
function installRuntime(): string {
  const target = join(home(), "runtime", VERSION);
  if (runtimeDir() !== target) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(runtimeDir(), target, { recursive: true });
  }
  return join(target, "cli.mjs");
}

function selectedTargets(): Target[] {
  const only = option("only");
  if (only) {
    const names = only.split(",").map((s) => s.trim()) as Target[];
    for (const name of names) if (!HARNESSES.includes(name)) throw new Error(`--only に指定できるのは ${HARNESSES.join(",")} です`);
    return names;
  }
  return HARNESSES.filter(detect);
}

async function pair(server: string, targets: Target[]): Promise<{ token: string; connection_id: string }> {
  const api = new Api({ server });
  const deviceName = option("name") ?? hostname();
  const started = await api.call<{ pairing_id: string; code: string; qr_url: string; poll_secret: string; expires_at: string }>("POST", "/pairing", {
    device_name: deviceName, os: osName(), clients: targets.map((t) => CLIENT[t]),
  });
  out("\nこの端末を決裁箱のアカウントに結びます。");
  out("アプリ（またはWeb版）の「端末を追加」で、次のQRコードを読むか、コードを入力してください。\n");
  out(await QRCode.toString(started.qr_url, { type: "terminal", small: true }));
  out(`  コード: ${started.code}`);
  out(`  URL:    ${started.qr_url}`);
  out(`  （10分で期限が切れます）\n`);
  for (;;) {
    const result = await api.call<{ status: string; token?: string; connection_id?: string }>("GET", `/pairing/${started.pairing_id}`, undefined, { "x-poll-secret": started.poll_secret });
    if (result.status === "claimed" && result.token) return { token: result.token, connection_id: result.connection_id! };
    if (result.status === "rejected") throw new Error("アプリで「心当たりがない」が押されました。もう一度 kessaibako setup を実行してください。");
    if (result.status === "expired" || result.status === "delivered") throw new Error("ペアリングの期限が切れました。もう一度 kessaibako setup を実行してください。");
  }
}

async function waitForChecks(api: Api, clients: string[]) {
  out("\n■ セットアップ確認");
  out("答えがAIまで届くことを確かめます。使うAIを開いて、こう言ってください:");
  out("\n    決裁箱のテストをして\n");
  out("AIがテストの申請を出します。アプリかWeb版で答えると、答えがAIへ届き、確認が終わります。");
  out("（AIを開いたままのものは、新しい会話で試すか、AIを再起動してください。終わるまで待ちます。Ctrl+C でやめても、あとで kessaibako test で続けられます）\n");
  const shown = new Map<string, string>();
  for (;;) {
    const info = await api.call<{ connection_id: string; me: { setup: { checks: Check[] } } }>("GET", "/connection");
    const mine = info.me.setup.checks.filter((c) => c.connection_id === info.connection_id && clients.includes(c.client));
    for (const check of mine) {
      const line = `  ${check.client}: ${STATUS_LABEL[check.status] ?? check.status}${check.status === "failed" && check.failed_step ? ` — ${FAILED_HINT[check.failed_step] ?? ""}${check.detail ? `（${check.detail}）` : ""}` : ""}`;
      if (shown.get(check.client) !== line) { out(line); shown.set(check.client, line); }
    }
    if (mine.length && mine.every((c) => c.status === "passed")) {
      out("\nすべてのAIで確認が済みました。決裁箱を使えます。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function setup() {
  const config = readConfig();
  const server = (option("server") ?? config?.server ?? process.env.KESSAIBAKO_SERVER ?? OFFICIAL_SERVER).replace(/\/$/, "");
  const targets = selectedTargets();
  if (!targets.length) throw new Error("Claude Code・Codex・Cursor・Grok のどれも見つかりません。先にAIを入れるか、--only で指定してください。");

  out(`決裁箱 ${VERSION} のセットアップ`);
  out(`サーバー: ${server}\n`);
  out("次のAIに決裁箱を登録します。書き換えるファイル:");
  for (const target of targets) out(`  ${LABEL[target]}: ${filesOf(target).join(", ")}`);
  out("");
  if (targets.includes("claude")) out("・Claude Code の Stop hook は、すべての会話でターンが終わるたびに node を1回起動します（決裁箱の申請が無ければすぐ終わります）。");
  if (targets.includes("codex")) out("・Codex は、作業中に答えを割り込ませるため hook も登録します。登録後に Codex の再起動が要ることがあります。");
  if (targets.includes("cursor") || targets.includes("grok")) out("・Cursor（止まっている時）と Grok は、申請の時にAIが背景で受信を起動します。");
  out(`・書き換える前のファイルは「${".kessaibako-backup"}」を付けて控えます。元に戻すには kessaibako uninstall。\n`);
  if (!flag("yes") && !/^y(es)?$/i.test(await ask("続けますか？ [y/N] "))) { out("やめました。"); return; }

  const cli = installRuntime();
  const token = option("token") ?? (config?.server === server ? config?.token : undefined);
  let connection: { token: string; connection_id?: string };
  if (token) connection = { token };
  else connection = await pair(server, targets);
  writeConfig({ server, token: connection.token, ...(connection.connection_id ? { connection_id: connection.connection_id } : {}), device_name: option("name") ?? hostname() });
  const api = new Api({ server, token: connection.token });
  await api.call("GET", "/connection");

  // ここからは複製した置き場のコードで登録する（hookに書かれるpathを固定するため）。
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [cli, "register", "--targets", targets.join(",")], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("AIへの登録に失敗しました。");
  await api.call("PUT", "/connection/clients", { clients: targets.map((t) => CLIENT[t]), os: osName() });
  if (flag("no-test")) return;
  await waitForChecks(api, targets.map((t) => CLIENT[t]));
}

async function registerTargets() {
  const targets = (option("targets") ?? "").split(",").filter(Boolean) as Target[];
  let failed = false;
  for (const target of targets) {
    const result = await register(target);
    const extra = result.steer ? `（割り込み: ${result.steer}）` : "";
    out(`  ${LABEL[target]}: ${result.status === "registered" ? "登録しました" : `失敗 — ${result.detail}`}${extra}`);
    if (result.status === "failed") failed = true;
  }
  ensureDaemon();
  out("\n登録したAIは、開いている会話を閉じて開き直すと決裁箱を使えます。");
  if (failed) process.exit(1);
}

async function uninstall() {
  if (!flag("yes") && !/^y(es)?$/i.test(await ask("決裁箱の登録を全部外し、この端末の接続を解除します。よろしいですか？ [y/N] "))) return;
  for (const target of HARNESSES) {
    if (!detect(target)) continue;
    const result = await unregister(target);
    out(`  ${LABEL[target]}: ${result.status === "removed" ? "外しました" : `失敗 — ${result.detail}`}`);
  }
  const status = daemonStatus();
  if (status.running && status.pid) { try { process.kill(status.pid); } catch { /* 終わっている */ } }
  const config = readConfig();
  if (config?.token) {
    try { await new Api(config).call("DELETE", "/connection"); out("  サーバー: この端末の接続を解除しました"); }
    catch (error) { out(`  サーバー: 接続の解除に失敗しました（アプリの「接続」から外してください）: ${(error as Error).message}`); }
  }
  rmSync(join(home(), "config.json"), { force: true });
  out("\n決裁箱を外しました。npm uninstall -g kessaibako で本体も消せます。");
}

async function status() {
  const config = readConfig();
  out(`決裁箱 ${VERSION}（${runtimeDir()}）`);
  if (!config?.token) { out("未接続です。kessaibako setup を実行してください。"); return; }
  out(`サーバー: ${config.server}`);
  try {
    const info = await new Api(config).call<{ connection_id: string; label: string; clients: string[]; me: { setup: { verified: boolean; checks: Check[] }; plan: string } }>("GET", "/connection");
    out(`端末: ${info.label}  契約: ${info.me.plan}  セットアップ確認: ${info.me.setup.verified ? "済み" : "まだ"}`);
    for (const check of info.me.setup.checks.filter((c) => c.connection_id === info.connection_id)) out(`  ${check.client}: ${STATUS_LABEL[check.status] ?? check.status}${check.tested_at ? `（${check.tested_at}）` : ""}`);
  } catch (error) { out(`サーバー: ${(error as Error).message}`); }
  for (const target of HARNESSES) {
    if (!detect(target)) continue;
    const r = registered(target);
    out(`  ${LABEL[target]}: MCP ${r.mcp ? "登録済み" : "未登録"}${r.hooks === null ? "" : ` / hook ${r.hooks ? "登録済み" : "未登録"}`}`);
  }
  const d = daemonStatus();
  out(`配送デーモン: ${d.running ? `動作中（pid ${d.pid}）` : "停止中（次の申請で起動します）"}`);
}

async function doctor() {
  const problems: string[] = [];
  const config = readConfig();
  if (!config?.token) problems.push("決裁箱につながっていません → kessaibako setup");
  else {
    try { await new Api(config).call("GET", "/connection"); }
    catch (error) {
      problems.push(error instanceof ServerError && error.status === 401 ? "この端末の接続が外されています → kessaibako setup" : `サーバーにつながりません: ${(error as Error).message}`);
    }
  }
  if (!existsSync(process.execPath)) problems.push(`node が見つかりません（${process.execPath}）`);
  for (const target of HARNESSES) {
    if (!detect(target)) continue;
    const r = registered(target);
    if (!r.mcp) problems.push(`${LABEL[target]}: MCPが登録されていません → kessaibako setup --only ${target}`);
    if (r.hooks === false) problems.push(`${LABEL[target]}: hookが登録されていません → kessaibako setup --only ${target}`);
    if (r.entry && !existsSync(r.entry)) problems.push(`${LABEL[target]}: 登録先のファイルがありません（${r.entry}）。node や決裁箱を入れ直した時に起きます → kessaibako setup`);
  }
  if (!problems.length) out("問題は見つかりませんでした。届かない時は、AIに「決裁箱のテストをして」と言って、どこで止まるかを確かめてください。");
  else for (const problem of problems) out(`✗ ${problem}`);
  if (problems.length) process.exitCode = 1;
}

async function test() {
  const config = requireConfig();
  const api = new Api(config);
  const info = await api.call<{ clients: string[] }>("GET", "/connection");
  ensureDaemon();
  await waitForChecks(api, info.clients);
}

function help() {
  out(`決裁箱 ${VERSION}

  kessaibako setup [--server URL] [--token TOKEN] [--only claude,codex,cursor,grok] [--yes]
      AIに決裁箱を登録し、この端末をアカウントに結び、セットアップ確認まで行う
  kessaibako test       接続テスト（AIに「決裁箱のテストをして」と言って確かめる）
  kessaibako status     つながり、登録、確認の状態
  kessaibako doctor     届かない時の原因を調べる
  kessaibako uninstall  登録を全部外し、この端末の接続を解除する`);
}

const commands: Record<string, () => Promise<void> | void> = {
  setup, test, status, doctor, uninstall, help,
  register: registerTargets,
  mcp: runMcp,
  daemon: runDaemon,
  version: () => { out(VERSION); },
};

const run = commands[command];
if (!run) { help(); process.exit(2); }
try {
  await run();
} catch (error) {
  process.stderr.write(`kessaibako: ${(error as Error).message}\n`);
  process.exit(1);
}
