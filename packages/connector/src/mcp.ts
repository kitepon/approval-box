import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as steer from "aiterm-steer-delivery";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Api, ServerError } from "./api.ts";
import { type AttachmentMeta, saveAttachment } from "./attachments.ts";
import { requireConfig, writeJsonFile } from "./config.ts";
import { ensureDaemon } from "./daemon.ts";
import { runtimeEntry } from "./runtime.ts";
import { MCP_SERVER, PROFILE, stateRoot } from "./profile.ts";
import { osName, VERSION } from "./version.ts";

export type Harness = "claude" | "codex" | "cursor" | "grok" | "other";

const CLIENT_OF: Record<Harness, string> = { claude: "claude-code", codex: "codex", cursor: "cursor", grok: "grok", other: "other" };

export function harnessOf(clientName: string | undefined): Harness {
  const name = clientName ?? "";
  if (name === "codex-mcp-client") return "codex";
  if (name === "claude-code") return "claude";
  if (name === "Cursor" || steer.isCursorMcpClient(name)) return "cursor";
  if (name.startsWith("grok")) return "grok";
  return "other";
}

const INSTRUCTIONS = [
  "Approval Boxは、利用者（人間）の判断・承認・操作が要る時に使う。URLを開いての承認や、利用者の手で行う作業を頼む時も含む。その時は request_decision でも申請する。利用者が申請に気づきやすいので、強く推奨する。答えは利用者がスマホやWebで出し、この会話へ自動で届く。",
  "request_decision を呼ぶと、申請はすぐには受け付けられず、自分の申請の一覧と check_token が返る。一覧を見て、内容が変わった申請は amend_decision、要らなくなった申請は cancel_decision で先に済ませる。答えが出ていれば、その答えに従う。問題が無ければ、同じ申請に check_token を付けて出し直すと受け付けられる。",
  "申請したら答えを待って何度も呼ばない。答えは届くので、他の作業を続けるかターンを終えてよい。",
  "利用者に「Approval Boxのsetup_testを実行して」と言われたら setup_test を呼ぶ。届いた答えに書かれた確認コードで confirm_setup_test を呼ぶ。",
].join("\n");

const optionSchema = { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"], additionalProperties: false };
const TOOLS = [
  {
    name: "list_my_decisions",
    description: "この端末から出した自分の申請の一覧（未決・保留と、直近24時間に答えが出た・取り下げた申請）。申請の前に必ず呼ぶ。this_session=true は今の会話から出した申請。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_decision",
    description: "利用者に判断を申請する。1回目は受け付けず、自分の申請の一覧と check_token を返す。直す・取り下げる申請が無いか確かめ、要れば amend_decision・cancel_decision を済ませてから、check_token を付けて同じ申請を出し直す。答えはこの会話へ自動で届くので、待って何度も呼ばない。同じ件名の未決があると duplicate_suspected で断られる。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "件名（120字まで）。何を決めてほしいか一行で" },
        context: { type: "string", description: "判断に要る背景。プレーンテキスト" },
        options: { type: "array", items: optionSchema, minItems: 2, maxItems: 6, description: "選択肢（2〜6）" },
        recommendation: { type: "string", description: "AIの推奨する選択肢のid" },
        urgency: { type: "string", enum: ["low", "normal", "high"] },
        deadline: { type: "string", description: "期限（ISO 8601）" },
        session_label: { type: "string", description: "どの作業の話か（例: リポジトリ名 / 作業名）。省略すると作業フォルダ名" },
        distinct_reason: { type: "string", description: "同じ件名の未決があるのに別件として出す時だけ、その理由" },
        check_token: { type: "string", description: "1回目の request_decision で返った確認の札。一覧を確かめ、直す・取り下げる申請が無いと判断した時に付ける" },
      },
      required: ["title", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "amend_decision",
    description: "未決・保留の自分の申請を直す。note に何をなぜ直したかを書く。version は list_my_decisions の値。",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        version: { type: "integer" },
        note: { type: "string" },
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
    description: "申請の今の状態と答えを見る。答えはふつう自動で届くので、届いた答えを見失った時だけ使う。",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: ["decision_id"], additionalProperties: false },
  },
  {
    name: "get_attachment",
    description: "利用者が答えに付けた添付（画像・書類）を取る。この端末に保存して場所を返し、画像はそのまま見られる形でも返す。attachment_id は届いた答えか get_decision の answer.attachments にある。",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" }, attachment_id: { type: "string" } }, required: ["decision_id", "attachment_id"], additionalProperties: false },
  },
  {
    name: "setup_test",
    description: "Approval Boxの接続テスト（セットアップ確認）を始める。利用者に「Approval Boxのsetup_testを実行して」「Approval Boxのテストをして」「接続テストをして」と言われたら、他の方法を調べずにこのtoolを呼ぶ。Start the Approval Box connection test when the user says \"test Approval Box\". テストの申請が利用者に届き、答えがこの会話へ届く。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "confirm_setup_test",
    description: "接続テストの答えに書かれた確認コードを返して、テストを終える。",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" }, code: { type: "string" } }, required: ["decision_id", "code"], additionalProperties: false },
  },
];

