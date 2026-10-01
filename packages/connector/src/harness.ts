import * as steer from "aiterm-steer-delivery";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { writeJsonFile } from "./config.ts";
import { hasInstructions, removeInstructions, writeInstructions } from "./instructions.ts";
import { MCP_SERVER, PROFILE } from "./profile.ts";
import { runtimeEntry } from "./runtime.ts";

export const HARNESSES = ["claude", "codex", "cursor", "grok"] as const;
export type Target = (typeof HARNESSES)[number];
export const LABEL: Record<Target, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok" };
export const CLIENT: Record<Target, string> = { claude: "claude-code", codex: "codex", cursor: "cursor", grok: "grok" };

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const claudeJson = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"));
const cursorDir = () => process.env.CURSOR_HOME ?? join(homedir(), ".cursor");
export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
const grokDir = () => process.env.GROK_HOME ?? join(homedir(), ".grok");

/** 書き換えるファイル。setupの画面で利用者に見せる。 */
export function filesOf(target: Target): string[] {
  if (target === "claude") return [claudeJson(), join(claudeDir(), "settings.json")];
  if (target === "cursor") return [join(cursorDir(), "mcp.json"), join(cursorDir(), "hooks.json"), cursorCliConfig()];
  if (target === "codex") return [join(codexHome(), "config.toml"), join(codexHome(), "hooks.json")];
  return [join(grokDir(), "config.toml")];
}

/** AIが毎回読む全体の指示ファイル。Cursor（CLI）は全体の指示をファイルから読まないので、設定画面のUser Rulesへ貼ってもらう。 */
export function instructionsFileOf(target: Target): string | null {
  if (target === "claude") return join(claudeDir(), "CLAUDE.md");
  if (target === "codex") return join(codexHome(), "AGENTS.md");
  if (target === "grok") return join(grokDir(), "AGENTS.md");
  return null;
}

function onPath(command: string): string | null {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function detect(target: Target): boolean {
  if (target === "claude") return existsSync(claudeDir()) || !!onPath("claude");
  if (target === "codex") return existsSync(codexHome()) || !!onPath("codex");
  if (target === "cursor") return existsSync(cursorDir()) || !!onPath("cursor-agent");
  return existsSync(grokDir()) || !!onPath("grok");
}

/**
 * 設定へ書くnodeの起動先。HomebrewのCellar実体（版ごとのpath）は更新で消えるので、同じformulaの opt を使う。
 * それ以外（公式インストーラ・nvm・fnm・asdf・Windows）は実行中のnodeをそのまま使い、nodeを消した時は doctor が知らせる。
 */
export function stableNode(): string {
  try { return steer.setupNodeExecutable(process.execPath); } catch { return process.execPath; }
}

/** CursorでApproval Boxのtoolを使うたびに許可を聞かれないよう、cli-config.json の許可リストへ足すtool。 */
const CURSOR_TOOLS = ["list_my_decisions", "request_decision", "amend_decision", "cancel_decision", "get_decision", "setup_test", "confirm_setup_test"];
const cursorCliConfig = () => join(cursorDir(), "cli-config.json");
function setCursorPermissions(enable: boolean) {
  const file = cursorCliConfig();
  if (!existsSync(file) && !enable) return;
  backupOnce(file);
  const current = readJson(file);
  const permissions = (current.permissions as { allow?: string[]; deny?: string[] } | undefined) ?? {};
  const ours = new Set(CURSOR_TOOLS.map((tool) => `Mcp(${MCP_SERVER}:${tool})`));
  const allow = (permissions.allow ?? []).filter((rule) => !ours.has(rule));
  if (enable) allow.push(...ours);
  writeJsonFile(file, { ...current, permissions: { ...permissions, allow, deny: permissions.deny ?? [] } });
}

const registration = () => ({ command: stableNode(), args: [runtimeEntry("cli"), "mcp"] });

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
}

function backupOnce(file: string) {
  const copy = `${file}${PROFILE.backup_suffix}`;
  if (existsSync(file) && !existsSync(copy)) copyFileSync(file, copy);
}

