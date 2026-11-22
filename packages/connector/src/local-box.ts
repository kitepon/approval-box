// peer-channel の道（c8c）で、サーバーの代わりに手元で申請を持つ所。形は docs/architecture/peer-channel-adoption.md の 7。
// MCPの道具とデーモンが使う /connector/v1 の申請の経路を、サーバーの server/decisions.ts と同じ意味で手元で答える。
// 件名・本文・選択肢・答え・配送の文は、この 0600 のファイル（state/pc/decisions.json）とpeer-channelの outbox にだけある。
// shortcut: 検証と文はサーバーの decisions.ts から写した。サーバーの申請の経路を閉じる時（adoption 4）に、こちらを唯一の正にする。
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ServerError } from "./api.ts";
import { writeJsonFile } from "./config.ts";

export const DECISION_SCHEMA = "approval-box/decision@1";
export const ANSWER_SCHEMA = "approval-box/answer@1";

const URGENCIES = ["low", "normal", "high"] as const;
const AMEND_FIELDS = ["title", "context", "options", "recommendation", "urgency", "deadline"] as const;
const OPEN = ["pending", "held"];
const CREATE_LIMIT_PER_HOUR = 60;
const AMEND_LIMIT = 20;
const CHECK_TTL_MS = 30 * 60_000;
const KEEP_CLOSED_MS = 30 * 86400_000; // サーバーの既定の保存期間（30日）と同じ
const SPEAK_BY_TITLE = "利用者へこの申請の話をする時は、件名で伝えてください。アプリには件名・申請者・作業名が出て、申請のIDは出ません。IDは道具を呼ぶ時に使います。";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Option = { id: string; label: string };
type Route = { channel_id: string; harness: string };
export type FileMeta = { id: string; name: string; content_type: string; size: number; sha256: string };
type Answer = { option_id?: string; text?: string; attachments?: FileMeta[]; answered_at: string };
/** A blob from the device: its meta (8.2 blobs[]) and bytes, already SHA-256 checked by peer-channel. */
export type InBlob = { meta: { name: string; content_type: string; size: number }; bytes: Uint8Array };
export type OutBlob = { bytes: Uint8Array; content_type: string; name: string };
export type Rec = {
  id: string; rid?: string; route?: Route;
  title: string; norm_title: string; context: string; options: Option[]; recommendation?: string; urgency: string; deadline?: string;
  client: string; session_label: string; requester?: string; requester_bot_id?: string; test: boolean;
  status: "pending" | "held" | "answered" | "cancelled"; answer?: Answer;
  delivery?: "waiting" | "delivered" | "unknown" | "fetched"; delivery_id?: string; delivery_text?: string; delivery_detail?: string;
  resume_phrase: string; cancel_reason?: string; distinct_reason?: string; amend_count: number; setup_code?: string;
  request_attachments?: FileMeta[];
  created_at: string; updated_at: string; version: number;
};
type Store = { decisions: Rec[]; checks: { hash: string; expires_at: string; used_at?: string }[] };

/** 申請を端末へ運ぶ道（peer-channel の Connector）。テストでは無しでよい。 */
export type Transport = {
  request(content: unknown, blobs: OutBlob[]): string;
  amend(rid: string, content: unknown, blobs?: OutBlob[]): void;
  cancel(rid: string, reason: string): void;
};

