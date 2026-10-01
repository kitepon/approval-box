#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { Api, ServerError } from "./api.ts";
import { OFFICIAL_SERVER, readConfig, requireConfig, writeConfig } from "./config.ts";
import { daemonStatus, ensureDaemon, runDaemon } from "./daemon.ts";
import { CLIENT, HARNESSES, LABEL, type Target, detect, filesOf, instructionsFileOf, register, registered, unregister } from "./harness.ts";
import { INSTRUCTION_TEXT } from "./instructions.ts";
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
  request: "AIにApproval Boxが登録されていません。npx approval-box setup をやり直し、AIを再起動してください。",
  notify: "アプリの通知が届いていません。アプリの通知の許可を確かめてください。",
  delivery: "答えがAIへ届きませんでした。npx approval-box doctor で原因を確かめてください。",
};

const STEER_LABEL: Record<string, string> = {
  ready: "作業中の割り込みも使えます",
  restart_required: "作業中の割り込みは、開いているCodexをすべて閉じて開き直すと使えます。それまでは作業の区切りで届きます",
  disabled: "作業中の割り込みは使いません。答えは作業の区切りで届きます",
  failed: "作業中の割り込みを有効にできませんでした。答えは作業の区切りで届きます（npx approval-box doctor で原因を確かめられます）",
};