function setMcpJson(file: string, value: Record<string, unknown> | null) {
  backupOnce(file);
  const current = readJson(file);
  const servers = { ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  if (value) servers[MCP_SERVER] = value;
  else delete servers[MCP_SERVER];
  writeJsonFile(file, { ...current, mcpServers: servers });
}

async function withCodexConfig<T>(fn: (request: (method: string, params: unknown) => Promise<any>) => Promise<T>) {
  return steer.withCodexReceiver(PROFILE, { thread_id: "00000000-0000-4000-8000-000000000000", codex_home: codexHome() }, fn);
}

export type RegisterResult = { target: Target; status: "registered" | "removed" | "failed"; detail?: string; steer?: string };

export async function register(target: Target, options: { instructions?: boolean } = {}): Promise<RegisterResult> {
  const file = instructionsFileOf(target);
  if (options.instructions && file) {
    try { writeInstructions(file); } catch (error) { return { target, status: "failed", detail: `${file}: ${(error as Error).message}` }; }
  }
  const hook = (kind: "claude" | "cursor") => ({ command: stableNode(), script: runtimeEntry(kind) });
  try {
    if (target === "claude") {
      setMcpJson(claudeJson(), { type: "stdio", ...registration() });
      steer.mergeClaudeParentHooks(PROFILE, join(claudeDir(), "settings.json"), hook("claude"));
      return { target, status: "registered" };
    }
    if (target === "cursor") {
      setMcpJson(join(cursorDir(), "mcp.json"), registration());
      steer.mergeCursorParentHooks(PROFILE, join(cursorDir(), "hooks.json"), hook("cursor"));
      setCursorPermissions(true);
      return { target, status: "registered" };
    }
    if (target === "codex") {
      // CodexはMCPへ決まった環境変数しか渡さない。CODEX_HOMEを渡さないと、MCPは別のCODEX_HOME（~/.codex）を親だと思い、hookの確認に失敗する。
      const config = join(codexHome(), "config.toml");
      backupOnce(config);
      await withCodexConfig(async (request) => {
        await request("config/batchWrite", { filePath: config, edits: [{ keyPath: `mcp_servers.${MCP_SERVER}`, value: { ...registration(), env_vars: ["CODEX_HOME"] }, mergeStrategy: "replace" }] });
      });
      // 作業中のturnへの割り込み（Steer）。有効にできなくても、公式キューでの配送（turnの区切り）は使える。
      let steerStatus: string;
      try {
        const result = await steer.configureCodexSteer(PROFILE, "enable", { hook: runtimeEntry("codex"), codex_home: codexHome(), node: stableNode() });
        steerStatus = result.status + (result.reason_code ? `:${result.reason_code}` : "");
      } catch (error) {
        steerStatus = `failed:${(error as { code?: string }).code ?? (error as Error).message}`;
      }
      return { target, status: "registered", steer: steerStatus };
    }
    const grok = onPath("grok");
    if (!grok) throw new Error("grok コマンドが見つかりません");
    backupOnce(join(grokDir(), "config.toml"));
    const reg = registration();
    execFileSync(grok, ["mcp", "add", MCP_SERVER, "--scope", "user", reg.command, "--", ...reg.args], { stdio: "pipe" });
    return { target, status: "registered" };
  } catch (error) {
    return { target, status: "failed", detail: (error as Error).message };
  }
}

export async function unregister(target: Target): Promise<RegisterResult> {
  try {
    const file = instructionsFileOf(target);
    if (file) removeInstructions(file);
    if (target === "claude") {
      if (existsSync(claudeJson())) setMcpJson(claudeJson(), null);
      steer.removeClaudeParentHooks(PROFILE, join(claudeDir(), "settings.json"));
    } else if (target === "cursor") {
      if (existsSync(join(cursorDir(), "mcp.json"))) setMcpJson(join(cursorDir(), "mcp.json"), null);
      steer.removeCursorParentHooks(PROFILE, join(cursorDir(), "hooks.json"));
      setCursorPermissions(false);
    } else if (target === "codex") {
      if (existsSync(join(codexHome(), "config.toml"))) {
        await withCodexConfig(async (request) => {
          await request("config/batchWrite", { filePath: join(codexHome(), "config.toml"), edits: [{ keyPath: `mcp_servers.${MCP_SERVER}`, value: null, mergeStrategy: "replace" }] });
        });
      }
      try { await steer.configureCodexSteer(PROFILE, "disable", { hook: runtimeEntry("codex"), codex_home: codexHome() }); } catch { /* 有効にしていなければよい */ }
    } else {
      const grok = onPath("grok");
      if (grok) execFileSync(grok, ["mcp", "remove", MCP_SERVER, "--scope", "user"], { stdio: "pipe" });
    }
    return { target, status: "removed" };
  } catch (error) {
    return { target, status: "failed", detail: (error as Error).message };
  }
}

/** 登録が今も効いているか（doctor用）。 */
export function registered(target: Target): { mcp: boolean; hooks: boolean | null; instructions: boolean | null; entry?: string } {
  const file = instructionsFileOf(target);
  return { ...registeredTools(target), instructions: file ? hasInstructions(file) : null };
}

function registeredTools(target: Target): { mcp: boolean; hooks: boolean | null; entry?: string } {
  const entryOf = (value: unknown) => ((value as { args?: string[] } | undefined)?.args ?? [])[0];
  if (target === "claude") {
    const entry = (readJson(claudeJson()).mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER];
    const settings = JSON.stringify(readJson(join(claudeDir(), "settings.json")));
    const e = entryOf(entry);
    return { mcp: !!entry, hooks: settings.includes(PROFILE.hooks.claude), ...(e ? { entry: e } : {}) };
  }
  if (target === "cursor") {
    const entry = (readJson(join(cursorDir(), "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER];
    const e = entryOf(entry);
    return { mcp: !!entry, hooks: steer.cursorParentHooksRegistered(PROFILE, readJson(join(cursorDir(), "hooks.json"))), ...(e ? { entry: e } : {}) };
  }
  if (target === "codex") {
    const toml = existsSync(join(codexHome(), "config.toml")) ? readFileSync(join(codexHome(), "config.toml"), "utf8") : "";
    return { mcp: toml.includes(`[mcp_servers.${MCP_SERVER}]`), hooks: null };
  }
  const toml = existsSync(join(grokDir(), "config.toml")) ? readFileSync(join(grokDir(), "config.toml"), "utf8") : "";
  return { mcp: toml.includes(MCP_SERVER), hooks: null };
}

export const configDirOf = (target: Target) => dirname(filesOf(target)[0]!);
