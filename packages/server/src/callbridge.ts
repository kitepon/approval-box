// 答えを call-bridge の通話で届ける（GrokBotなど、端末にコネクタを置けないAI向け）。
// 1件ごとに通話を開き、本文の頭に申請番号を書いて送り、閉じる（マリアンとの取り決め 2026-10-02）。
// 届いたか確かめられない送信は、送り直さず unknown にする。AIは get_decision で拾える。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { type Db, get } from "./db.ts";
import type { Decisions } from "./decisions.ts";
import type { EventHub } from "./events.ts";

export type SendResult = { state: "delivered" | "unknown" | "failed"; detail?: string };
/** 宛先のメンバー（電話帳のid）へ本文を送る。 */
export type CallSender = (memberId: string, decisionId: string, text: string) => Promise<SendResult>;

export type CallBridgeConfig = {
  url: string;
  /** 送るHTTPヘッダー（Authorization など）。 */
  headers: Record<string, string>;
  localId: string;
  localLabel: string;
  memberSystem: string;
};

/** `Name: value` の行のファイル（call-bridge の issue_token.py --format header の形）を読む。値は表に出さない。 */
export function readHeaderFile(file: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function payload(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { text }; }
}

/** call-bridge のMCPへ、call_open → call_send → call_hangup で送る。 */
export function callBridgeSender(config: CallBridgeConfig): CallSender {
  return async (memberId, decisionId, text) => {
    const client = new Client({ name: "approval-box-server", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    let sent = false;
    try {
      await client.connect(transport);
      const opened = await client.callTool({
        name: "call_open",
        arguments: { local_id: config.localId, local_label: config.localLabel, member_name: memberId, member_system: config.memberSystem, purpose: `Approval Box ${decisionId} の答え` },
      }) as ToolResult;
      const open = payload(opened);
      const sessionId = typeof open.session_id === "string" ? open.session_id : undefined;
      if (opened.isError || !sessionId) return { state: "failed", detail: `call_open: ${JSON.stringify(open).slice(0, 300)}` };
      sent = true; // ここから先の失敗は、届いたか分からない
      const result = await client.callTool({
        name: "call_send",
        arguments: { session_id: sessionId, from_party: "local", message: text, reply_required: false },
      }) as ToolResult;
      const body = payload(result);
      const status = (body.delivery as { status?: string } | undefined)?.status;
      try { await client.callTool({ name: "call_hangup", arguments: { session_id: sessionId, by_party: "local", reason: "Approval Boxの答えを届けた" } }); } catch { /* 閉じられなくても配送の結果は変わらない */ }
      if (!result.isError && status === "delivered") return { state: "delivered", detail: `call ${sessionId}` };
      if (status === "error" && !result.isError) return { state: "failed", detail: `call_send: ${JSON.stringify(body.delivery).slice(0, 300)}` };
      return { state: "unknown", detail: `call_send: ${JSON.stringify(body.delivery ?? body).slice(0, 300)}` };
    } catch (error) {
      return { state: sent ? "unknown" : "failed", detail: (error as Error).message.slice(0, 300) };
    } finally {
      void client.close().catch(() => {});
    }
  };
}

/** 指定した接続の答えを、サーバーが通話で届ける。 */
export class CallBridgeDeliverer {
  private readonly db: Db;
  private readonly decisions: Decisions;
  private readonly send: CallSender;
  private readonly connectionIds: string[];
  private running: Promise<void> | null = null;
  private again = false;

  constructor(db: Db, decisions: Decisions, events: EventHub, send: CallSender, connectionIds: Iterable<string>) {
    this.db = db;
    this.decisions = decisions;
    this.send = send;
    this.connectionIds = [...connectionIds];
    for (const id of this.connectionIds) {
      // 前回の送信の途中で止まったものは、届いたか分からない。送り直さない。
      const conn = this.connection(id);
      if (conn) for (const decisionId of this.decisions.interruptedServerDeliveries(id)) this.decisions.reportDelivery(conn, decisionId, "unknown", "送信の途中でサーバーが止まりました");
      events.subscribeConnection(id, () => { void this.sync(); });
    }
  }

  private connection(id: string) {
    return get<{ id: string; user_id: string; label: string; os: string | null }>(this.db, "select id, user_id, label, os from connections where id = ? and revoked_at is null", id);
  }

  /** 配送待ちを全部送る。重なって呼ばれたら、終わってからもう一周する。 */
  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        for (const id of this.connectionIds) {
          const conn = this.connection(id);
          if (!conn) continue;
          for (const item of this.decisions.serverDeliveries(id)) {
            this.decisions.markSending(item.decision_id);
            const outcome = await this.send(item.route.channel_id, item.decision_id, `Approval Box ${item.decision_id}\n${item.text}`);
            this.decisions.reportDelivery(conn, item.decision_id, outcome.state, outcome.detail);
            console.log(`callbridge ${item.decision_id} → ${item.route.channel_id.slice(0, 8)} ${outcome.state}${outcome.detail ? ` (${outcome.detail.slice(0, 120)})` : ""}`);
          }
        }
      } while (this.again);
    })().catch((error) => { console.error("callbridge:", error); }).finally(() => { this.running = null; });
    return this.running;
  }
}
