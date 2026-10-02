// リモートMCP（Streamable HTTP、状態を持たない）。端末にコネクタを入れられないAI（GrokBotなど）が、URLとBearer 1本で使う口。
// Bearer は接続トークン（アプリ・Web版の「接続トークン」、/v1/tokens で発行）。申請はその接続のものになる。
// 答えは、call-bridge の届け先に指定した接続ならサーバーが通話で届ける（callbridge.ts）。それ以外は get_decision で取る。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { z, ZodError } from "zod";
import type { Accounts } from "./accounts.ts";
import { type Connection, Decisions, SERVER_HARNESS, amendSchema, createSchema } from "./decisions.ts";
import { ApiError } from "./errors.ts";

export type RemoteMcpOptions = {
  /** 答えを call-bridge の通話で届ける接続のid。この接続の申請には、申請したメンバーのIDが要る。 */
  callBridgeConnections?: ReadonlySet<string>;
};

const INSTRUCTIONS = [
  "Approval Boxは、利用者（人間）の判断・承認・操作が要る時に使う。URLを開いての承認や、利用者の手で行う作業を頼む時も含む。その時は request_decision でも申請する。利用者が申請に気づきやすいので、強く推奨する。答えは利用者がスマホやWebで出す。",
  "request_decision を呼ぶと、申請はすぐには受け付けられず、自分の申請の一覧と check_token が返る。一覧を見て、内容が変わった申請は amend_decision、要らなくなった申請は cancel_decision で先に済ませる。答えが出ていれば、その答えに従う。問題が無ければ、同じ申請に check_token を付けて出し直すと受け付けられる。",
  "答えが自分の会話へ届く設定なら、申請したあと答えを待って何度も呼ばない。届かない設定なら、利用者に「答えたら知らせてほしい」と伝え、知らされた時に get_decision で答えを取る。",
].join("\n");