const optionSchema = z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200) });
const optionsSchema = z.array(optionSchema).min(2).max(6).refine((options) => new Set(options.map((o) => o.id)).size === options.length, "選択肢のidが重なっています");
const routeSchema = z.object({ channel_id: z.string().min(1).max(100), harness: z.string().min(1).max(20) });
const requestIds = z.array(z.string().min(1).max(100)).max(10).optional();
const createSchema = z.object({
  title: z.string().trim().min(1).max(120), context: z.string().max(20000).default(""), options: optionsSchema,
  recommendation: z.string().optional(), urgency: z.enum(URGENCIES).default("normal"), deadline: z.iso.datetime({ offset: true }).optional(),
  session_label: z.string().trim().min(1).max(200), requester: z.string().trim().min(1).max(60).optional(),
  requester_bot_id: z.string().regex(/^bot-[a-z0-9]+$/).max(64).optional(), client: z.string().trim().min(1).max(40),
  route: routeSchema.optional(), distinct_reason: z.string().trim().min(1).max(500).optional(), check_token: z.string().max(200).optional(),
  request_attachment_ids: requestIds,
});
const amendSchema = z.object({
  route: routeSchema.optional(), version: z.number().int().positive(), note: z.string().trim().min(1).max(500),
  changes: z.object({
    request_attachment_ids: requestIds, title: z.string().trim().min(1).max(120).optional(), context: z.string().max(20000).optional(),
    options: optionsSchema.optional(), recommendation: z.string().nullable().optional(), urgency: z.enum(URGENCIES).optional(),
    deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  }).refine((changes) => Object.keys(changes).length > 0, "直す項目がありません"),
});
const answerSchema = z.object({ option_id: z.string().max(40).optional(), text: z.string().trim().max(5000).optional() }).strict();
const MAX_REQUEST_BYTES = 50 * 1024 * 1024; // サーバーと同じ: 申請画像は合計50MBまで

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeTitle = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const pick = (length: number) => Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const fail = (status: number, code: string, message: string, body: Record<string, unknown> = {}): never => { throw new ServerError(status, code, message, body); };
const STATUS: Record<string, number> = { too_large: 413, validation_failed: 400, not_found: 404, conflict: 409, confirm_required: 409, duplicate_suspected: 409, rate_limited: 429 };
const error = (code: string, message: string, body: Record<string, unknown> = {}): never => fail(STATUS[code] ?? 400, code, message, body);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  return error("validation_failed", `入力が正しくありません。${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? ""}`);
}

export class LocalBox {
  readonly events = new EventEmitter();
  transport?: Transport;
  /** 接続テストが手元で通った時（サーバーへ「確認済み」の印だけを送る。pc-daemon が付ける）。 */
  onSetupPassed?: (client: string) => void;
  private store: Store;

  private readonly file: string;
  private readonly root: string;

