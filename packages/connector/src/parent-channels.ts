import * as steer from "aiterm-steer-delivery";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "./config.ts";
import { claudeChannelIsCurrent } from "./claude-channel.ts";
import { PROFILE, stateRoot } from "./profile.ts";

export type Harness = "claude" | "codex" | "cursor" | "grok" | "other";

export function harnessOf(clientName: string | undefined): Harness {
  const name = clientName ?? "";
  if (name === "codex-mcp-client") return "codex";
  if (name === "claude-code") return "claude";
  if (name === "Cursor" || steer.isCursorMcpClient(name)) return "cursor";
  if (name.startsWith("grok")) return "grok";
  return "other";
}

// ---- 親の会話ごとのchannel ----

type ParentKey = string;
const parentsFile = () => join(stateRoot(), "parents.json");
const processChannels = new Map<ParentKey, string>();

function savedParents(): Record<ParentKey, string> {
  try { return existsSync(parentsFile()) ? (JSON.parse(readFileSync(parentsFile(), "utf8")) as Record<ParentKey, string>) : {}; } catch { return {}; }
}

function reuse(key: ParentKey, persistent: boolean): string | undefined {
  const id = persistent ? savedParents()[key] : processChannels.get(key);
  if (!id) return undefined;
  try { return steer.channelClosed(PROFILE, id) ? undefined : id; } catch { return undefined; }
}

function remember(key: ParentKey, channelId: string, persistent: boolean) {
  if (persistent) {
    const all = savedParents();
    all[key] = channelId;
    writeJsonFile(parentsFile(), all);
  } else processChannels.set(key, channelId);
}

/** 申請を出した会話（親）を特定し、その会話のchannelを返す。channelは会話ごとに使い回す。 */
export async function channelFor(harness: Harness, clientName: string | undefined, meta: unknown) {
  if (harness === "codex") {
    const parent = steer.codexParentFromRequest(clientName, meta);
    if (!parent) throw new Error("Codexの会話を特定できませんでした。Codexを更新してから試してください。");
    const key = `codex:${parent.codex_home}:${parent.thread_id}`;
    const existing = reuse(key, true);
    if (existing) return existing;
    // MCPが渡した元会話へ結ぶ。配送機構の状態や親アプリの起動時刻を、申請受付の条件にしない。
    const channel = steer.openChannel(PROFILE, parent);
    remember(key, channel.channel_id, true);
    return channel.channel_id;
  }
  if (harness === "claude") {
    const parent = steer.claudeParentFromRequest(PROFILE, clientName, meta, steer.claudeHookRoot(PROFILE));
    if (!parent) throw new Error("Claude Codeのhookが見つかりません。npx approval-box setup をやり直し、Claude Codeを再起動してください。");
    // /clear で session_id が変わる。依頼のたびに親を特定し、変わっていたら開き直す。
    const key = `claude:${parent.session_id}`;
    const existing = reuse(key, true);
    // アプリの起動し直しでは、session_id が同じままprocessが替わる。古いprocessに結んだchannelは使い回さない。
    // 古いchannelは閉じない。同じ会話の待機が、そこに残った答えも一緒に引き取る。
    if (existing && claudeChannelIsCurrent(PROFILE, existing, parent)) return existing;
    const channel = steer.openChannel(PROFILE, parent);
    remember(key, channel.channel_id, true);
    return channel.channel_id;
  }
  if (harness === "cursor") {
    steer.verifyCursorParent(PROFILE, { kind: "cursor", hook_root: steer.cursorHookRoot(PROFILE) });
    const key = "cursor";
    const existing = reuse(key, false);
    if (existing) return existing;
    const channel = steer.openChannel(PROFILE, { kind: "cursor" });
    remember(key, channel.channel_id, false);
    return channel.channel_id;
  }
  const key = "background";
  const existing = reuse(key, false);
  if (existing) return existing;
  const channel = steer.openChannel(PROFILE, null);
  remember(key, channel.channel_id, false);
  return channel.channel_id;
}