const optionSchema = { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"], additionalProperties: false };

function tools(callBridge: boolean) {
  const requester = callBridge
    ? {
      requester_id: { type: "string", description: "申請するあなた自身のID（電話帳のid）。答えはこのIDのあなたへ通話で届く" },
      requester_name: { type: "string", description: "申請するあなた自身の名前（電話帳の名前）" },
    }
    : {};
  return [
    {
      name: "list_my_decisions",
      description: "この接続から出した申請の一覧（未決・保留と、直近24時間に答えが出た・取り下げた申請）。申請の前に必ず呼ぶ。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "request_decision",
      description: "利用者に判断・承認・操作を申請する。1回目は受け付けず、自分の申請の一覧と check_token を返す。直す・取り下げる申請が無いか確かめ、要れば amend_decision・cancel_decision を済ませてから、check_token を付けて同じ申請を出し直す。"
        + (callBridge ? "答えは requester_id のあなたへ、Approval Boxからの通話で自動で届く。待って何度も呼ばない。" : ""),
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "件名（120字まで）。何を決めてほしいか一行で" },
          context: { type: "string", description: "判断に要る背景。プレーンテキスト" },
          options: { type: "array", items: optionSchema, minItems: 2, maxItems: 6, description: "選択肢（2〜6）" },
          recommendation: { type: "string", description: "AIの推奨する選択肢のid" },
          urgency: { type: "string", enum: ["low", "normal", "high"] },
          deadline: { type: "string", description: "期限（ISO 8601）" },
          session_label: { type: "string", description: "どの作業の話か" },
          ...requester,
          distinct_reason: { type: "string", description: "同じ件名の未決があるのに別件として出す時だけ、その理由" },
          check_token: { type: "string", description: "1回目の request_decision で返った確認の札" },
        },
        required: ["title", "options", "session_label", ...(callBridge ? ["requester_id", "requester_name"] : [])],
        additionalProperties: false,
      },
    },
    {
      name: "amend_decision",
      description: "未決・保留の自分の申請を直す。note に何をなぜ直したかを書く。version は list_my_decisions の値。",
      inputSchema: {
        type: "object",
        properties: {
          decision_id: { type: "string" }, version: { type: "integer" }, note: { type: "string" },
          changes: {
            type: "object",
            properties: {
              title: { type: "string" }, context: { type: "string" }, options: { type: "array", items: optionSchema, minItems: 2, maxItems: 6 },
              recommendation: { type: ["string", "null"] }, urgency: { type: "string", enum: ["low", "normal", "high"] }, deadline: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
        required: ["decision_id", "version", "note", "changes"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_decision",
      description: "未決・保留の自分の申請を取り下げる。reason に理由を書く。",
      inputSchema: { type: "object", properties: { decision_id: { type: "string" }, reason: { type: "string" } }, required: ["decision_id", "reason"], additionalProperties: false },
    },
    {
      name: "get_decision",
      description: "申請の今の状態と答えを見る。答えが届かなかった時や、利用者に「答えた」と言われた時に使う。",
      inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: ["decision_id"], additionalProperties: false },
    },
  ];
}

type AiDecision = ReturnType<Decisions["toAi"]>;

function describe(items: AiDecision[]): string {
  if (!items.length) return "この接続から出した申請はありません。";
  return items.map((d) => {
    const parts = [`- ${d.decision_id}「${d.title}」 status=${d.status} version=${d.version} 作業=${d.session_label}`];
    if ("answer_text" in d && d.answer_text) parts.push(`  答え: ${String(d.answer_text).split("\n").slice(1, 3).join(" / ")}`);
    if (d.cancel_reason) parts.push(`  取り下げ理由: ${d.cancel_reason}`);
    return parts.join("\n");
  }).join("\n");
}

function result(text: string, structured?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

const requesterSchema = z.object({
  requester_id: z.string().trim().min(1).max(100),
  requester_name: z.string().trim().min(1).max(60),
});

function buildServer(conn: Connection, accounts: Accounts, decisions: Decisions, callBridge: boolean) {
  const server = new Server({ name: "approval-box", version: "remote" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools(callBridge) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "list_my_decisions") {
        const items = decisions.listMine(conn);
        return result(`${describe(items)}\n\n${JSON.stringify({ items })}`, { items });
      }
      if (name === "request_decision") {
        const { requester_id: _id, requester_name: _name, ...rest } = args;
        let route: { channel_id: string; harness: string } | undefined;
        let label = String(rest.session_label ?? "");
        if (callBridge) {
          const who = requesterSchema.parse(args);
          route = { channel_id: who.requester_id, harness: SERVER_HARNESS };
          // 共有の接続なので、名前は申請したAIの自己申告。アプリでそう分かるように書く（マリアンの指摘）。
          label = `${who.requester_name}（申告） / ${label}`.slice(0, 200);
        }
        const input = createSchema.parse({ ...rest, session_label: label, client: "other", ...(route ? { route } : {}) });
        accounts.assertCanUse(conn.user_id);
        try {
          const row = decisions.create(conn, input, { via: "remote" });
          const decision = decisions.toAi(row);
          const tail = callBridge
            ? "答えは、利用者が答えた時にApproval Boxからの通話であなたへ届きます。待って呼び直さず、他の作業を続けてください。"
            : `答えが出たら get_decision で取ってください。利用者に「${row.resume_phrase}」と言われた時が目安です。`;
          return result(`申請しました: ${decision.decision_id}「${decision.title}」。${tail}\n\n${JSON.stringify(decision)}`, decision);
        } catch (error) {
          if (error instanceof ApiError && error.code === "confirm_required") {
            return result(`${error.message}\n\ncheck_token: ${String(error.extra.check_token)}`, { error: error.code, ...error.extra }, true);
          }
          if (error instanceof ApiError && error.code === "duplicate_suspected") {
            const existing = (error.extra.existing ?? []) as AiDecision[];
            return result(`${error.message}\n既存の申請:\n${describe(existing)}`, { error: error.code, existing }, true);
          }
          throw error;
        }
      }
      if (name === "amend_decision") {
        const body = amendSchema.parse({ version: args.version, note: args.note, changes: args.changes });
        const decision = decisions.amend(conn, String(args.decision_id), body);
        return result(`直しました: ${decision.decision_id} version=${decision.version}\n\n${JSON.stringify(decision)}`, decision);
      }
      if (name === "cancel_decision") {
        const reason = z.string().trim().min(1).max(500).parse(args.reason);
        const decision = decisions.cancel(conn, String(args.decision_id), reason);
        return result(`取り下げました: ${decision.decision_id}\n\n${JSON.stringify(decision)}`, decision);
      }
      if (name === "get_decision") {
        const row = decisions.forConnection(conn, String(args.decision_id));
        // 答えを取ったら、自動の配送はもう要らない（二重に届けない）。
        if (row.status === "answered" && row.delivery === "waiting") decisions.markFetched(row);
        const decision = decisions.aiView(conn, row.id);
        const head = decision.answer_text ? String(decision.answer_text) : `${decision.decision_id}「${decision.title}」 status=${decision.status}（まだ答えはありません）`;
        return result(`${head}\n\n${JSON.stringify(decision)}`, decision);
      }
      return result(`知らないツールです: ${name}`, undefined, true);
    } catch (error) {
      if (error instanceof ApiError) return result(`Approval Box: ${error.message}\n\n${JSON.stringify(error.body())}`, error.body() as Record<string, unknown>, true);
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return result(`Approval Box: 入力が正しくありません。${where}${issue?.message ?? ""}`, { error: "validation_failed" }, true);
      }
      throw error;
    }
  });
  return server;
}

/** POST /mcp（GET・DELETE は状態を持たないので 405）。 */
export function remoteMcpHandler(accounts: Accounts, decisions: Decisions, options: RemoteMcpOptions = {}) {
  return async (c: Context) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    let conn: Connection;
    try {
      conn = accounts.connectionByToken(token);
    } catch (error) {
      if (error instanceof ApiError) return c.json(error.body(), 401, { "www-authenticate": 'Bearer realm="approval-box"' });
      throw error;
    }
    const server = buildServer(conn, accounts, decisions, options.callBridgeConnections?.has(conn.id) ?? false);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  };
}