  constructor(file: string) {
    this.file = file;
    this.root = dirname(file);
    this.store = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Store) : { decisions: [], checks: [] };
  }

  private save() { writeJsonFile(this.file, this.store); }

  private rec(id: string): Rec {
    return this.store.decisions.find((d) => d.id === id) ?? error("not_found", "その申請は見つかりません。この接続から出した申請だけを扱えます。");
  }

  private bump(rec: Rec) { rec.updated_at = now(); rec.version++; }

  // ---- 返す形（server/decisions.ts の toAi・summary と同じ）----

  toAi(rec: Rec, routeChannel?: string) {
    return {
      decision_id: rec.id, title: rec.title, status: rec.status, version: rec.version, urgency: rec.urgency, options: rec.options,
      ...(rec.recommendation ? { recommendation: rec.recommendation } : {}), ...(rec.deadline ? { deadline: rec.deadline } : {}),
      context: rec.context, request_attachments: rec.request_attachments ?? [], session_label: rec.session_label, ...(rec.requester ? { requester: rec.requester } : {}),
      this_session: !!routeChannel && rec.route?.channel_id === routeChannel,
      ...(rec.answer ? { answer: rec.answer, answer_text: rec.delivery_text } : {}), ...(rec.delivery ? { delivery: rec.delivery } : {}),
      ...(rec.cancel_reason ? { cancel_reason: rec.cancel_reason } : {}), ...(rec.test ? { test: true } : {}),
      created_at: rec.created_at, updated_at: rec.updated_at,
    };
  }

  private summary(rec: Rec, routeChannel?: string) {
    return {
      decision_id: rec.id, title: rec.title, status: rec.status, version: rec.version, session_label: rec.session_label,
      ...(rec.requester ? { requester: rec.requester } : {}), this_session: !!routeChannel && rec.route?.channel_id === routeChannel,
      has_answer: !!rec.answer, ...(rec.delivery ? { delivery: rec.delivery } : {}), ...(rec.test ? { test: true } : {}),
      created_at: rec.created_at, updated_at: rec.updated_at,
    };
  }

  /** 端末へ運ぶ中身（approval-box/decision@1）。 */
  content(rec: Rec) {
    const label = !rec.requester || rec.session_label.startsWith(rec.requester) ? rec.session_label : `${rec.requester} / ${rec.session_label}`;
    return {
      decision_id: rec.id, title: rec.title, context: rec.context, options: rec.options, ...(rec.recommendation ? { recommendation: rec.recommendation } : {}),
      urgency: rec.urgency, ...(rec.deadline ? { deadline: rec.deadline } : {}),
      source: { client: rec.client, session_label: label, work_label: rec.session_label, ...(rec.requester ? { requester: rec.requester } : {}), ...(rec.requester_bot_id ? { requester_bot_id: rec.requester_bot_id } : {}), ...(rec.test ? { test: true } : {}) },
      created_at: rec.created_at, version: rec.version,
    };
  }

  private assertOpen(rec: Rec) {
    if (OPEN.includes(rec.status)) return;
    error("conflict", rec.status === "answered" ? "利用者がすでに答えています。answer_text の答えに従ってください。" : "この申請はすでに取り下げられています。", { decision: this.toAi(rec) });
  }

  // ---- AI（MCPの道具）----

  list(routeChannel?: string) {
    const since = Date.now() - 86400_000;
    return this.store.decisions.filter((d) => OPEN.includes(d.status) || Date.parse(d.updated_at) >= since)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((d) => this.summary(d, routeChannel));
  }

  create(body: unknown, test = false) {
    const input = parse(createSchema, body);
    this.prune();
    if (!test) this.requireCheck(input);
    const hourAgo = Date.now() - 3600_000;
    if (this.store.decisions.filter((d) => Date.parse(d.created_at) >= hourAgo).length >= CREATE_LIMIT_PER_HOUR) error("rate_limited", "1時間に出せる申請の数を超えました。少し待ってください。");
    if (input.recommendation && !input.options.some((o) => o.id === input.recommendation)) error("validation_failed", "recommendation が選択肢のidにありません。");
    const norm = normalizeTitle(input.title);
    if (!test && !input.distinct_reason) {
      const existing = this.store.decisions.filter((d) => OPEN.includes(d.status) && d.norm_title === norm);
      if (existing.length) error("duplicate_suspected", "同じ件名の申請がまだ答えを待っています。新しく出さず、amend_decision で直すか、cancel_decision で取り下げてください。別件なら distinct_reason を付けて出し直せます。",
        { existing: existing.map((d) => this.summary(d, input.route?.channel_id)) });
    }
    if (!test) this.useCheck(input.check_token!);
    let id: string;
    do id = `K-${pick(6)}`; while (this.store.decisions.some((d) => d.id === id));
    const at = now();
    const rec: Rec = {
      id, ...(input.route ? { route: input.route } : {}), title: input.title, norm_title: norm, context: input.context, options: input.options,
      ...(input.recommendation ? { recommendation: input.recommendation } : {}), urgency: input.urgency, ...(input.deadline ? { deadline: input.deadline } : {}),
      client: input.client, session_label: input.session_label, ...(input.requester ? { requester: input.requester } : {}),
      ...(input.requester_bot_id ? { requester_bot_id: input.requester_bot_id } : {}), test, status: "pending",
      resume_phrase: `Approval Box ${id} の答えを確認して続けて`, ...(input.distinct_reason ? { distinct_reason: input.distinct_reason } : {}),
      amend_count: 0, created_at: at, updated_at: at, version: 1,
    };
    const images = this.takeUploads(input.request_attachment_ids ?? []);
    if (images.length) rec.request_attachments = this.keepFiles(id, images);
    if (this.transport) rec.rid = this.transport.request(this.content(rec), images);
    this.store.decisions.push(rec);
    this.save();
    return rec;
  }

  /** 申請の前の確かめ（クオの裁定 2026-10-01）。サーバーの requireCheck と同じ文と形。 */
  private requireCheck(input: z.infer<typeof createSchema>) {
    if (input.check_token && this.checkUsable(input.check_token)) return;
    const token = `chk_${randomBytes(32).toString("base64url")}`;
    this.store.checks = this.store.checks.filter((c) => c.expires_at >= now());
    this.store.checks.push({ hash: hash(token), expires_at: new Date(Date.now() + CHECK_TTL_MS).toISOString() });
    this.save();
    const head = input.check_token ? "確認の札が古いか、もう使われています。もう一度確かめてください。\n" : "";
    const nameless = input.requester ? "" : "申請者の名前（requester_name）が空です。このままでは利用者に誰からの申請か分かりません。Botや担当としての名前を持つなら、requester_name に入れて出し直してください。\n";
    const decisions = this.list(input.route?.channel_id);
    const list = decisions.length
      ? decisions.map((d) => `- ${d.decision_id}「${d.title}」 status=${d.status} version=${d.version}${d.has_answer ? " 答えあり" : ""}`).join("\n")
      : "（この端末から出した申請はありません）";
    error("confirm_required",
      `${head}${nameless}申請はまだ受け付けていません。下は同じ接続から出した申請の要約一覧です。直す申請があれば amend_decision、要らなくなった申請があれば cancel_decision を先に済ませてください。答えが出ている申請は get_decision で確認してください。問題が無ければ、同じ申請に check_token: "${token}" を付けて出し直してください。\n${list}`,
      { check_token: token, decisions });
  }

  private checkUsable(token: string) {
    const c = this.store.checks.find((x) => x.hash === hash(token));
    return !!c && !c.used_at && c.expires_at > now();
  }

  private useCheck(token: string) {
    if (!this.checkUsable(token)) error("conflict", "確認の札がもう使われています。申請を出し直してください。");
    this.store.checks.find((x) => x.hash === hash(token))!.used_at = now();
  }

  amend(id: string, body: unknown) {
    const input = parse(amendSchema, body);
    const rec = this.rec(id);
    this.assertOpen(rec);
    if (rec.version !== input.version) error("conflict", "申請の内容が変わっています。最新の version で直してください。", { decision: this.toAi(rec) });
    if (rec.amend_count >= AMEND_LIMIT) error("rate_limited", "この申請はもう直せません（20回まで）。取り下げて出し直してください。");
    const c = input.changes;
    const options = c.options ?? rec.options;
    const recommendation = c.recommendation === undefined ? rec.recommendation : c.recommendation ?? undefined;
    if (recommendation && !options.some((o) => o.id === recommendation)) error("validation_failed", "recommendation が選択肢のidにありません。");
    const images = c.request_attachment_ids === undefined ? undefined : this.takeUploads(c.request_attachment_ids);
    if (images) { this.dropFiles(rec.id, rec.request_attachments ?? []); rec.request_attachments = this.keepFiles(rec.id, images); }
    const changed = AMEND_FIELDS.some((f) => c[f] !== undefined) || !!images;
    Object.assign(rec, { title: c.title ?? rec.title, norm_title: normalizeTitle(c.title ?? rec.title), context: c.context ?? rec.context, options, urgency: c.urgency ?? rec.urgency });
    if (recommendation) rec.recommendation = recommendation; else delete rec.recommendation;
    if (c.deadline !== undefined) { if (c.deadline) rec.deadline = c.deadline; else delete rec.deadline; }
    if (input.route) rec.route = input.route;
    rec.amend_count++;
    this.bump(rec);
    if (changed && rec.rid) this.transport?.amend(rec.rid, this.content(rec), images); // 配送先だけの変更は端末へ送らない
    this.save();
    return this.toAi(rec);
  }

  resume(id: string, body: unknown) {
    const route = parse(routeSchema, body);
    const rec = this.rec(id);
    if (rec.status === "answered") this.markFetched(rec);
    else {
      this.assertOpen(rec);
      rec.route = route;
      this.bump(rec);
    }
    this.save();
    return this.toAi(rec, route.channel_id);
  }

  cancel(id: string, reason: unknown) {
    const text = parse(z.string().trim().min(1).max(500), reason);
    const rec = this.rec(id);
    this.assertOpen(rec);
    Object.assign(rec, { status: "cancelled", cancel_reason: text });
    this.bump(rec);
    if (rec.rid) this.transport?.cancel(rec.rid, text);
    this.save();
    return this.toAi(rec);
  }

  private markFetched(rec: Rec) {
    if (rec.status !== "answered" || rec.delivery === "fetched") return;
    rec.delivery = "fetched";
    this.bump(rec);
  }

  // ---- 端末の答え（peer-channel の Connector から）----

  /** 8.3 の7行目: その申請の今の選択肢に合う答えか。選択肢・文・添付のどれかが要る（サーバーの answerSchema と同じ）。 */
  validAnswer(rid: string, content: unknown, blobCount = 0) {
    const rec = this.store.decisions.find((d) => d.rid === rid);
    const r = answerSchema.safeParse(content);
    return !!rec && OPEN.includes(rec.status) && r.success && (!!r.data.option_id || !!r.data.text || blobCount > 0)
      && (!r.data.option_id || rec.options.some((o) => o.id === r.data.option_id));
  }

  answered(rid: string, content: unknown, blobs: InBlob[] = []) {
    const rec = this.store.decisions.find((d) => d.rid === rid);
    if (!rec || !OPEN.includes(rec.status)) return;
    const a = answerSchema.parse(content);
    const option = a.option_id ? rec.options.find((o) => o.id === a.option_id) : undefined;
    const files = this.keepFiles(rec.id, blobs.map((b) => ({ bytes: b.bytes, content_type: b.meta.content_type, name: b.meta.name })));
    const answer: Answer = { ...(option ? { option_id: option.id } : {}), ...(a.text ? { text: a.text } : {}), ...(files.length ? { attachments: files } : {}), answered_at: now() };
    Object.assign(rec, { status: "answered", answer, delivery: "waiting", delivery_id: randomUUID(), delivery_text: deliveryText(rec, answer, option) });
    delete rec.delivery_detail;
    this.bump(rec);
    this.save();
    this.events.emit("deliveries");
  }

  /** 端末で「保留」にした・戻した（peer-channel 0.5.2 の hold）。決めてはいない。後の答えが決める。 */
  held(rid: string, held: boolean) {
    const rec = this.store.decisions.find((d) => d.rid === rid);
    if (!rec || !OPEN.includes(rec.status) || (rec.status === "held") === held) return;
    rec.status = held ? "held" : "pending";
    this.bump(rec);
    this.save();
  }

  /** 端末へ届かないまま outbox の期限（既定14日）が来た。 */
  expired(rid: string) {
    const rec = this.store.decisions.find((d) => d.rid === rid);
    if (!rec || !OPEN.includes(rec.status)) return;
    Object.assign(rec, { status: "cancelled", cancel_reason: "expired" });
    this.bump(rec);
    this.save();
  }

  // ---- 配送（デーモン）----

  deliveries() {
    return this.store.decisions.filter((d) => d.status === "answered" && d.delivery === "waiting" && d.route)
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
      .map((d) => ({ decision_id: d.id, delivery_id: d.delivery_id!, route: d.route!, text: d.delivery_text!, ...(d.answer?.attachments?.length ? { attachments: d.answer.attachments } : {}) }));
  }

  report(id: string, body: unknown) {
    const input = parse(z.object({ state: z.enum(["delivered", "unknown", "failed"]), detail: z.string().max(1000).optional() }), body);
    const rec = this.rec(id);
    if (rec.status !== "answered" || rec.delivery !== "waiting") return { decision_id: id, delivery: rec.delivery };
    rec.delivery = input.state === "delivered" ? "delivered" : "unknown";
    if (input.detail) rec.delivery_detail = input.detail;
    this.bump(rec);
    this.save();
    return { decision_id: id, delivery: rec.delivery };
  }

  // ---- セットアップ確認（サーバーの状態へは送らない。adoption 7 の残り）----

  startSetupTest(body: unknown) {
    const input = parse(z.object({ client: z.string().trim().min(1).max(40), os: z.string().max(20).optional(), session_label: z.string().trim().min(1).max(200), route: routeSchema.optional() }), body);
    for (const old of this.store.decisions.filter((d) => d.test && d.client === input.client && OPEN.includes(d.status))) {
      Object.assign(old, { status: "cancelled", cancel_reason: "新しいテストに置き換えた" });
      this.bump(old);
      if (old.rid) this.transport?.cancel(old.rid, "新しいテストに置き換えた");
    }
    const rec = this.create({
      title: "Approval Boxの接続テスト",
      context: "Approval Boxのセットアップ確認です。どちらを選んでもかまいません。答えがAIまで届けば、このAIは確認済みになります。",
      options: [{ id: "ok", label: "届いた（テスト）" }, { id: "again", label: "もう一度（テスト）" }],
      urgency: "normal", session_label: input.session_label, client: input.client, ...(input.route ? { route: input.route } : {}),
    }, true);
    rec.setup_code = String(randomInt(100000, 1000000));
    this.save();
    return this.toAi(rec, input.route?.channel_id);
  }

  confirmSetupTest(body: unknown) {
    const input = parse(z.object({ decision_id: z.string(), code: z.string() }), body);
    const rec = this.rec(input.decision_id);
    if (!rec.setup_code) error("not_found", "この申請は接続テストではありません。");
    if (rec.setup_code !== input.code.trim()) error("validation_failed", "確認コードが違います。届いた答えに書かれたコードをそのまま渡してください。");
    if (rec.delivery !== "delivered" && rec.delivery !== "fetched") { rec.delivery = "delivered"; this.bump(rec); }
    this.save();
    this.onSetupPassed?.(rec.client);
    return { status: "passed", client: rec.client };
  }

  // ---- 申請画像と答えの添付（この端末の 0600 のファイル。サーバーへは送らない）----

  /** ソケットで届いた申請画像を state/pc/uploads に 0600 で置き、その印を返す（LocalApi.uploadRequestImage → POST /uploads）。 */
  stageUpload(data: Buffer, name: string, contentType: string): { id: string } {
    const id = randomUUID();
    const dir = join(this.root, "uploads");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, id), data, { mode: 0o600 });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ name, content_type: contentType }), { mode: 0o600 });
    return { id };
  }

  /** MCP が置いた申請画像を受け取る（置いた側は stageUpload）。 */
  private takeUploads(ids: string[]): OutBlob[] {
    if (new Set(ids).size !== ids.length) error("validation_failed", "同じ申請画像が2回並んでいます。");
    const out = ids.map((id) => {
      const base = join(this.root, "uploads", id.replace(/[^A-Za-z0-9-]/g, ""));
      if (!existsSync(base) || !existsSync(`${base}.json`)) error("validation_failed", "使えない申請画像があります。もう一度付け直してください。");
      const meta = JSON.parse(readFileSync(`${base}.json`, "utf8")) as { name: string; content_type: string };
      return { bytes: new Uint8Array(readFileSync(base)), content_type: meta.content_type, name: meta.name, base };
    });
    if (out.reduce((n, x) => n + x.bytes.length, 0) > MAX_REQUEST_BYTES) error("too_large", "申請画像は合計50MBまでです。");
    for (const x of out) { rmSync(x.base, { force: true }); rmSync(`${x.base}.json`, { force: true }); }
    return out.map(({ base: _, ...x }) => x);
  }

  private keepFiles(decisionId: string, blobs: OutBlob[]): FileMeta[] {
    if (!blobs.length) return [];
    const dir = join(this.root, "files", decisionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return blobs.map((b) => {
      const id = randomUUID();
      writeFileSync(join(dir, id), b.bytes, { mode: 0o600 });
      return { id, name: b.name, content_type: b.content_type, size: b.bytes.length, sha256: createHash("sha256").update(b.bytes).digest("hex") };
    });
  }

  private dropFiles(decisionId: string, files: FileMeta[]) {
    for (const f of files) rmSync(join(this.root, "files", decisionId, f.id), { force: true });
  }

  /** 添付の中身（Api.download と同じ道 /decisions/:id/attachments/:aid）。 */
  download(path: string): Buffer {
    const m = /^\/decisions\/([^/]+)\/attachments\/([^/?]+)$/.exec(path);
    const rec = m ? this.store.decisions.find((d) => d.id === decodeURIComponent(m[1]!)) : undefined;
    const aid = m ? decodeURIComponent(m[2]!) : "";
    const known = rec && [...(rec.request_attachments ?? []), ...(rec.answer?.attachments ?? [])].some((f) => f.id === aid);
    if (!rec || !known) return error("not_found", "その添付は見つかりません。");
    return readFileSync(join(this.root, "files", rec.id, aid));
  }

  /** 答え・取り下げから30日たった申請を消す（サーバーの既定の保存期間と同じ）。 */
  prune() {
    const before = Date.now() - KEEP_CLOSED_MS;
    for (const d of this.store.decisions) if (!OPEN.includes(d.status) && Date.parse(d.updated_at) < before) rmSync(join(this.root, "files", d.id), { recursive: true, force: true });
    this.store.decisions = this.store.decisions.filter((d) => OPEN.includes(d.status) || Date.parse(d.updated_at) >= before);
  }

  /** 開いている申請があるか（デーモンの休止の判断）。 */
  hasOpen() { return this.store.decisions.some((d) => OPEN.includes(d.status)); }

  /** /connector/v1 の申請の経路（MCPとデーモンが Api.call で使う形）を手元で答える。 */
  route(method: string, path: string, body?: unknown): unknown {
    const url = new URL(path, "http://local");
    const channel = url.searchParams.get("channel_id") ?? undefined;
    const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const key = `${method} /${p.map((s, i) => (i === 1 && (p[0] === "decisions" || p[0] === "deliveries") ? ":id" : s)).join("/")}`;
    const id = p[1] ?? "";
    switch (key) {
      case "GET /decisions": return { items: this.list(channel) };
      case "POST /decisions": return this.toAi(this.create(body), (body as { route?: Route })?.route?.channel_id);
      case "GET /decisions/:id": return this.toAi(this.rec(id), channel);
      case "POST /decisions/:id/fetched": { const r = this.rec(id); this.markFetched(r); this.save(); return this.toAi(r); }
      case "POST /decisions/:id/resume": return this.resume(id, body);
      case "POST /decisions/:id/amend": return this.amend(id, body);
      case "POST /decisions/:id/cancel": return this.cancel(id, (body as { reason?: unknown })?.reason);
      case "POST /setup-test": return this.startSetupTest(body);
      case "POST /setup-test/confirm": return this.confirmSetupTest(body);
      case "GET /deliveries": return { items: this.deliveries() };
      case "POST /deliveries/:id": return this.report(id, body);
      default:
        return error("not_found", `この経路は手元にありません: ${method} ${url.pathname}`);
    }
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/** server/decisions.ts の deliveryText と同じ文。接続テストは確認コードを添える。 */
function deliveryText(rec: Rec, answer: Answer, option: Option | undefined): string {
  const lines = [`[Approval Box] あなたが request_decision で出した申請 ${rec.id}「${rec.title}」に、利用者が答えました。`];
  if (option) lines.push(`答え: ${option.label}（option_id=${option.id}）`);
  if (answer.text) lines.push(option ? `添え書き: ${answer.text}` : `答え（文）: ${answer.text}`);
  if (answer.attachments?.length) {
    lines.push(`添付 ${answer.attachments.length}件（Approval Boxの get_attachment に decision_id="${rec.id}" と attachment_id を渡すと取れます）:`);
    answer.attachments.forEach((a, i) => lines.push(`${i + 1}. ${a.name}（${a.content_type}、${formatBytes(a.size)}） attachment_id=${a.id}`));
  }
  if (rec.setup_code) {
    lines.push("", `これはあなたが setup_test で始めた接続テストです。確認コード: ${rec.setup_code}`,
      `Approval Boxの confirm_setup_test を decision_id="${rec.id}", code="${rec.setup_code}" で呼んでください。それでセットアップ確認が終わります。`);
  } else {
    lines.push("", option ? "この答えに従って作業を続けてください。" : answer.text ? "この指示に従って作業を続けてください。" : "添付を確かめて作業を続けてください。", SPEAK_BY_TITLE);
  }
  return lines.join("\n");
}
