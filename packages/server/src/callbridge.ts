// 答えを call-bridge の通話で届ける（GrokBotなど、端末にコネクタを置けないAI向け）。
// call_open と call_send で Bridge へ一度渡すだけ。本人を起こす処理と配達役の復旧は Bridge が持つ。
// 受け付けた後は追跡も通話の切断もしない。届いたか確かめられない送信は、送り直さず unknown にする。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { type Db, get, all, run, tx } from "./db.ts";
import type { Decisions } from "./decisions.ts";
import type { EventHub } from "./events.ts";

export type BridgeProgress = { save: (sessionId: string, seq?: number) => void };
export type SendResult = { state: "delivered" | "unknown" | "failed"; detail?: string } | { state: "retry"; retry_after_seconds: 30; detail?: string };
/** 宛先のメンバー（電話帳のid）へ本文を送る。 */
export type CallSender = (memberId: string, decisionId: string, text: string, progress?: BridgeProgress) => Promise<SendResult>;

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

/** call_open + call_send を一度だけ呼ぶ。受付後の配達は Bridge の責任で、ここでは見ない。 */
export function callBridgeSender(config: CallBridgeConfig): CallSender {
  const connect = async () => {
    const client = new Client({ name: "approval-box-server", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      return client;
    } catch (error) { await client.close().catch(() => {}); throw error; }
  };
  return async (memberId, decisionId, text, progress) => {
    let client: Client | undefined;
    let sessionId: string | undefined;
    let sent = false;
    try {
      client = await connect();
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
      // この保存が失敗したら本文を送らない。
      progress?.save(sessionId);
      sent = true;
      const result = await client.callTool({ name: "call_send", arguments: { session_id: sessionId, from_party: "local", message: text, reply_required: false } }) as ToolResult;
      const body = payload(result);
      const status = (body.delivery as { status?: string } | undefined)?.status;
      if (result.isError || status === "error") return { state: "failed", detail: `call ${sessionId}: delivery error` };
      const seq = Number.isSafeInteger(body.seq) && Number(body.seq) > 0 ? Number(body.seq) : undefined;
      progress?.save(sessionId, seq);
      return { state: "delivered", detail: `call ${sessionId}${seq ? ` seq ${seq}` : ""}: handed to Bridge (${status ?? "accepted"})` };
    } catch {
      return { state: sent ? "unknown" : "failed", detail: "Bridge response unavailable; original message is not resent" };
    } finally { await client?.close().catch(() => {}); }
  };
}

type BridgeRow = { decision_id: string; session_id: string; seq: number | null; state: string; detail: string | null };

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
      // 旧版が追跡中に残した行。本文は再送せず、受付済み（seqあり）か結果不明（seqなし）で確定する。
      if (conn) for (const row of all<BridgeRow>(this.db, "select b.* from bridge_deliveries b join decisions d on d.id = b.decision_id where d.connection_id = ? and b.state = 'pending'", id)) {
        const state = row.seq === null ? "unknown" : "delivered";
        const detail = row.seq === null ? "legacy: response not confirmed" : "legacy: handed to Bridge";
        tx(this.db, () => {
          run(this.db, "update bridge_deliveries set state = ?, detail = ? where decision_id = ?", state, detail, row.decision_id);
          this.decisions.reportDelivery(conn, row.decision_id, state, detail);
        });
      }
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
          for (const item of this.decisions.serverDeliveries(id)) {
            if (!this.decisions.markSending(item.decision_id)) continue;
            await this.deliver(conn, item.decision_id, item.route.channel_id, `Approval Box ${item.decision_id}\n${item.text}`);
          }
        }
      } while (this.again);
    })().catch((error) => { console.error("callbridge:", error); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async deliver(conn: { id: string; user_id: string; label: string; os: string | null }, id: string, member: string, text: string) {
    const outcome = await this.send(member, id, text, {
      save: (sessionId, seq) => {
        run(this.db, `insert into bridge_deliveries (decision_id, session_id, seq, state) values (?, ?, ?, 'pending')
          on conflict(decision_id) do update set seq = coalesce(excluded.seq, bridge_deliveries.seq)`, id, sessionId, seq ?? null);
      },
    });
    if (outcome.state === "retry") {
      if (!this.decisions.deferServerDelivery(id, outcome.retry_after_seconds)) this.decisions.reportDelivery(conn, id, "failed", "directory_link_down: 回答後10分の再試行期限を超えました。get_decisionで取得してください");
      return;
    }
    tx(this.db, () => {
      run(this.db, "update bridge_deliveries set state = ?, detail = ? where decision_id = ?", outcome.state, outcome.detail ?? null, id);
      this.decisions.reportDelivery(conn, id, outcome.state, outcome.detail);
    });
    console.log(`callbridge ${id} ${outcome.state}`);
  }
}
