#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { Api, ServerError } from "./api.ts";
import { OFFICIAL_SERVER, hostedFile, readConfig, renameWithRetry, requireConfig, writeConfig, writeJsonFile } from "./config.ts";
import { renameSync } from "node:fs";
import { admissionFile, pcPrepared, serverOffersPeerChannel, v1Connection } from "./pc-mode.ts";
import { daemonStatus, ensureDaemon, runDaemon } from "./daemon.ts";
import { exportConnection } from "./connection-export.ts";
import { CLIENT, HARNESSES, LABEL, type Target, detect, filesOf, harnessEntries, instructionsFileOf, register, registered, unregister } from "./harness.ts";
import { INSTRUCTION_TEXT, managedElsewhere } from "./instructions.ts";
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
    // node-datachannel と各OSのビルド済みの部品（peer-channel の道でだけ読む）。npm は node_modules の名前の置き場を配らないので、ここで名前を戻す。
    if (existsSync(join(target, "native"))) renameSync(join(target, "native"), join(target, "node_modules"));
  }
  const bin = join(home(), "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const launcher = join(bin, "approval-box");
  const temp = `${launcher}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(join(target, "cli.mjs")).href)};\n`, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameWithRetry(temp, launcher);
  } finally { rmSync(temp, { force: true }); }
  return launcher;
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

/**
 * peer-channel の鍵の結び付け（契約 5.4、c8c）。サーバーが peer_channel を出している時だけ、ペアリングの前に鍵と秘密を作り、
 * QRを PC1PAIR の形（アプリの読み取り口だけが読む。URLでない）にし、入力用の16文字を出す。答えの後に、アプリと pc1-join → pc1-admit を交わす。
 */
async function peerChannelBinding(server: string) {
  let offered: boolean;
  try { offered = await serverOffersPeerChannel(server); }
  catch (error) { out(`（peer-channel を使えるかサーバーに確かめられませんでした: ${(error as Error).message}。今の道でつなぎます）`); return null; }
  if (!offered) return null;
  const [{ loadOrCreateKeys }, { startPairingBinding }] = await Promise.all([import("./pc-keys.ts"), import("@kitepon/peer-channel/pairing")]);
  return startPairingBinding(await loadOrCreateKeys());
}

