// 答えを call-bridge の通話で届ける（GrokBotなど、端末にコネクタを置けないAI向け）。
// 1件ごとに通話を保存し、配達待ちは同じ通話を追跡して終端の保存後に閉じる。
// 届いたか確かめられない送信は、送り直さず unknown にする。AIは get_decision で拾える。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { type Db, get, all, run, tx } from "./db.ts";
import type { Decisions } from "./decisions.ts";
import type { EventHub } from "./events.ts";

export type BridgeProgress = { sessionId?: string; seq?: number; save: (sessionId: string, seq?: number) => void };
export type SendResult = { state: "pending"; detail?: string } | { state: "delivered" | "unknown" | "failed"; detail?: string } | { state: "retry"; retry_after_seconds: 30; detail?: string };
/** 宛先のメンバー（電話帳のid）へ本文を送る。 */
export type CallSender = ((memberId: string, decisionId: string, text: string, progress?: BridgeProgress) => Promise<SendResult>) & { close?: (sessionId: string) => Promise<void> };

export type CallBridgeConfig = {
  url: string;
  /** 送るHTTPヘッダー（Authorization など）。 */
  headers: Record<string, string>;
  /** 発信元の所属（call-bridge のトークンに結び付いた system。Approval Box は local）。 */
  localSystem: string;
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

/** queued/inflightは取り消さず、保存済み通話の公開metadataで追跡する。 */
export function callBridgeSender(config: CallBridgeConfig): CallSender {
  const connect = async () => {
    const client = new Client({ name: "approval-box-server", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      return client;
    } catch (error) { await client.close().catch(() => {}); throw error; }
  };
  const send: CallSender = async (memberId, decisionId, text, progress) => {
    let client: Client | undefined;
    let sessionId = progress?.sessionId;
    let seq = progress?.seq;
    let sent = false;
    try {
      client = await connect();
      if (!sessionId) {
        const opened = await client.callTool({ name: "call_open", arguments: {
          local_system: config.localSystem, local_id: config.localId, local_label: config.localLabel,
          member_name: memberId, member_system: config.memberSystem, purpose: `Approval Box ${decisionId} の答え`,
        } }) as ToolResult;
        const open = payload(opened);
        sessionId = typeof open.session_id === "string" ? open.session_id : undefined;
        if (opened.isError || !sessionId) {
          if (!sessionId && open.ok === false && open.code === "directory_link_down" && open.retryable === true && open.retry_after_seconds === 30 && open.session_created === false) {
            return { state: "retry", retry_after_seconds: 30, detail: "directory_link_down" };
          }
          return { state: "failed", detail: "call_open rejected or session unavailable" };
        }
        // この保存が失敗したら本文を送らない。再起動も新しいcall_sendへ戻さない。
        progress?.save(sessionId);
        sent = true;
        const result = await client.callTool({ name: "call_send", arguments: { session_id: sessionId, from_party: "local", message: text, reply_required: false } }) as ToolResult;
        const body = payload(result);
        seq = Number.isSafeInteger(body.seq) && Number(body.seq) > 0 ? Number(body.seq) : undefined;
        progress?.save(sessionId, seq);
        const status = (body.delivery as { status?: string } | undefined)?.status;
        if (!result.isError && status === "delivered") return { state: "delivered", detail: `call ${sessionId}: accepted` };
        if (!result.isError && status === "error") return { state: "failed", detail: `call ${sessionId}: delivery error` };
        return { state: progress ? "pending" : "unknown", detail: `call ${sessionId}: awaiting delivery receipt` };
      }
      const result = await client.callTool({ name: "call_info", arguments: { session_id: sessionId } }) as ToolResult;
      const info = payload(result);
      if (result.isError || !Array.isArray(info.grokbot_delivery)) return { state: "pending", detail: "call_info unavailable" };
      const rows = info.grokbot_delivery as { seq?: number; state?: string }[];
      // 専用の新規通話へ一度だけ送る。応答消失時も唯一のseq=1だけを採用する。
      if (seq === undefined && rows.length === 1 && rows[0]?.seq === 1) {
        seq = 1;
        progress?.save(sessionId, seq);
      }
      const receipt = rows.find(r => seq !== undefined && r.seq === seq);
      if (receipt?.state === "submitted") return { state: "delivered", detail: `call ${sessionId} seq ${seq}: gateway submitted` };
      if (receipt?.state === "failed" || receipt?.state === "unknown") return { state: receipt.state, detail: `call ${sessionId} seq ${seq}: ${receipt.state}` };
      return { state: "pending", detail: `call ${sessionId}: ${receipt?.state === "inflight" ? "inflight" : "awaiting receipt"}` };
    } catch {
      return { state: progress && sessionId ? "pending" : sent ? "unknown" : "failed", detail: "Bridge response unavailable; original message is not resent" };
    } finally { await client?.close().catch(() => {}); }
  };
  send.close = async sessionId => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: "call_hangup", arguments: { session_id: sessionId, by_party: "local", reason: "Approval Box delivery terminal state saved" } }) as ToolResult;
      if (result.isError || payload(result).error || payload(result).ok === false) throw new Error("call_hangup rejected");
    } finally { await client.close().catch(() => {}); }
  };
  return send;
}

