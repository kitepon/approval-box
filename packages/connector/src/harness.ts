import * as steer from "aiterm-steer-delivery";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { writeJsonFile } from "./config.ts";
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
  if (target === "cursor") return [join(cursorDir(), "mcp.json"), join(cursorDir(), "hooks.json")];
  if (target === "codex") return [join(codexHome(), "config.toml"), join(codexHome(), "hooks.json")];
  return [join(grokDir(), "config.toml")];
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

const registration = () => ({ command: process.execPath, args: [runtimeEntry("cli"), "mcp"] });

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

export async function register(target: Target): Promise<RegisterResult> {
  const hook = (kind: "claude" | "cursor") => ({ command: process.execPath, script: runtimeEntry(kind) });
  try {
    if (target === "claude") {
      setMcpJson(claudeJson(), { type: "stdio", ...registration() });
      steer.mergeClaudeParentHooks(PROFILE, join(claudeDir(), "settings.json"), hook("claude"));
      return { target, status: "registered" };
    }
    if (target === "cursor") {
      setMcpJson(join(cursorDir(), "mcp.json"), registration());
      steer.mergeCursorParentHooks(PROFILE, join(cursorDir(), "hooks.json"), hook("cursor"));
      return { target, status: "registered" };
    }
    if (target === "codex") {
      const config = join(codexHome(), "config.toml");
      backupOnce(config);
      await withCodexConfig(async (request) => {
        await request("config/batchWrite", { filePath: config, edits: [{ keyPath: `mcp_servers.${MCP_SERVER}`, value: registration(), mergeStrategy: "replace" }] });
      });
      // 作業中のturnへの割り込み（Steer）。有効にできなくても、公式キューでの配送（turnの区切り）は使える。
      let steerStatus: string;
      try {
        const result = await steer.configureCodexSteer(PROFILE, "enable", { hook: runtimeEntry("codex"), codex_home: codexHome() });
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
    if (target === "claude") {
      if (existsSync(claudeJson())) setMcpJson(claudeJson(), null);
      steer.removeClaudeParentHooks(PROFILE, join(claudeDir(), "settings.json"));
    } else if (target === "cursor") {
      if (existsSync(join(cursorDir(), "mcp.json"))) setMcpJson(join(cursorDir(), "mcp.json"), null);
      steer.removeCursorParentHooks(PROFILE, join(cursorDir(), "hooks.json"));
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
export function registered(target: Target): { mcp: boolean; hooks: boolean | null; entry?: string } {
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