const VIEWABLE_IMAGES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

// ---- 親の会話ごとのchannel ----

type ParentKey = string;
const parentsFile = () => join(stateRoot(), "parents.json");
const processChannels = new Map<ParentKey, string>();
let lastChannel: string | undefined;

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

const verifiedCodexThreads = new Set<string>();

/** 申請を出した会話（親）を特定し、その会話のchannelを返す。channelは会話ごとに使い回す。 */
async function channelFor(harness: Harness, clientName: string | undefined, meta: unknown) {
  if (harness === "codex") {
    const parent = steer.codexParentFromRequest(clientName, meta);
    if (!parent) throw new Error("Codexの会話を特定できませんでした。Codexを更新してから試してください。");
    const key = `codex:${parent.codex_home}:${parent.thread_id}`;
    const existing = reuse(key, true);
    if (existing) return existing;
    if (!verifiedCodexThreads.has(key)) {
      await steer.verifyCodexParent(PROFILE, parent);
      verifiedCodexThreads.add(key);
    }
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
    if (existing) return existing;
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

/** Cursor・Grokへ返す、答えの受け取り方の案内。Cursor CLIのmodelはstructuredContentを読まないので本文に書く。 */
function receiveGuide(harness: Harness, channelId: string): string {
  if (harness === "codex" || harness === "claude") return "";
  const line = steer.waitProcessCommandLine(steer.channelReceiveProcess(runtimeEntry("receive"), channelId));
  const lines = [""];
  if (harness === "cursor") lines.push(steer.channelMarker(steer.readChannel(PROFILE, channelId)).text);
  lines.push(
    "答えを受け取るため、次のコマンドを背景プロセスとして起動してください（この会話ですでに起動していて、まだ終わっていなければ不要）:",
    line,
    "終わったら出力の deliveries が答えです。続けて出力の next_wait_process を同じように背景で起動すると、次の答えも受け取れます。",
  );
  return lines.join("\n");
}

function text(value: string, structured?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

function describe(items: Record<string, unknown>[]): string {
  if (!items.length) return "この端末から出した申請はありません。";
  return items.map((d) => {
    const parts = [`- ${d.decision_id}「${d.title}」 status=${d.status} version=${d.version} 作業=${d.session_label}${d.this_session ? " (この会話)" : ""}`];
    if (d.answer_text) parts.push(`  答え: ${String(d.answer_text).split("\n").slice(1, 3).join(" / ")}`);
    if (d.cancel_reason) parts.push(`  取り下げ理由: ${d.cancel_reason}`);
    return parts.join("\n");
  }).join("\n");
}

export async function runMcp() {
  const server = new Server({ name: MCP_SERVER, version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const clientName = server.getClientVersion()?.name;
    const harness = harnessOf(clientName);
    try {
      const config = requireConfig();
      const api = new Api(config);
      ensureDaemon();
      const channelQuery = lastChannel ? `?channel_id=${encodeURIComponent(lastChannel)}` : "";

      if (name === "list_my_decisions") {
        const { items } = await api.call<{ items: Record<string, unknown>[] }>("GET", `/decisions${channelQuery}`);
        return text(`${describe(items)}\n\n${JSON.stringify({ items })}`, { items });
      }
      if (name === "request_decision") {
        const channelId = await channelFor(harness, clientName, request.params._meta);
        lastChannel = channelId;
        const body = {
          ...args,
          client: CLIENT_OF[harness],
          session_label: (args.session_label as string | undefined) || `${basename(process.cwd())} (${CLIENT_OF[harness]})`,
          route: { channel_id: channelId, harness },
        };
        try {
          const decision = await api.call("POST", "/decisions", body);
          const message = `申請しました: ${decision.decision_id}「${decision.title}」。答えはこの会話へ自動で届きます。待って呼び直さず、他の作業を続けるかターンを終えてください。`;
          return text(`${message}${receiveGuide(harness, channelId)}\n\n${JSON.stringify(decision)}`, { ...decision, steer_channel: { channel_id: channelId } });
        } catch (error) {
          if (error instanceof ServerError && error.code === "confirm_required") {
            const decisions = (error.body.decisions ?? []) as Record<string, unknown>[];
            const checkToken = String(error.body.check_token);
            return text(`${error.message}\n\n自分の申請:\n${describe(decisions)}\n\ncheck_token: ${checkToken}\n\n${JSON.stringify({ error: error.code, check_token: checkToken, decisions })}`,
              { error: error.code, check_token: checkToken, decisions }, true);
          }
          if (error instanceof ServerError && error.code === "duplicate_suspected") {
            const existing = (error.body.existing ?? []) as Record<string, unknown>[];
            return text(`${error.message}\n既存の申請:\n${describe(existing)}\n\n${JSON.stringify({ error: "duplicate_suspected", existing })}`, { error: "duplicate_suspected", existing }, true);
          }
          throw error;
        }
      }
      if (name === "amend_decision") {
        const { decision_id, ...rest } = args;
        const decision = await api.call("POST", `/decisions/${encodeURIComponent(String(decision_id))}/amend`, rest);
        return text(`直しました: ${decision.decision_id} version=${decision.version}\n\n${JSON.stringify(decision)}`, decision);
      }
      if (name === "cancel_decision") {
        const decision = await api.call("POST", `/decisions/${encodeURIComponent(String(args.decision_id))}/cancel`, { reason: args.reason });
        return text(`取り下げました: ${decision.decision_id}\n\n${JSON.stringify(decision)}`, decision);
      }
      if (name === "get_decision") {
        const id = encodeURIComponent(String(args.decision_id));
        let decision = await api.call("GET", `/decisions/${id}${channelQuery}`);
        if (decision.status === "answered" && decision.delivery === "waiting") decision = await api.call("POST", `/decisions/${id}/fetched`);
        const head = decision.answer_text ? String(decision.answer_text) : `${decision.decision_id}「${decision.title}」 status=${decision.status}（まだ答えはありません。届くまで待って呼び直さないでください）`;
        return text(`${head}\n\n${JSON.stringify(decision)}`, decision);
      }
      if (name === "get_attachment") {
        const decisionId = String(args.decision_id);
        const decision = await api.call("GET", `/decisions/${encodeURIComponent(decisionId)}`);
        const list = ((decision.answer as { attachments?: AttachmentMeta[] } | undefined)?.attachments) ?? [];
        const index = list.findIndex((a) => a.id === args.attachment_id);
        if (index < 0) return text(`Approval Box: ${decisionId} の答えに、その添付はありません。get_decision の answer.attachments を確かめてください。`, { error: "not_found" }, true);
        const meta = list[index]!;
        const path = await saveAttachment(api, decisionId, meta, index);
        const head = `${decisionId} の添付 ${index + 1}: ${meta.name}（${meta.content_type}、${meta.size}バイト）を保存しました: ${path}`;
        const structured = { decision_id: decisionId, attachment: meta, path };
        // モデルがそのまま見られる画像は、中身も返す（大きすぎる画像は場所だけ）。
        if (VIEWABLE_IMAGES.includes(meta.content_type) && meta.size <= MAX_INLINE_IMAGE) {
          return { content: [{ type: "text" as const, text: head }, { type: "image" as const, data: readFileSync(path).toString("base64"), mimeType: meta.content_type }], structuredContent: structured };
        }
        return text(head, structured);
      }
      if (name === "setup_test") {
        const channelId = await channelFor(harness, clientName, request.params._meta);
        lastChannel = channelId;
        const decision = await api.call("POST", "/setup-test", {
          client: CLIENT_OF[harness], os: osName(), session_label: `接続テスト ${basename(process.cwd())} (${CLIENT_OF[harness]})`,
          route: { channel_id: channelId, harness },
        });
        const message = `接続テストの申請を送りました（${decision.decision_id}）。利用者にアプリかWeb版で答えるよう伝えてください。答えがこの会話へ届いたら、そこに書かれた確認コードで confirm_setup_test を呼んでください。`;
        return text(`${message}${receiveGuide(harness, channelId)}\n\n${JSON.stringify(decision)}`, { ...decision, steer_channel: { channel_id: channelId } });
      }
      if (name === "confirm_setup_test") {
        const result = await api.call("POST", "/setup-test/confirm", { decision_id: args.decision_id, code: String(args.code) });
        return text(`接続テストが通りました（${result.client}）。Approval Boxはこの会話で使えます。`, result);
      }
      return text(`知らないツールです: ${name}`, undefined, true);
    } catch (error) {
      const code = error instanceof ServerError ? error.code : (error as { delivery_code?: string }).delivery_code ?? "connector_error";
      const message = (error as Error).message;
      return text(`Approval Box: ${message}\n\n${JSON.stringify({ error: code, message })}`, { error: code, message }, true);
    }
  });
  ensureDaemon();
  await server.connect(new StdioServerTransport());
}
