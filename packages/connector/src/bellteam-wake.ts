import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "./config.ts";
import { stateRoot } from "./profile.ts";

// shortcut: BellTeamの席のMCPの場所は固定。BellTeamが設定できるようにしたら、そこから読む。
export const BELLTEAM_MCP_URL = "http://127.0.0.1:4181/mcp";

const BOT_ID = /^bot-[a-z0-9]+$/;

/** BellTeamの席のBot ID。席名はBellTeamのseatCandidatesと同じ読み方（フォークの席と、別アカウントの接尾辞を除く）。 */
export function bellteamBotId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BELLTEAM_ROOT) return null;
  const seat = env.AITERM_SESSION_ID;
  if (!seat || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(seat) || seat.includes("-fork-")) return null;
  const botId = /^(.+)-(?:1st|2nd)-[a-z0-9]+$/.exec(seat)?.[1] ?? seat;
  return BOT_ID.test(botId) ? botId : null;
}

const requesterFile = (channelId: string) => join(stateRoot(), "bellteam-requesters", `${channelId}.json`);

/** 答えが届かなかった時に起こす相手を、channelごとに控える。控えられなくても申請は失敗させない。 */
export function rememberRequester(channelId: string, env: NodeJS.ProcessEnv = process.env): void {
  const botId = bellteamBotId(env);
  if (!botId) return;
  try { writeJsonFile(requesterFile(channelId), { bot_id: botId }); }
  catch (error) { process.stderr.write(`approval-box: BellTeamの申請元を控えられません: ${(error as Error).message}\n`); }
}

export function requesterOf(channelId: string): string | null {
  try {
    const botId = (JSON.parse(readFileSync(requesterFile(channelId), "utf8")) as { bot_id?: unknown }).bot_id;
    return typeof botId === "string" && BOT_ID.test(botId) ? botId : null;
  } catch { return null; }
}

export type Wake = { bot_id: string; state: "pending" | "sending"; tries: number; next_at?: string };
/** key = decision_id */
export type Wakes = Record<string, Wake>;

/** 申請元が分かるchannelの配送だけ、起こし知らせを一件積む。 */
export function queueWake(wakes: Wakes, decisionId: string, channelId: string): boolean {
  if (wakes[decisionId]) return false;
  const botId = requesterOf(channelId);
  if (!botId) return false;
  wakes[decisionId] = { bot_id: botId, state: "pending", tries: 0 };
  return true;
}

export function wakeMessage(decisionId: string, title: string): string {
  return `[Approval Box] あなたが request_decision で出した申請 ${decisionId}「${title}」に、利用者が答えました。答えを待っていた会話が止まっていたため、答えはその会話へ届いていません。Approval Boxの resume_decision を decision_id="${decisionId}" で呼ぶと、保存された答えが返ります。`;
}

export type WakeOutcome = { outcome: "accepted" | "refused" | "unknown" | "retry"; detail: string };

/** BellTeamが要求を受け取っていないと分かる接続の失敗。これだけ再送する。 */
const NOT_RECEIVED = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

type McpReply = { error?: { message?: string }; result?: { isError?: boolean; content?: { type?: string; text?: string }[] } };

export async function sendWake(botId: string, message: string, fetchImpl: typeof fetch = fetch): Promise<WakeOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(BELLTEAM_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "X-Bellteam-Seat": botId },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "sendmessage", arguments: { target: botId, message } } }),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string }; message?: string };
    const code = e.cause?.code ?? e.code;
    return { outcome: code && NOT_RECEIVED.has(code) ? "retry" : "unknown", detail: code ?? e.message ?? "fetch failed" };
  }
  if (!res.ok) return { outcome: "unknown", detail: `HTTP ${res.status}` };
  let json: McpReply;
  try {
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      const last = (await res.text()).split("\n").filter(line => line.startsWith("data:")).pop();
      json = JSON.parse(last!.slice(5)) as McpReply;
    } else json = await res.json() as McpReply;
  } catch { return { outcome: "unknown", detail: "BellTeamの返事を読めません" }; }
  const text = json.result?.content?.find(c => c.type === "text")?.text;
  if (json.error || json.result?.isError) return { outcome: "refused", detail: (json.error?.message ?? text ?? "refused").slice(0, 200) };
  try {
    const body = JSON.parse(text ?? "") as { delivery?: string; delivery_id?: string };
    if (body.delivery === "running" || body.delivery === "steered" || body.delivery === "delivered") return { outcome: "accepted", detail: `${body.delivery} ${body.delivery_id ?? ""}`.trim() };
  } catch { /* 読めなければ unknown */ }
  return { outcome: "unknown", detail: (text ?? "").slice(0, 200) };
}