async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** 実行に要るファイルを ~/.approval-box/runtime/<版> へ複製する。hookには絶対pathが書かれるため、npxのキャッシュを指させない。 */
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
  out("\nこの端末をApproval Boxのアカウントに結びます。");
  out("アプリ（またはWeb版）の「端末を追加」で、次のQRコードを読むか、コードを入力してください。\n");
  out(await QRCode.toString(started.qr_url, { type: "terminal", small: true }));
  out(`  コード: ${started.code}`);
  out(`  URL:    ${started.qr_url}`);
  out(`  （10分で期限が切れます）\n`);
  for (;;) {
    const result = await api.call<{ status: string; token?: string; connection_id?: string }>("GET", `/pairing/${started.pairing_id}`, undefined, { "x-poll-secret": started.poll_secret });
    if (result.status === "claimed" && result.token) return { token: result.token, connection_id: result.connection_id! };
    if (result.status === "rejected") throw new Error("アプリで「心当たりがない」が押されました。もう一度 npx approval-box setup を実行してください。");
    if (result.status === "expired" || result.status === "delivered") throw new Error("ペアリングの期限が切れました。もう一度 npx approval-box setup を実行してください。");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function waitForChecks(api: Api, clients: string[]) {
  out("\n■ セットアップ確認");
  out("答えがAIまで届くことを確かめます。使うAIを開いて、こう言ってください:");
  out("\n    Approval Boxのsetup_testを実行して\n");
  out("AIがテストの申請を出します。アプリかWeb版で答えると、答えがAIへ届き、確認が終わります。");
  out("（AIを開いたままのものは、新しい会話で試すか、AIを再起動してください。終わるまで待ちます。Ctrl+C でやめても、あとで npx approval-box test で続けられます）\n");
  const shown = new Map<string, string>();
  for (;;) {
    const info = await api.call<{ connection_id: string; me: { setup: { checks: Check[] } } }>("GET", "/connection");
    const mine = info.me.setup.checks.filter((c) => c.connection_id === info.connection_id && clients.includes(c.client));
    for (const check of mine) {
      const line = `  ${check.client}: ${STATUS_LABEL[check.status] ?? check.status}${check.status === "failed" && check.failed_step ? ` — ${FAILED_HINT[check.failed_step] ?? ""}${check.detail ? `（${check.detail}）` : ""}` : ""}`;
      if (shown.get(check.client) !== line) { out(line); shown.set(check.client, line); }
    }
    if (mine.length && mine.every((c) => c.status === "passed")) {
      out("\nすべてのAIで確認が済みました。Approval Boxを使えます。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function setup() {
  const config = readConfig();
  const server = (option("server") ?? config?.server ?? process.env.APPROVAL_BOX_SERVER ?? OFFICIAL_SERVER).replace(/\/$/, "");
  const targets = selectedTargets();
  if (!targets.length) throw new Error("Claude Code・Codex・Cursor・Grok のどれも見つかりません。先にAIを入れるか、--only で指定してください。");

  out(`Approval Box ${VERSION} のセットアップ`);
  out(`サーバー: ${server}\n`);
  out("次のAIにApproval Boxを登録します。書き換えるファイル:");
  for (const target of targets) out(`  ${LABEL[target]}: ${filesOf(target).join(", ")}`);
  out("");
  if (targets.includes("claude")) out("・Claude Code の Stop hook は、すべての会話でターンが終わるたびに node を1回起動します（Approval Boxの申請が無ければすぐ終わります）。");
  if (targets.includes("codex")) out("・Codex は、作業中に答えを割り込ませるため hook も登録します。登録後に Codex の再起動が要ることがあります。");
  if (targets.includes("cursor") || targets.includes("grok")) out("・Cursor（止まっている時）と Grok は、申請の時にAIが背景で受信を起動します。");
  out(`・書き換える前のファイルは「${".approval-box-backup"}」を付けて控えます。元に戻すには npx approval-box uninstall。\n`);
  if (!flag("yes") && !/^y(es)?$/i.test(await ask("続けますか？ [y/N] "))) { out("やめました。"); return; }

  out("\nAIが毎回読む全体の指示に、次の一節を足すと、AIがApproval Boxを使うようになります（外す時は uninstall）。");
  out(`  「${INSTRUCTION_TEXT}」`);
  for (const target of targets) {
    const file = instructionsFileOf(target);
    out(`  ${LABEL[target]}: ${file ?? "会話の始まりのhook（hooks.json の sessionStart）で渡します"}`);
  }
  const instructions = !flag("no-instructions") && (flag("yes") || !/^n(o)?$/i.test(await ask("足しますか？ [Y/n] ")));

  const cli = installRuntime();
  const token = option("token") ?? (config?.server === server ? config?.token : undefined);
  let connection: { token: string; connection_id?: string };
  if (token) connection = { token };
  else connection = await pair(server, targets);
  writeConfig({ server, token: connection.token, ...(connection.connection_id ? { connection_id: connection.connection_id } : {}), device_name: option("name") ?? hostname() });
  const api = new Api({ server, token: connection.token });
  try {
    await api.call("GET", "/connection");
  } catch (error) {
    if (error instanceof ServerError && error.code === "network" && !option("server") && server !== OFFICIAL_SERVER) {
      throw new Error(`${error.message}\n前に保存した接続先（${server}）を使いました。公式サーバーを使うなら: npx approval-box setup --server ${OFFICIAL_SERVER}`);
    }
    throw error;
  }

  // ここからは複製した置き場のコードで登録する（hookに書かれるpathを固定するため）。
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [cli, "register", "--targets", targets.join(","), ...(instructions ? ["--instructions"] : [])], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("AIへの登録に失敗しました。");
  await api.call("PUT", "/connection/clients", { clients: targets.map((t) => CLIENT[t]), os: osName() });
  if (flag("no-test")) return;
  await waitForChecks(api, targets.map((t) => CLIENT[t]));
}

async function registerTargets() {
  const targets = (option("targets") ?? "").split(",").filter(Boolean) as Target[];
  let failed = false;
  for (const target of targets) {
    const result = await register(target, { instructions: flag("instructions") });
    const extra = result.steer ? `（${STEER_LABEL[result.steer.split(":")[0] ?? ""] ?? `作業中の割り込み: ${result.steer}`}）` : "";
    out(`  ${LABEL[target]}: ${result.status === "registered" ? "登録しました" : `失敗 — ${result.detail}`}${extra}`);
    if (result.status === "failed") failed = true;
  }
  ensureDaemon();
  out("\n登録したAIは、開いている会話を閉じて開き直すとApproval Boxを使えます。");
  if (failed) process.exit(1);
}

async function uninstall() {
  if (!flag("yes") && !/^y(es)?$/i.test(await ask("Approval Boxの登録を全部外し、この端末の接続を解除します。よろしいですか？ [y/N] "))) return;
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
  out("\nApproval Boxを外しました。npm install -g で入れた場合は、npm uninstall -g approval-box で本体も消せます。");
}

async function status() {
  const config = readConfig();
  out(`Approval Box ${VERSION}（${runtimeDir()}）`);
  if (!config?.token) { out("未接続です。npx approval-box setup を実行してください。"); return; }
  out(`サーバー: ${config.server}`);
  try {
    const info = await new Api(config).call<{ connection_id: string; label: string; clients: string[]; me: { setup: { verified: boolean; checks: Check[] }; plan: string } }>("GET", "/connection");
    out(`端末: ${info.label}  契約: ${info.me.plan}  セットアップ確認: ${info.me.setup.verified ? "済み" : "まだ"}`);
    for (const check of info.me.setup.checks.filter((c) => c.connection_id === info.connection_id)) out(`  ${check.client}: ${STATUS_LABEL[check.status] ?? check.status}${check.tested_at ? `（${check.tested_at}）` : ""}`);
  } catch (error) { out(`サーバー: ${(error as Error).message}`); }
  for (const target of HARNESSES) {
    if (!detect(target)) continue;
    const r = registered(target);
    out(`  ${LABEL[target]}: MCP ${r.mcp ? "登録済み" : "未登録"}${r.hooks === null ? "" : ` / hook ${r.hooks ? "登録済み" : "未登録"}`}${r.instructions === null ? "" : ` / 指示 ${r.instructions ? "あり" : "なし"}`}`);
  }
  const d = daemonStatus();
  out(`配送デーモン: ${d.running ? `動作中（pid ${d.pid}）` : "停止中（次の申請で起動します）"}`);
}

async function doctor() {
  const problems: string[] = [];
  const hints: string[] = [];
  const config = readConfig();
  if (!config?.token) problems.push("Approval Boxにつながっていません → npx approval-box setup");
  else {
    try { await new Api(config).call("GET", "/connection"); }
    catch (error) {
      problems.push(error instanceof ServerError && error.status === 401 ? "この端末の接続が外されています → npx approval-box setup" : `サーバーにつながりません: ${(error as Error).message}`);
    }
  }
  if (!existsSync(process.execPath)) problems.push(`node が見つかりません（${process.execPath}）`);
  for (const target of HARNESSES) {
    if (!detect(target)) continue;
    const r = registered(target);
    if (!r.mcp) problems.push(`${LABEL[target]}: MCPが登録されていません → npx approval-box setup --only ${target}`);
    if (r.hooks === false) problems.push(`${LABEL[target]}: hookが登録されていません → npx approval-box setup --only ${target}`);
    if (r.entry && !existsSync(r.entry)) problems.push(`${LABEL[target]}: 登録先のファイルがありません（${r.entry}）。node やApproval Boxを入れ直した時に起きます → npx approval-box setup`);
    // 足さないと選んだ人もいるので、問題ではなく案内にする
    if (r.mcp && r.instructions === false) hints.push(`${LABEL[target]}: 全体の指示にApproval Boxの一節がありません。AIが申請を出さない時は → npx approval-box setup --only ${target}`);
  }
  for (const hint of hints) out(`・${hint}`);
  if (!problems.length) out("問題は見つかりませんでした。届かない時は、AIに「Approval Boxのsetup_testを実行して」と言って、どこで止まるかを確かめてください。");
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
  out(`Approval Box ${VERSION}

  npx approval-box setup [--server URL] [--token TOKEN] [--only claude,codex,cursor,grok] [--no-instructions] [--yes]
      AIにApproval Boxを登録し、この端末をアカウントに結び、セットアップ確認まで行う
  npx approval-box test       接続テスト（AIに「Approval Boxのsetup_testを実行して」と言って確かめる）
  npx approval-box status     つながり、登録、確認の状態
  npx approval-box doctor     届かない時の原因を調べる
  npx approval-box uninstall  登録を全部外し、この端末の接続を解除する`);
}

/** Cursorの sessionStart hook。全体の指示の一節を会話へ渡す。 */
async function cursorContext() {
  for await (const _ of process.stdin) { /* 入力は使わない */ }
  out(JSON.stringify({ additional_context: `## Approval Box\n\n${INSTRUCTION_TEXT}` }));
}

const commands: Record<string, () => Promise<void> | void> = {
  setup, test, status, doctor, uninstall, help,
  register: registerTargets,
  "cursor-context": cursorContext,
  mcp: runMcp,
  daemon: runDaemon,
  version: () => { out(VERSION); },
};

const run = commands[command];
if (!run) { help(); process.exit(2); }
try {
  await run();
} catch (error) {
  process.stderr.write(`approval-box: ${(error as Error).message}\n`);
  process.exit(1);
}