async function pair(server: string, targets: Target[]): Promise<{ token: string; connection_id: string }> {
  const api = new Api({ server });
  const deviceName = option("name") ?? hostname();
  const binding = await peerChannelBinding(server);
  const started = await api.call<{ pairing_id: string; code: string; qr_url: string; poll_secret: string; expires_at: string }>("POST", "/pairing", {
    device_name: deviceName, os: osName(), clients: targets.map((t) => CLIENT[t]),
  });
  out("\nこの端末をApproval Boxのアカウントに結びます。");
  out("アプリ（またはWeb版）の「端末を追加」で、次のQRコードを読むか、コードを入力してください。\n");
  out(await QRCode.toString(binding ? binding.qrText(started.code) : started.qr_url, { type: "terminal", small: true }));
  out(`  コード: ${started.code}`);
  if (binding) out(`  確かめの文字（コードと一緒にアプリへ入力）: ${binding.typedCode}`);
  else out(`  URL:    ${started.qr_url}`);
  out(`  （期限: ${new Date(started.expires_at).toLocaleString()}）\n`);
  for (;;) {
    const result = await api.call<{ status: string; token?: string; connection_id?: string }>("GET", `/pairing/${started.pairing_id}`, undefined, { "x-poll-secret": started.poll_secret });
    if (result.status === "claimed" && result.token) {
      if (binding) await finishBinding(server, result.token, binding);
      return { token: result.token, connection_id: result.connection_id! };
    }
    if (result.status === "rejected") throw new Error("アプリで「心当たりがない」が押されました。もう一度 npx approval-box setup を実行してください。");
    if (result.status === "expired" || result.status === "delivered") throw new Error("ペアリングの期限が切れました。もう一度 npx approval-box setup を実行してください。");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** ペアリングの答えの後、アプリと鍵を結ぶ。結べなければ名前付きで伝え、今の道のまま使える（peer-channel の道は、結べた時だけ）。 */
async function finishBinding(server: string, token: string, binding: NonNullable<Awaited<ReturnType<typeof peerChannelBinding>>>) {
  out("アプリと、この端末の鍵を結んでいます（最大5分）…");
  try {
    const info = await new Api({ server, token }).call<{ connection_id: string; me: { user_id: string } }>("GET", "/connection");
    const admission = await binding.complete({ server: { url: server, headers: { authorization: `Bearer ${token}` } }, connectionId: info.connection_id });
    writeJsonFile(admissionFile(), admission);
    out("鍵を結びました。申請と答えは、サーバーを通らずにこの端末とアプリの間で運ばれます。");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "binding_failed";
    out(`鍵を結べませんでした（${code}: ${(error as Error).message}）。この端末は今までの道で使えます。`);
  }
}

/**
 * pair --json（c8h）: 画面を見ない監督役のためのペアリング。状態ごとに1行のJSON（approval-box.pair.v1）を出し、bound の時だけ 0 で終わる。
 * 設定は claimed で保存（接続はそこから在る）、登録は bound で保存。結べなければ同じ接続を --rebind で結び直す。
 */
async function pairJson() {
  const emit = (state: string, fields: Record<string, unknown> = {}) => { out(JSON.stringify({ schema: "approval-box.pair.v1", state, ...fields })); };
  const fail = (code: string, message: string) => { emit("failed", { code, message }); process.exitCode = 1; };
  if (argv[1] === "status") {
    const config = readConfig();
    const path = !config?.token ? undefined : v1Connection() ? "v1" : pcPrepared() ? "peer_channel" : undefined;
    out(JSON.stringify({ schema: "approval-box.pair-status.v1", paired: path !== undefined, ...(config?.connection_id ? { connection_id: config.connection_id } : {}), ...(config?.server ? { server: config.server } : {}), ...(path ? { path } : {}) }));
    return;
  }
  if (flag("rebind")) {
    const config = readConfig();
    if (!config?.token) return fail("not_paired", "保存した接続がありません。approval-box pair --json でつないでください。");
    if (config.path === "v1") return fail("v1_connection", "この接続は /v1 の道です。鍵は使わないので、結び直しは要りません。");
    const { rebindKeys } = await import("./pc-rebind.ts");
    try {
      await rebindKeys({ server: config.server, token: config.token }, {
        show: (qrText, typedCode) => emit("waiting", { typed_secret: typedCode, qr_text: qrText, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }),
        restart: async () => { const st = daemonStatus(); if (st.running && st.pid) { try { process.kill(st.pid, "SIGTERM"); } catch { /* 既に終わっている */ } } }, // 監督役が起こし直す
      });
      emit("bound", { ...(config.connection_id ? { connection_id: config.connection_id } : {}) });
    } catch (error) { fail((error as { code?: string }).code ?? "binding_failed", (error as Error).message); }
    return;
  }
  const server = (option("server") ?? readConfig()?.server ?? process.env.APPROVAL_BOX_SERVER ?? OFFICIAL_SERVER).replace(/\/$/, "");
  // --v1: 鍵を結ばず、サーバーの /connector/v1 の道でつなぐ（peer_channel を出していないサーバーで、アプリのQR読み取りに使う）。
  const binding = flag("v1") ? null : await peerChannelBinding(server).catch(() => null);
  if (!binding && !flag("v1")) return fail("server_flag_off", "このサーバーは peer-channel を出していないか、確かめられません。");
  const api = new Api({ server });
  const deviceName = option("name") ?? hostname();
  const started = await api.call<{ pairing_id: string; code: string; qr_url: string; poll_secret: string; expires_at: string }>("POST", "/pairing", { device_name: deviceName, os: osName(), clients: [] });
  emit("waiting", { pairing_id: started.pairing_id, code: started.code, ...(binding ? { typed_secret: binding.typedCode } : {}), qr_text: binding ? binding.qrText(started.code) : started.qr_url, expires_at: started.expires_at });
  for (;;) {
    const result = await api.call<{ status: string; token?: string; connection_id?: string }>("GET", `/pairing/${started.pairing_id}`, undefined, { "x-poll-secret": started.poll_secret });
    if (result.status === "claimed" && result.token) {
      writeConfig({ server, token: result.token, ...(result.connection_id ? { connection_id: result.connection_id } : {}), device_name: deviceName, ...(binding ? {} : { path: "v1" as const }) });
      emit("claimed", { ...(result.connection_id ? { connection_id: result.connection_id } : {}), ...(binding ? {} : { path: "v1" }) });
      if (!binding) return; // /v1 の道には結ぶ鍵が無い。claimed で終わり（exit 0）
      try {
        const info = await new Api({ server, token: result.token }).call<{ connection_id: string; me: { user_id: string } }>("GET", "/connection");
        writeJsonFile(admissionFile(), await binding.complete({ server: { url: server, headers: { authorization: `Bearer ${result.token}` } }, connectionId: info.connection_id }));
        return emit("bound", { connection_id: info.connection_id });
      } catch (error) { return fail((error as { code?: string }).code ?? "binding_failed", `${(error as Error).message}（approval-box pair --json --rebind で同じ接続を結び直せます）`); }
    }
    if (result.status === "rejected") return fail("rejected", "アプリで「心当たりがない」が押されました。");
    if (result.status === "expired" || result.status === "delivered") return fail("expired", "ペアリングの期限が切れました。");
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

/** setup --rebind: ペアリング済みの接続に新しい鍵を結ぶ（peer-channel 契約 0.5.3）。製品のペアリングはやり直さない。 */
async function rebind() {
  const config = requireConfig();
  const { rebindKeys } = await import("./pc-rebind.ts");
  try {
    await rebindKeys(config, {
      show: async (text, typed) => {
        out("この端末の鍵を結び直します。アプリの「接続」で、次のQRコードを読むか、確かめの文字を入力してください（最大5分）。\n");
        out(await QRCode.toString(text, { type: "terminal", small: true }));
        out(`  確かめの文字: ${typed}\n`);
      },
      restart: async () => {
        // 新しい鍵で動かすため、配送デーモンを起こし直す。
        const status = daemonStatus();
        if (status.running && status.pid) { try { process.kill(status.pid); } catch { /* 既に終わっている */ } }
        for (let i = 0; i < 50 && daemonStatus().running; i++) await new Promise((r) => setTimeout(r, 200));
        ensureDaemon();
      },
    });
    out("鍵を結び直しました。申請と答えは、新しい鍵で運ばれます。");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "binding_failed";
    out(`鍵を結び直せませんでした（${code}: ${(error as Error).message}）。前の鍵のままです。`);
    process.exitCode = 1;
  }
}

async function setup() {
  if (flag("rebind")) return rebind();
  const config = readConfig();
  const server = (option("server") ?? config?.server ?? process.env.APPROVAL_BOX_SERVER ?? OFFICIAL_SERVER).replace(/\/$/, "");
  const targets = selectedTargets();
  if (!targets.length) throw new Error("Claude Code・Codex・Cursor・Grok のどれも見つかりません。先にAIを入れるか、--only で指定してください。");

  out(`Approval Box ${VERSION} のセットアップ`);
  out(`サーバー: ${server}\n`);
  // 席のCLI設定を一人で書く管理元（BellTeam）は、harness-entries --json を読んで自分で登録する。
  const noRegister = flag("no-register");
  if (noRegister) out(`AIの設定ファイルは書き換えません（登録は harness-entries --json を読む管理元が行います）。対象: ${targets.map((t) => LABEL[t]).join(", ")}\n`);
  else {
    out("次のAIにApproval Boxを登録します。書き換えるファイル:");
    for (const target of targets) out(`  ${LABEL[target]}: ${filesOf(target).join(", ")}`);
    out("");
  }
  if (targets.includes("claude")) out("・Claude Code の Stop hook と SessionStart hook は、すべての会話で、ターンが終わるたび・会話が始まるたびに node を1回起動します（Approval Boxの申請が無ければすぐ終わります）。");
  if (targets.includes("codex")) out("・Codex の答えは Aiterm の Steer で元の会話へ返します。旧版のApproval Box専用配送hookは撤去します。");
  if (targets.includes("cursor") || targets.includes("grok")) out("・Cursor（止まっている時）と Grok は、申請の時にAIが背景で受信を起動します。");
  out(`・書き換える前のファイルは「${".approval-box-backup"}」を付けて控えます。元に戻すには npx approval-box uninstall。\n`);
  if (!flag("yes") && !/^y(es)?$/i.test(await ask("続けますか？ [y/N] "))) { out("やめました。"); return; }

  if (!noRegister) out("\nAIが毎回読む全体の指示に、次の一節を足すと、AIがApproval Boxを使うようになります（外す時は uninstall）。");
  if (!noRegister) out(`  「${INSTRUCTION_TEXT}」`);
  for (const target of noRegister ? [] : targets) {
    const file = instructionsFileOf(target);
    const link = file ? managedElsewhere(file) : null;
    out(`  ${LABEL[target]}: ${!file ? "会話の始まりのhook（hooks.json の sessionStart）で渡します" : link ? `${file} は ${link} への参照で、別の所で管理されているので書きません（管理元の規範に一節を足してください）` : file}`);
  }
  const instructions = !noRegister && !flag("no-instructions") && (flag("yes") || !/^n(o)?$/i.test(await ask("足しますか？ [Y/n] ")));

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
  const result = spawnSync(process.execPath, [cli, "register", "--targets", noRegister ? "" : targets.join(","), ...(instructions ? ["--instructions"] : [])], { stdio: "inherit" });
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
    out(`  ${LABEL[target]}: ${result.status === "registered" ? "登録しました" : `失敗 — ${result.detail}`}`);
    if (result.note) out(`    ・${result.note}`);
    if (result.status === "failed") failed = true;
  }
  ensureDaemon();
  if (targets.length) out("\n登録したAIは、開いている会話を閉じて開き直すとApproval Boxを使えます。");
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
  rmSync(join(home(), "bin", "approval-box"), { force: true });
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
    if (r.mcp && r.instructions === false) {
      const file = instructionsFileOf(target);
      const link = file ? managedElsewhere(file) : null;
      hints.push(link
        ? `${LABEL[target]}: 全体の指示（${file} → ${link}）にApproval Boxの一節がありません。別の所で管理されているので、管理元の規範に「${INSTRUCTION_TEXT}」を足してください`
        : `${LABEL[target]}: 全体の指示にApproval Boxの一節がありません。AIが申請を出さない時は → npx approval-box setup --only ${target}`);
    }
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

  npx approval-box setup [--server URL] [--token TOKEN] [--only claude,codex,cursor,grok] [--no-instructions] [--no-register] [--yes]
      AIにApproval Boxを登録し、この端末をアカウントに結び、セットアップ確認まで行う
      --no-register: AIの設定は書かない（CLI設定を一人で書く管理元が harness-entries を読んで登録する）
  npx approval-box setup --rebind  ペアリング済みのこの端末に、新しい鍵を結び直す（peer-channel の道。製品のペアリングはやり直さない）
  npx approval-box install-runtime  固定の実行入口を入れる（接続・AI登録は変更しない）
  approval-box harness-entries --json  登録内容（MCP・hook・許可）をJSONで管理元へ渡す。固定の実行入口から呼ぶ
  npx approval-box test       接続テスト（AIに「Approval Boxのsetup_testを実行して」と言って確かめる）
  npx approval-box status     つながり、登録、確認の状態
  npx approval-box doctor     届かない時の原因を調べる
  approval-box pair --json --v1  鍵を結ばず /v1 の道でつなぐ（waiting の qr_text をアプリの「QRコードを読む」で読む。claimed で終わる）
  npx approval-box connection export --json  接続情報（秘密）をJSONで他のプログラムへ渡す
  npx approval-box uninstall  登録を全部外し、この端末の接続を解除する`);
}

/** Cursorの sessionStart hook。全体の指示の一節を会話へ渡す。 */
async function cursorContext() {
  for await (const _ of process.stdin) { /* 入力は使わない */ }
  out(JSON.stringify({ additional_context: `## Approval Box\n\n${INSTRUCTION_TEXT}` }));
}

const commands: Record<string, () => Promise<void> | void> = {
  setup, test, status, doctor, uninstall, help,
  "install-runtime": () => { out(installRuntime()); },
  "harness-entries": () => {
    if (argv.length !== 2 || argv[1] !== "--json") throw new Error("Usage: approval-box harness-entries --json");
    // npxのキャッシュや作業tree上のpathは消えるので、登録させない。
    if (runtimeDir() !== join(home(), "runtime", VERSION)) throw new Error("APPROVAL_BOX_RUNTIME_NOT_INSTALLED: run approval-box install-runtime, then invoke its stable executable");
    out(JSON.stringify(harnessEntries()));
  },
  connection: () => {
    if (argv.length !== 3 || argv[1] !== "export" || argv[2] !== "--json") throw new Error("Usage: approval-box connection export --json");
    out(JSON.stringify(exportConnection()));
  },
  register: registerTargets,
  "cursor-context": cursorContext,
  mcp: runMcp,
  // BellTeamの席（a514n）: 本体のデーモン（daemon --hosted）のソケットを使う。ペアリングは本体だけ。--off で今の道へ戻す。
  "use-hosted": () => {
    const socket = option("socket");
    if (!(argv.length === 3 && socket && !socket.startsWith("--")) && !(argv.length === 2 && flag("off"))) throw new Error("Usage: approval-box use-hosted --socket <path> | use-hosted --off");
    if (socket) writeJsonFile(hostedFile(), { socket });
    else rmSync(hostedFile(), { force: true });
    // 動いている席のデーモンを止める。次の道具の呼び出しで、新しい道のデーモンが起きる。
    const running = daemonStatus();
    if (running.running && running.pid) { try { process.kill(running.pid, "SIGTERM"); } catch { /* 既に終わっている */ } }
    out(JSON.stringify({ schema: "approval-box.use-hosted.v1", socket: socket ?? null }));
  },
  daemon: () => runDaemon({ hosted: flag("hosted") }),
  pair: () => { if (!flag("json")) throw new Error("Usage: approval-box pair --json [--server URL] [--name NAME] [--v1] | pair --json --rebind | pair status --json"); return pairJson(); },
  version: () => {
    if (argv.length === 2 && argv[1] === "--json") {
      out(JSON.stringify({ schema: "approval-box.version.v1", version: VERSION, capabilities: ["bellteam-requester-wake", "use-hosted"] }));
      return;
    }
    out(VERSION);
  },
};

const run = commands[command];
if (!run) { help(); process.exit(2); }
try {
  await run();
} catch (error) {
  process.stderr.write(`approval-box: ${(error as Error).message}\n`);
  process.exit(1);
}