type BridgeRow = { decision_id: string; session_id: string; seq: number | null; state: string; detail: string | null; closed: number };

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
      if (conn) for (const decisionId of this.decisions.interruptedServerDeliveries(id)) {
        if (!get(this.db, "select 1 from bridge_deliveries where decision_id = ?", decisionId)) this.decisions.reportDelivery(conn, decisionId, "unknown", "送信の途中でサーバーが止まりました");
      }
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
          const tracked = all<BridgeRow>(this.db, `select b.* from bridge_deliveries b join decisions d on d.id = b.decision_id where d.connection_id = ? and b.closed = 0`, id);
          for (const row of tracked) {
            if (row.state === "pending") await this.deliver(conn, row.decision_id, "", "", row);
            else await this.close(row);
          }
          for (const item of this.decisions.serverDeliveries(id)) {
            if (!this.decisions.markSending(item.decision_id)) continue;
            await this.deliver(conn, item.decision_id, item.route.channel_id, `Approval Box ${item.decision_id}\n${item.text}`);
          }
        }
      } while (this.again);
    })().catch((error) => { console.error("callbridge:", error); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async deliver(conn: { id: string; user_id: string; label: string; os: string | null }, id: string, member: string, text: string, previous?: BridgeRow) {
    const outcome = await this.send(member, id, text, {
      sessionId: previous?.session_id, seq: previous?.seq ?? undefined,
      save: (sessionId, seq) => {
        run(this.db, `insert into bridge_deliveries (decision_id, session_id, seq, state) values (?, ?, ?, 'pending')
          on conflict(decision_id) do update set seq = coalesce(excluded.seq, bridge_deliveries.seq)`, id, sessionId, seq ?? null);
      },
    });
    if (outcome.state === "pending") {
      run(this.db, "update bridge_deliveries set detail = ? where decision_id = ?", outcome.detail ?? null, id);
      return;
    }
    if (outcome.state === "retry") {
      if (!this.decisions.deferServerDelivery(id, outcome.retry_after_seconds)) this.decisions.reportDelivery(conn, id, "failed", "directory_link_down: 回答後10分の再試行期限を超えました。get_decisionで取得してください");
      return;
    }
    tx(this.db, () => {
      run(this.db, "update bridge_deliveries set state = ?, detail = ? where decision_id = ?", outcome.state, outcome.detail ?? null, id);
      this.decisions.reportDelivery(conn, id, outcome.state, outcome.detail);
    });
    const row = get<BridgeRow>(this.db, "select * from bridge_deliveries where decision_id = ?", id);
    if (row) await this.close(row);
    console.log(`callbridge ${id} ${outcome.state}`);
  }

  private async close(row: BridgeRow) {
    if (!this.send.close) return;
    try {
      await this.send.close(row.session_id);
      run(this.db, "update bridge_deliveries set closed = 1 where decision_id = ?", row.decision_id);
    } catch { /* 確定結果は保持し、次回はcloseだけ再試行する。 */ }
  }

}
