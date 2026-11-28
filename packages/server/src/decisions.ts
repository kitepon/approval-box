import { z } from "zod";
import { type Attachment, MAX_ANSWER_BYTES, MAX_PER_ANSWER, attachmentMeta, formatBytes } from "./attachments.ts";
import { type Db, all, get, run, tx } from "./db.ts";
import { PURGE_CAP_MS, vaultOf } from "./seal.ts";
import { ApiError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { decisionId, hash, normalizeTitle, now, secret, testCode, uuid } from "./ids.ts";

export const URGENCIES = ["low", "normal", "high"] as const;
export const AMEND_FIELDS = ["title", "context", "options", "recommendation", "urgency", "deadline", "request_attachment_ids"] as const;
const OPEN = ["pending", "held"];
/** サーバーが自分で答えを届ける道（GrokBotなど、call-bridge の通話で届ける）。 */
export const SERVER_HARNESS = "callbridge";
const CREATE_LIMIT_PER_HOUR = 60;
const AMEND_LIMIT = 20;
const DAY_MS = 86400_000;
/** A tombstone (id and state, no content) stays this long after its content went. */
export const TOMBSTONE_MS = 30 * DAY_MS;
/** An undecided or held request expires (cancelled, reason "expired") this long after it was made. */
export const OPEN_EXPIRY_MS = 14 * DAY_MS;
/** The content columns of decisions, each sealed with context "<id>|<column>". */
const CONTENT = ["title", "context", "options", "recommendation", "answer", "delivery_text", "cancel_reason", "distinct_reason"] as const;
type Content = Record<(typeof CONTENT)[number], string | null>;
const REMOVED_FOR_AI = "この申請はすでに決まり、中身はサーバーから消えています（AIと端末へ届いた後か、決まってから7日で消えます）。";

export type Option = { id: string; label: string };
export type Route = { channel_id: string; harness: string };
export type Answer = { option_id?: string; text?: string; attachments?: Attachment[]; answered_at: string };

/** A decisions row as stored: content columns hold sealed blobs (text only before the migration). */
type Stored = Omit<Row, (typeof CONTENT)[number]> & { [K in (typeof CONTENT)[number]]: string | Uint8Array | null };
/** A row with its content opened (in memory only, for one response), its history notes and request attachments. */
type Row = {
  id: string; user_id: string; connection_id: string | null; route: string | null;
  content_state: string; sealed_set: string | null; decided_at: string | null; purge_by: string | null; ai_seen_at: string | null; purged_at: string | null;
  title: string; context: string; options: string; recommendation: string | null;
  urgency: string; deadline: string | null; client: string; session_label: string; requester: string | null; requester_bot_id: string | null; via: string; test: number;
  status: string; answer: string | null; delivery: string | null; delivery_id: string | null; delivery_detail: string | null; delivery_text: string | null;
  resume_phrase: string; cancel_reason: string | null; distinct_reason: string | null; amend_count: number;
  created_at: string; updated_at: string; version: number;
};
type HistoryRow = { decision_id: string; at: string; kind: string; by: string; note: string | null; fields: string | null };
type Plain = Row & { purged: boolean; historyRows: HistoryRow[]; requestAttachmentList: Attachment[] };

export type Connection = { id: string; user_id: string; label: string; os: string | null };

export const optionSchema = z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200) });
const optionsSchema = z.array(optionSchema).min(2).max(6).refine((options) => new Set(options.map((o) => o.id)).size === options.length, "選択肢のidが重なっています");

const requestIds = z.array(z.string().min(1).max(100)).max(MAX_PER_ANSWER);

export const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  context: z.string().max(20000).default(""),
  options: optionsSchema,
  recommendation: z.string().optional(),
  urgency: z.enum(URGENCIES).default("normal"),
  deadline: z.iso.datetime({ offset: true }).optional(),
  session_label: z.string().trim().min(1).max(200),
  /** 申請するAI自身の名前（自己申告）。0.1.25までのコネクタは送らない。 */
  requester: z.string().trim().min(1).max(60).optional(),
  /** BellTeamの席から出た申請のBot ID（自己申告・表示用。認証ではない）。 */
  requester_bot_id: z.string().regex(/^bot-[a-z0-9]+$/).max(64).optional(),
  client: z.string().trim().min(1).max(40),
  route: z.object({ channel_id: z.string().min(1).max(100), harness: z.string().min(1).max(20) }).optional(),
  distinct_reason: z.string().trim().min(1).max(500).optional(),
  check_token: z.string().max(200).optional(),
  request_attachment_ids: requestIds.optional(),
});

export const routeSchema = z.object({ channel_id: z.string().min(1).max(100), harness: z.string().min(1).max(20) });

export const amendSchema = z.object({
  route: routeSchema.optional(),
  version: z.number().int().positive(),
  note: z.string().trim().min(1).max(500),
  changes: z.object({
    request_attachment_ids: requestIds.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    context: z.string().max(20000).optional(),
    options: optionsSchema.optional(),
    recommendation: z.string().nullable().optional(),
    urgency: z.enum(URGENCIES).optional(),
    deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  }).refine((changes) => Object.keys(changes).length > 0, "直す項目がありません"),
});

export const answerSchema = z.object({
  option_id: z.string().optional(),
  text: z.string().trim().max(5000).optional(),
  attachment_ids: z.array(z.string().min(1).max(100)).max(MAX_PER_ANSWER, `添付は${MAX_PER_ANSWER}ファイルまでです`).optional(),
  version: z.number().int().positive(),
}).refine((body) => body.option_id || body.text || body.attachment_ids?.length, "選択肢・文・添付のどれかが必要です");

const CHECK_TTL_MS = 30 * 60_000;

/** AIが利用者へ申請の話をする時の伝え方。アプリは申請のIDを出さないので、IDで言われても利用者はどの申請か分からない（クオの指摘 2026-10-14）。 */
export const SPEAK_BY_TITLE = "利用者へこの申請の話をする時は、件名で伝えてください。アプリには件名・申請者・作業名が出て、申請のIDは出ません。IDは道具を呼ぶ時に使います。";

const urgencyRank: Record<string, number> = { high: 0, normal: 1, low: 2 };

function compareDeadlines(a: string | null, b: string | null) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const milliseconds = Date.parse(a) - Date.parse(b);
  if (milliseconds) return milliseconds;
  // Date.parse truncates sub-millisecond digits that the input schema accepts.
  const fractionA = (a.match(/\.(\d+)/)?.[1] ?? "").replace(/0+$/, "");
  const fractionB = (b.match(/\.(\d+)/)?.[1] ?? "").replace(/0+$/, "");
  return fractionA < fractionB ? -1 : fractionA > fractionB ? 1 : 0;
}

export class Decisions {
  private readonly db: Db;
  private readonly events: EventHub;

  constructor(db: Db, events: EventHub) {
    this.db = db;
    this.events = events;
  }

  private get vault() { return vaultOf(this.db); }

  // ---- 封をした中身（seal.ts）----

  /** Opens a stored row for one response (in memory only). A purged row (tombstone) has no content to open. */
  async open(row: Stored): Promise<Plain> {
    const purged = row.content_state === "purged";
    const set = row.sealed_set ?? row.user_id;
    const vault = this.vault;
    if (purged) {
      return { ...row, title: "", context: "", options: "[]", recommendation: null, answer: null, delivery_text: null, cancel_reason: null, distinct_reason: null, purged, historyRows: [], requestAttachmentList: [] };
    }
    const values = await Promise.all(CONTENT.map((c) => vault.open(set, `${row.id}|${c}`, row[c])));
    const content = Object.fromEntries(CONTENT.map((c, i) => [c, values[i]])) as Content;
    const historyRows = await Promise.all(all<Omit<HistoryRow, "note"> & { note: string | Uint8Array | null }>(this.db, "select * from history where decision_id = ? order by id", row.id)
      .map(async (h) => ({ ...h, note: await vault.open(set, `${row.id}|note`, h.note) })));
    const requestAttachmentList = await Promise.all(all<Parameters<typeof attachmentMeta>[1]>(this.db,
      "select id,name,content_type,kind,size,sha256,created_at,sealed_set,user_id from attachments where decision_id=? and purpose='request' order by position", row.id)
      .map((a) => attachmentMeta(this.db, a)));
    return { ...row, ...content, title: content.title ?? "", context: content.context ?? "", options: content.options ?? "[]", purged, historyRows, requestAttachmentList };
  }

  /** The app's form of a stored row. */
  async view(row: Stored) { return this.toApi(await this.open(row)); }

  private content(row: Plain): Content {
    return Object.fromEntries(CONTENT.map((c) => [c, row[c]])) as Content;
  }

  /** Seals every content column. Each write reseals the whole row, so it moves to the set's current data key on the way. */
  private async sealContent(set: string, id: string, content: Content): Promise<Sealed> {
    const vault = this.vault;
    const sealed = await Promise.all(CONTENT.map((c) => vault.seal(set, `${id}|${c}`, content[c])));
    return Object.fromEntries(CONTENT.map((c, i) => [c, sealed[i]])) as Sealed;
  }

  private sealNote(set: string, id: string, note: string) { return this.vault.seal(set, `${id}|note`, note); }

  /** Inside the write's transaction. */
  private writeContent(id: string, set: string, s: Sealed) {
    run(this.db, `update decisions set title = ?, norm_title = '', context = ?, options = ?, recommendation = ?, answer = ?, delivery_text = ?, cancel_reason = ?,
        distinct_reason = ?, content_state = 'sealed', sealed_set = ? where id = ?`,
      s.title, s.context, s.options, s.recommendation, s.answer, s.delivery_text, s.cancel_reason, s.distinct_reason, set, id);
  }

  /**
   * One write on a row: open it and prepare (checks and seals, async), then commit in one transaction only if the row is still the version
   * that was opened; otherwise start again on the new state. Checks that need the content run in prepare on the opened row.
   */
  private async change<P>(load: () => Stored, prepare: (row: Plain) => Promise<P>, commit: (row: Stored, prepared: P) => void): Promise<Plain> {
    for (let attempt = 0; ; attempt++) {
      const before = load();
      const prepared = await prepare(await this.open(before));
      const done = tx(this.db, () => {
        const row = load();
        if (row.version !== before.version) return false;
        commit(row, prepared);
        return true;
      });
      if (done) return this.open(load());
      if (attempt >= 4) throw new ApiError("conflict", "申請の内容が変わっています。最新の内容を確かめてください。");
    }
  }

  /** The AI has the decided state (its result was delivered or fetched, it read the decided request, or it cancelled it). */
  private seenByAi(id: string) {
    run(this.db, "update decisions set ai_seen_at = coalesce(ai_seen_at, ?) where id = ? and status in ('answered','cancelled')", now(), id);
  }

  // ---- 表示 ----

  toApi(row: Plain) {
    const source = {
      client: row.client, session_label: displayLabel(row), work_label: row.session_label,
      ...(row.requester ? { requester: row.requester } : {}),
      ...(row.requester_bot_id ? { requester_bot_id: row.requester_bot_id } : {}),
      ...this.connectionLabel(row),
      via: row.via, ...(row.test ? { test: true } : {}),
    };
    if (row.purged) {
      // Tombstone: id, state and timestamps; the content went after the devices stored it (or after 7 days).
      return {
        id: row.id, title: "", context: "", request_attachments: [], options: [], urgency: row.urgency, source, status: row.status,
        ...(row.delivery ? { delivery: row.delivery } : {}), resume_phrase: row.resume_phrase, content_removed: true, history: [],
        created_at: row.created_at, updated_at: row.updated_at, version: row.version,
      };
    }
    const history = row.historyRows.map((h) => ({
      at: h.at, kind: h.kind, by: h.by,
      ...(h.note ? { note: h.note } : {}),
      ...(h.fields ? { fields: JSON.parse(h.fields) as string[] } : {}),
    }));
    return {
      id: row.id,
      title: row.title,
      context: row.context,
      request_attachments: row.requestAttachmentList,
      options: JSON.parse(row.options) as Option[],
      ...(row.recommendation ? { recommendation: row.recommendation } : {}),
      urgency: row.urgency,
      ...(row.deadline ? { deadline: row.deadline } : {}),
      source,
      status: row.status,
      ...(row.answer ? { answer: JSON.parse(row.answer) as Answer } : {}),
      ...(row.delivery ? { delivery: row.delivery } : {}),
      resume_phrase: row.resume_phrase,
      ...(row.cancel_reason ? { cancel_reason: row.cancel_reason } : {}),
      ...(row.distinct_reason ? { distinct_reason: row.distinct_reason } : {}),
      history,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
    };
  }

  /** コネクタ（AI側）へ返す形。答えがあれば、AIへ渡す文も付ける。中身を消した申請は状態だけ（content_removed）。 */
  toAi(row: Plain, routeChannel?: string) {
    const route = row.route ? (JSON.parse(row.route) as Route) : null;
    return {
      decision_id: row.id,
      title: row.title,
      status: row.status,
      version: row.version,
      urgency: row.urgency,
      options: JSON.parse(row.options) as Option[],
      ...(row.recommendation ? { recommendation: row.recommendation } : {}),
      ...(row.deadline ? { deadline: row.deadline } : {}),
      context: row.context,
      request_attachments: row.requestAttachmentList,
      session_label: row.session_label,
      ...(row.requester ? { requester: row.requester } : {}),
      this_session: !!routeChannel && route?.channel_id === routeChannel,
      ...(row.answer ? { answer: JSON.parse(row.answer) as Answer, answer_text: row.delivery_text } : {}),
      ...(row.delivery ? { delivery: row.delivery } : {}),
      ...(row.cancel_reason ? { cancel_reason: row.cancel_reason } : {}),
      ...(row.purged ? { content_removed: true, message: REMOVED_FOR_AI } : {}),
      ...(row.test ? { test: true } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** どの端末（接続）から出た申請か。接続が消えていれば付けない。 */
  private connectionLabel(row: Pick<Stored, "connection_id">): { connection_label?: string } {
    if (!row.connection_id) return {};
    const label = get<{ label: string }>(this.db, "select label from connections where id = ?", row.connection_id)?.label;
    return label ? { connection_label: label } : {};
  }

  /** create/amend内で結ぶ。置換は全件検証してから、同じ取引で行う。名前は封をしたまま（sealed_set ごと）写す。 */
  private bindRequest(conn: Connection, id: string, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new ApiError("validation_failed", "同じ申請画像が2回並んでいます。");
    type Item = Omit<Attachment, "name"> & { name: string | Uint8Array; sealed_set: string | null };
    const list = ids.map(aid => {
      const staged = get<Item>(this.db, "select * from request_uploads where id=? and connection_id=? and user_id=?", aid, conn.id, conn.user_id);
      const prior = get<Item>(this.db, "select * from attachments where id=? and decision_id=? and user_id=? and purpose='request'", aid,id,conn.user_id);
      if (!staged && !prior) throw new ApiError("validation_failed", "使えない申請画像があります。もう一度付け直してください。");
      return { item: (staged ?? prior)!, staged: !!staged };
    });
    if (list.reduce((n,a) => n+a.item.size,0) > MAX_ANSWER_BYTES) throw new ApiError("too_large", "申請画像は合計50MBまでです。");
    run(this.db, "delete from attachments where decision_id=? and purpose='request'", id);
    list.forEach(({item:a,staged},position) => {
      run(this.db, "insert into attachments (id,user_id,decision_id,name,content_type,kind,size,sha256,position,created_at,purpose,sealed_set) values (?,?,?,?,?,?,?,?,?,?,'request',?)", a.id,conn.user_id,id,a.name,a.content_type,a.kind,a.size,a.sha256,position,a.created_at,a.sealed_set);
      if (staged) run(this.db, "delete from request_uploads where id=?", a.id);
    });
  }

  private row(id: string): Stored | undefined {
    return get<Stored>(this.db, "select * from decisions where id = ?", id);
  }

  private history(id: string, kind: string, by: "ai" | "user", note?: Uint8Array | null, fields?: string[]) {
    run(this.db, "insert into history (decision_id, at, kind, by, note, fields) values (?, ?, ?, ?, ?, ?)",
      id, now(), kind, by, note ?? null, fields ? JSON.stringify(fields) : null);
  }

  private changed(row: Pick<Stored, "id" | "user_id" | "version">, change?: string) {
    this.events.publish(row.user_id, "decision.updated", { decision_id: row.id, version: row.version, ...(change ? { change } : {}) });
  }

  // ---- 利用者（アプリ・Web版）----

  forUser(userId: string, id: string): Stored {
    const row = this.row(id);
    if (!row || row.user_id !== userId) throw new ApiError("not_found", "その申請は見つかりません。");
    return row;
  }

  /** Tombstones are not listed: their content is in the devices' history now. */
  async list(userId: string, statuses: string[], limit: number, cursor: number) {
    const marks = statuses.map(() => "?").join(",");
    const rows = all<Stored>(this.db, `select * from decisions where user_id = ? and status in (${marks}) and content_state <> 'purged'`, userId, ...statuses);
    const openOnly = statuses.every((s) => OPEN.includes(s));
    rows.sort(openOnly
      ? (a, b) => (urgencyRank[a.urgency]! - urgencyRank[b.urgency]!)
        || compareDeadlines(a.deadline, b.deadline)
        || (a.created_at < b.created_at ? -1 : 1)
      : (a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const page = rows.slice(cursor, cursor + limit);
    const next = cursor + limit < rows.length ? String(cursor + limit) : undefined;
    return { items: await Promise.all(page.map((row) => this.view(row))), ...(next ? { next_cursor: next } : {}) };
  }

  async answer(userId: string, id: string, body: z.infer<typeof answerSchema>) {
    this.vault.assertReady();
    const answered = await this.change(() => this.forUser(userId, id), async (row) => {
      this.assertOpen(row, "user");
      if (row.version !== body.version) throw new ApiError("conflict", "AIが内容を直したか、別の画面で答えが出ています。最新の内容を確かめてください。", { decision: this.toApi(row) });
      const options = JSON.parse(row.options) as Option[];
      const option = body.option_id ? options.find((o) => o.id === body.option_id) : undefined;
      if (body.option_id && !option) throw new ApiError("validation_failed", "その選択肢はありません。");
      const ids = body.attachment_ids ?? [];
      const attachments = await Promise.all(this.stagedFor(row, ids).map((a) => attachmentMeta(this.db, a)));
      const answer: Answer = { ...(option ? { option_id: option.id } : {}), ...(body.text ? { text: body.text } : {}), ...(attachments.length ? { attachments } : {}), answered_at: now() };
      const check = row.test ? get<{ code: string }>(this.db, "select code from setup_checks where decision_id = ?", row.id) : undefined;
      const text = deliveryText(row, answer, option, check?.code);
      const set = row.sealed_set ?? row.user_id;
      return { ids, set, sealed: await this.sealContent(set, row.id, { ...this.content(row), answer: JSON.stringify(answer), delivery_text: text }) };
    }, (row, p) => {
      this.bindAttachments(row, p.ids);
      const at = now();
      run(this.db, "update decisions set status = 'answered', delivery = 'waiting', delivery_id = ?, delivery_detail = null, decided_at = ?, purge_by = ?, updated_at = ?, version = version + 1 where id = ?",
        uuid(), at, capFrom(at), at, row.id);
      this.writeContent(row.id, p.set, p.sealed);
      this.history(row.id, "answered", "user");
      if (row.test) run(this.db, "update setup_checks set status = 'waiting_ai' where decision_id = ?", row.id);
      const updated = this.row(row.id)!;
      this.changed(updated, "answered");
      if (row.test) this.events.publish(userId, "setup.updated", {});
      if (updated.connection_id) this.events.notifyConnection(updated.connection_id);
    });
    return this.toApi(answered);
  }

  /** 答えに結べる下書きの添付（この申請の、まだ結ばれていない下書きだけ）。全部を確かめてから返す。 */
  private stagedFor(row: Pick<Stored, "id" | "user_id">, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new ApiError("validation_failed", "同じ添付が2回並んでいます。");
    const found = ids.map((aid) => get<Parameters<typeof attachmentMeta>[1] & { position: number | null }>(this.db,
      "select id, name, content_type, kind, size, sha256, created_at, position, sealed_set, user_id from attachments where id = ? and decision_id = ? and user_id = ? and purpose = 'answer'", aid, row.id, row.user_id));
    if (found.some((a) => !a || a.position !== null)) throw new ApiError("validation_failed", "使えない添付があります。もう一度付け直してください。");
    const list = found.map((a) => a!);
    if (list.reduce((n, a) => n + a.size, 0) > MAX_ANSWER_BYTES) throw new ApiError("too_large", `1つの答えの添付は合計${formatBytes(MAX_ANSWER_BYTES)}までです。`);
    return list;
  }

  /**
   * 下書きの添付を答えに結ぶ（answer と同じ取引の中で呼ぶ）。全部がこの申請の、まだ結ばれていない下書きの時だけ結ぶ。
   * 結ばなかった下書きは消す（ファイルは Attachments.gc が消す）。
   */
  private bindAttachments(row: Pick<Stored, "id" | "user_id">, ids: string[]) {
    this.stagedFor(row, ids).forEach((a, i) => run(this.db, "update attachments set position = ? where id = ?", i, a.id));
    run(this.db, "delete from attachments where decision_id = ? and position is null", row.id);
  }

  async setHold(userId: string, id: string, hold: boolean) {
    const status = hold ? "held" : "pending";
    const row = await this.change(() => this.forUser(userId, id), async (row) => { this.assertOpen(row, "user"); }, (row) => {
      if (row.status === status) return;
      run(this.db, "update decisions set status = ?, updated_at = ?, version = version + 1 where id = ?", status, now(), row.id);
      this.history(row.id, hold ? "held" : "unheld", "user");
      this.changed(this.row(row.id)!);
    });
    return this.toApi(row);
  }

  deleteClosed(userId: string) {
    return tx(this.db, () => {
      const ids = all<{ id: string }>(this.db, "select id from decisions where user_id = ? and status in ('answered','cancelled')", userId).map((r) => r.id);
      run(this.db, "delete from decisions where user_id = ? and status in ('answered','cancelled')", userId);
      for (const id of ids) this.events.publish(userId, "decision.deleted", { decision_id: id });
      return { deleted: ids.length };
    });
  }

  purgeExpired() {
    const users = all<{ id: string; retention_days: number }>(this.db, "select id, retention_days from users");
    for (const user of users) {
      const before = new Date(Date.now() - user.retention_days * 86400_000).toISOString();
      const ids = all<{ id: string }>(this.db, "select id from decisions where user_id = ? and status in ('answered','cancelled') and updated_at < ?", user.id, before);
      for (const { id } of ids) {
        run(this.db, "delete from decisions where id = ?", id);
        this.events.publish(user.id, "decision.deleted", { decision_id: id });
      }
    }
  }

  /**
   * Every minute (storage-lifecycle.md "Sealed content"): open requests past OPEN_EXPIRY_MS expire; decided content goes once the AI has the
   * result and every keyhole (device) of the account acked storing it, or at purge_by (7 days) regardless; tombstones go TOMBSTONE_MS after;
   * replayable idempotency answers go after a day. Returns how many were purged (their attachment files go with the next Attachments.gc).
   * A failure leaves the rest for the next minute.
   */
  async sweepContent(at = Date.now()) {
    const iso = (ms: number) => new Date(ms).toISOString();
    // Expiry reseals the reason, so it waits for a window; the purge below only deletes and runs without one.
    if (this.vault.ready) for (const { id, user_id } of all<{ id: string; user_id: string }>(this.db, "select id, user_id from decisions where status in ('pending','held') and created_at < ?", iso(at - OPEN_EXPIRY_MS))) {
      await this.cancelByServer(() => this.forUser(user_id, id), "expired", iso(at)).catch((error: unknown) => console.error(`approval-box-server: expire_failed ${error instanceof ApiError ? error.code : "error"}`));
    }
    const due = all<{ id: string; user_id: string }>(this.db, `select id, user_id from decisions d where content_state <> 'purged' and status in ('answered','cancelled') and (
        purge_by <= ?
        or (ai_seen_at is not null and exists (select 1 from keyholes k where k.entry = d.user_id)
          and not exists (select 1 from keyholes k where k.entry = d.user_id
            and not exists (select 1 from decision_stored s where s.decision_id = d.id and s.device = k.key))))`, iso(at));
    let purged = 0;
    for (const { id, user_id } of due) {
      tx(this.db, () => {
        const done = run(this.db, `update decisions set title = '', norm_title = '', context = '', options = '[]', recommendation = null, answer = null, delivery_text = null,
            cancel_reason = null, distinct_reason = null, content_state = 'purged', purged_at = ?, version = version + 1 where id = ? and content_state <> 'purged'`, iso(at), id).changes;
        if (!done) return;
        run(this.db, "update history set note = null where decision_id = ?", id);
        run(this.db, "delete from attachments where decision_id = ?", id);
        run(this.db, "delete from decision_stored where decision_id = ?", id);
        // A saved answer of a write on this request replays its content: it goes too.
        run(this.db, "delete from idempotency where user_id = ? and instr(route, ?) > 0", user_id, `/decisions/${id}/`);
        this.changed(this.row(id)!, "content_removed");
        purged++;
      });
    }
    for (const { id, user_id } of all<{ id: string; user_id: string }>(this.db, "select id, user_id from decisions where content_state = 'purged' and purged_at < ?", iso(at - TOMBSTONE_MS))) {
      tx(this.db, () => {
        run(this.db, "delete from decisions where id = ?", id);
        this.events.publish(user_id, "decision.deleted", { decision_id: id });
      });
    }
    run(this.db, "delete from idempotency where created_at < ?", iso(at - DAY_MS));
    return purged;
  }

  /** A device stored the decided request in its own history (POST /v1/decisions/{id}/stored). Idempotent; device = its keyhole. */
  stored(userId: string, id: string, device: string) {
    const row = this.forUser(userId, id);
    if (OPEN.includes(row.status)) throw new ApiError("conflict", "まだ決まっていない申請です。決まってから保存を知らせてください。");
    const removed = row.content_state === "purged";
    if (!removed) run(this.db, "insert or ignore into decision_stored (decision_id, device, at) values (?, ?, ?)", id, device, now());
    return { decision_id: id, stored: true, ...(removed ? { content_removed: true } : {}) };
  }

  /** Checks run on the opened row. The AI is told the decided state with this refusal, which counts as the AI having it. */
  private assertOpen(row: Plain, by: "ai" | "user") {
    if (OPEN.includes(row.status)) return;
    const message = row.purged
      ? (by === "ai" ? REMOVED_FOR_AI : "この申請はすでに決まり、中身はサーバーから消えています。")
      : row.status === "answered"
        ? (by === "ai" ? "利用者がすでに答えています。answer_text の答えに従ってください。" : "この申請にはすでに答えが出ています。")
        : (by === "ai" ? "この申請はすでに取り下げられています。" : "この申請はAIが取り下げました。");
    if (by === "ai") this.seenByAi(row.id);
    throw new ApiError("conflict", message, { decision: by === "ai" ? this.toAi(row) : this.toApi(row) });
  }

  // ---- AI（コネクタ）----

  forConnection(conn: Connection, id: string): Stored {
    const row = this.row(id);
    // 他の接続が出した申請は、見ることも直すこともできない。
    if (!row || row.connection_id !== conn.id) throw new ApiError("not_found", "その申請は見つかりません。この接続から出した申請だけを扱えます。");
    return row;
  }

  async listMine(conn: Connection, routeChannel?: string) {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const rows = all<Stored>(this.db,
      "select * from decisions where connection_id = ? and (status in ('pending','held') or updated_at >= ?) order by created_at desc",
      conn.id, since);
    return Promise.all(rows.map(async (row) => this.summary(row, await this.title(row), routeChannel)));
  }

  private async title(row: Stored) {
    return row.content_state === "purged" ? "" : (await this.vault.open(row.sealed_set ?? row.user_id, `${row.id}|title`, row.title)) ?? "";
  }

  /** 同じ接続を共有するAIの一覧に、本文や回答・添付を含めない。 */
  private summary(row: Stored, title: string, routeChannel?: string) {
    const route = row.route ? (JSON.parse(row.route) as Route) : null;
    const removed = row.content_state === "purged";
    return {
      decision_id: row.id, title, status: row.status, version: row.version,
      session_label: row.session_label, ...(row.requester ? { requester: row.requester } : {}),
      this_session: !!routeChannel && route?.channel_id === routeChannel,
      has_answer: row.answer !== null,
      ...(row.delivery ? { delivery: row.delivery } : {}),
      ...(removed ? { content_removed: true } : {}),
      ...(row.test ? { test: true } : {}),
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  /** Refuses (503) without a window: nothing is ever stored in plaintext. */
  async create(conn: Connection, input: z.infer<typeof createSchema>, options: { test?: boolean; via?: "connector" | "remote" } = {}) {
    this.vault.assertReady();
    if (!options.test) await this.requireCheck(conn, input);
    const prepared = await this.prepareCreate(conn, input, options);
    const row = tx(this.db, () => {
      if (!options.test) this.useCheck(conn, input.check_token!);
      return this.insert(conn, input, options, prepared);
    });
    return this.open(row);
  }

  private rateLimit(conn: Connection) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const recent = get<{ n: number }>(this.db, "select count(*) n from decisions where user_id = ? and created_at >= ?", conn.user_id, hourAgo)!.n;
    if (recent >= CREATE_LIMIT_PER_HOUR) throw new ApiError("rate_limited", "1時間に出せる申請の数を超えました。少し待ってください。", {}, 600);
  }

  /** The checks before the insert and the seals. Titles are sealed, so the duplicate check compares them opened. */
  private async prepareCreate(conn: Connection, input: z.infer<typeof createSchema>, options: { test?: boolean }) {
    this.rateLimit(conn);
    if (input.recommendation && !input.options.some((o) => o.id === input.recommendation)) throw new ApiError("validation_failed", "recommendation が選択肢のidにありません。");
    if (!options.test && !input.distinct_reason) {
      const norm = normalizeTitle(input.title);
      const open = all<Stored>(this.db, "select * from decisions where connection_id = ? and status in ('pending','held')", conn.id);
      const titles = await Promise.all(open.map((row) => this.title(row)));
      const existing = open.filter((_, i) => normalizeTitle(titles[i]!) === norm);
      if (existing.length) {
        throw new ApiError("duplicate_suspected",
          "同じ件名の申請がまだ答えを待っています。新しく出さず、amend_decision で直すか、cancel_decision で取り下げてください。別件なら distinct_reason を付けて出し直せます。",
          { existing: existing.map((row) => this.summary(row, titles[open.indexOf(row)]!, input.route?.channel_id)) });
      }
    }
    const id = uniqueId(this.db);
    const sealed = await this.sealContent(conn.user_id, id, {
      title: input.title, context: input.context, options: JSON.stringify(input.options), recommendation: input.recommendation ?? null,
      answer: null, delivery_text: null, cancel_reason: null, distinct_reason: input.distinct_reason ?? null,
    });
    return { id, sealed };
  }

  /** Inside the create's transaction. */
  private insert(conn: Connection, input: z.infer<typeof createSchema>, options: { test?: boolean; via?: "connector" | "remote" }, prepared: { id: string; sealed: Sealed }) {
    this.rateLimit(conn);
    const { id, sealed: s } = prepared;
    const at = now();
    run(this.db, `insert into decisions (id, user_id, connection_id, route, title, norm_title, context, options, recommendation, urgency, deadline,
        client, session_label, requester, requester_bot_id, via, test, status, resume_phrase, distinct_reason, created_at, updated_at, version, content_state, sealed_set)
        values (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1, 'sealed', ?)`,
      id, conn.user_id, conn.id, input.route ? JSON.stringify(input.route) : null, s.title, s.context,
      s.options, s.recommendation, input.urgency, input.deadline ?? null,
      input.client, input.session_label, input.requester ?? null, input.requester_bot_id ?? null, options.via ?? "connector", options.test ? 1 : 0, `Approval Box ${id} の答えを確認して続けて`, s.distinct_reason, at, at, conn.user_id);
    this.bindRequest(conn, id, input.request_attachment_ids ?? []);
    this.history(id, "created", "ai");
    this.events.publish(conn.user_id, "decision.created", { decision_id: id, version: 1 });
    return this.row(id)!;
  }

  /**
   * 申請の前の確かめ（クオの裁定 2026-10-01）。AIが申請を出すと、まず自分の申請の一覧を返し、
   * 直す・取り下げる申請が無いかをAIに確かめさせる。AIが問題ないとして check_token を付けて出し直した時だけ受け付ける。
   * 何を直すか・取り下げるかはAIが決める。サーバーは中身を判断しない。
   */
  private async requireCheck(conn: Connection, input: z.infer<typeof createSchema>) {
    if (input.check_token && this.checkUsable(conn, input.check_token)) return;
    const token = secret("chk");
    const at = new Date();
    run(this.db, "delete from request_checks where expires_at < ?", at.toISOString());
    run(this.db, "insert into request_checks (token_hash, connection_id, created_at, expires_at) values (?, ?, ?, ?)",
      hash(token), conn.id, at.toISOString(), new Date(at.getTime() + CHECK_TTL_MS).toISOString());
    const head = input.check_token ? "確認の札が古いか、もう使われています。もう一度確かめてください。\n" : "";
    // 名前を入れずに出すと、利用者のカードに誰の申請か出ない（ヘンゼル 2026-11-21）。名前を持たないAIは空のまま出し直せる。
    const nameless = input.requester ? "" : "申請者の名前（requester_name）が空です。このままでは利用者に誰からの申請か分かりません。Botや担当としての名前を持つなら、requester_name に入れて出し直してください。\n";
    const decisions = await this.listMine(conn, input.route?.channel_id);
    // 0.1.6までのコネクタは message だけをAIに見せる。一覧と札も message に入れ、古いコネクタのAIも出し直せるようにする。
    const list = decisions.length
      ? decisions.map((d) => `- ${d.decision_id}「${d.content_removed ? "（中身は削除済み）" : d.title}」 status=${d.status} version=${d.version}${d.has_answer ? " 答えあり" : ""}`).join("\n")
      : "（この端末から出した申請はありません）";
    throw new ApiError("confirm_required",
      `${head}${nameless}申請はまだ受け付けていません。下は同じ接続から出した申請の要約一覧です。直す申請があれば amend_decision、要らなくなった申請があれば cancel_decision を先に済ませてください。答えが出ている申請は get_decision で確認してください。問題が無ければ、同じ申請に check_token: "${token}" を付けて出し直してください。\n${list}`,
      { check_token: token, decisions });
  }

  private checkUsable(conn: Connection, token: string) {
    const row = get<{ connection_id: string; expires_at: string; used_at: string | null }>(this.db, "select connection_id, expires_at, used_at from request_checks where token_hash = ?", hash(token));
    return !!row && row.connection_id === conn.id && !row.used_at && row.expires_at > now();
  }

  private useCheck(conn: Connection, token: string) {
    if (!this.checkUsable(conn, token)) throw new ApiError("conflict", "確認の札がもう使われています。申請を出し直してください。");
    run(this.db, "update request_checks set used_at = ? where token_hash = ?", now(), hash(token));
  }

  async amend(conn: Connection, id: string, body: z.infer<typeof amendSchema>) {
    const amended = await this.change(() => this.forConnection(conn, id), async (row) => {
      this.assertOpen(row, "ai");
      if (row.version !== body.version) throw new ApiError("conflict", "申請の内容が変わっています。最新の version で直してください。", { decision: this.toAi(row) });
      if (row.amend_count >= AMEND_LIMIT) throw new ApiError("rate_limited", "この申請はもう直せません（20回まで）。取り下げて出し直してください。");
      const c = body.changes;
      const options = c.options ?? (JSON.parse(row.options) as Option[]);
      const recommendation = c.recommendation === undefined ? row.recommendation : c.recommendation;
      if (recommendation && !options.some((o) => o.id === recommendation)) throw new ApiError("validation_failed", "recommendation が選択肢のidにありません。");
      const set = row.sealed_set ?? row.user_id;
      const sealed = await this.sealContent(set, row.id, { ...this.content(row), title: c.title ?? row.title, context: c.context ?? row.context, options: JSON.stringify(options), recommendation: recommendation ?? null });
      return { set, sealed, note: await this.sealNote(set, row.id, body.note) };
    }, (row, p) => {
      const c = body.changes;
      if (c.request_attachment_ids !== undefined) this.bindRequest(conn, row.id, c.request_attachment_ids);
      const fields = AMEND_FIELDS.filter((f) => c[f] !== undefined);
      run(this.db, `update decisions set urgency = ?, deadline = ?, route = ?, amend_count = amend_count + 1, updated_at = ?, version = version + 1 where id = ?`,
        c.urgency ?? row.urgency, c.deadline === undefined ? row.deadline : c.deadline, body.route ? JSON.stringify(body.route) : row.route, now(), row.id);
      this.writeContent(row.id, p.set, p.sealed);
      this.history(row.id, "amended", "ai", p.note, [...fields, ...(body.route && JSON.stringify(body.route) !== row.route ? ["route"] : [])]);
      this.changed(this.row(row.id)!, "amended");
    });
    return this.toAi(amended);
  }

  async resume(conn: Connection, id: string, route: Route) {
    const resumed = await this.change(() => this.forConnection(conn, id), async (row) => {
      if (row.status === "answered") return null;
      this.assertOpen(row, "ai");
      return this.sealNote(row.sealed_set ?? row.user_id, row.id, "答えの配送先を再開した会話へ変更");
    }, (row, note) => {
      if (row.status === "answered") {
        this.markFetched(row);
        this.seenByAi(row.id);
        return;
      }
      run(this.db, "update decisions set route = ?, updated_at = ?, version = version + 1 where id = ?", JSON.stringify(route), now(), row.id);
      this.history(row.id, "amended", "ai", note, ["route"]);
      this.changed(this.row(row.id)!, "amended");
    });
    return this.toAi(resumed, route.channel_id);
  }

  async cancel(conn: Connection, id: string, reason: string) {
    const cancelled = await this.change(() => this.forConnection(conn, id), async (row) => {
      this.assertOpen(row, "ai");
      const set = row.sealed_set ?? row.user_id;
      return { set, sealed: await this.sealContent(set, row.id, { ...this.content(row), cancel_reason: reason }), note: await this.sealNote(set, row.id, reason) };
    }, (row, p) => {
      const at = now();
      // The AI cancelled it itself: it has the decided state.
      run(this.db, "update decisions set status = 'cancelled', decided_at = ?, purge_by = ?, ai_seen_at = ?, updated_at = ?, version = version + 1 where id = ?", at, capFrom(at), at, at, row.id);
      this.writeContent(row.id, p.set, p.sealed);
      run(this.db, "delete from attachments where decision_id = ? and position is null", row.id);
      this.history(row.id, "cancelled", "ai", p.note);
      if (row.test) run(this.db, "update setup_checks set status = 'untested', decision_id = null where decision_id = ?", row.id);
      this.changed(this.row(row.id)!, "cancelled");
    });
    return this.toAi(cancelled);
  }

  /** The server ends an open request (no contract, expiry). The AI learns it when it next reads the request. */
  private async cancelByServer(load: () => Stored, reason: string, at = now()) {
    await this.change(load, async (row) => {
      if (!OPEN.includes(row.status)) return null;
      const set = row.sealed_set ?? row.user_id;
      return { set, sealed: await this.sealContent(set, row.id, { ...this.content(row), cancel_reason: reason }), note: await this.sealNote(set, row.id, reason) };
    }, (row, p) => {
      if (!p || !OPEN.includes(row.status)) return;
      run(this.db, "update decisions set status = 'cancelled', decided_at = ?, purge_by = ?, updated_at = ?, version = version + 1 where id = ?", at, capFrom(at), at, row.id);
      this.writeContent(row.id, p.set, p.sealed);
      run(this.db, "delete from attachments where decision_id = ? and position is null", row.id);
      this.history(row.id, "cancelled", "ai", p.note);
      if (row.test) run(this.db, "update setup_checks set status = 'untested', decision_id = null where decision_id = ?", row.id);
      this.changed(this.row(row.id)!, "cancelled");
    });
  }

  /** 契約が無くなったアカウントの、待っている申請（セットアップ確認以外）を取り下げる。共有ライブラリの onNone から呼ぶ。失敗は記録だけ（次の onNone か期限で終わる）。 */
  endForNoContract(userId: string): Promise<void> {
    return (async () => {
      for (const { id } of all<{ id: string }>(this.db, "select id from decisions where user_id = ? and test = 0 and status in ('pending', 'held')", userId)) {
        await this.cancelByServer(() => this.forUser(userId, id), "subscription_expired");
      }
    })().catch((error: unknown) => console.error(`approval-box-server: end_for_no_contract_failed ${error instanceof ApiError ? error.code : "error"}`));
  }

  async aiView(conn: Connection, id: string, routeChannel?: string) {
    return this.toAi(await this.open(this.forConnection(conn, id)), routeChannel);
  }

  /** The AI reads one request (GET, get_decision). Reading a decided request counts as the AI having the result. */
  async aiRead(conn: Connection, id: string, routeChannel?: string) {
    const row = this.forConnection(conn, id);
    if (!OPEN.includes(row.status)) this.seenByAi(row.id);
    return this.aiView(conn, id, routeChannel);
  }

  /** リモートMCPのAIが答えを取った。 */
  markFetched(row: Stored) {
    if (row.status !== "answered" || row.delivery === "fetched") return;
    run(this.db, "update decisions set delivery = 'fetched', ai_seen_at = coalesce(ai_seen_at, ?), updated_at = ?, version = version + 1 where id = ?", now(), now(), row.id);
    this.changed(this.row(row.id)!, "delivery");
  }

  // ---- 配送（コネクタのデーモン）----

  async pendingDeliveries(conn: Connection) {
    const rows = all<Stored>(this.db, "select * from decisions where connection_id = ? and status = 'answered' and delivery = 'waiting' and route is not null order by updated_at", conn.id)
      // サーバーが自分で届ける道（call-bridge）は、コネクタのデーモンへ渡さない。
      .filter((row) => (JSON.parse(row.route!) as Route).harness !== SERVER_HARNESS);
    return Promise.all(rows.map(async (stored) => {
      const row = await this.open(stored);
      // 0.1.9からのコネクタは、配送の前に添付を端末へ保存し、その場所を文に書き足す。
      const attachments = (JSON.parse(row.answer!) as Answer).attachments;
      return { decision_id: row.id, delivery_id: row.delivery_id!, route: JSON.parse(row.route!) as Route, text: row.delivery_text!, ...(attachments?.length ? { attachments } : {}) };
    }));
  }

  /** サーバーが自分で届ける配送待ち（route.harness = callbridge）。送り始めた印（sending）が付いたものは含めない。 */
  async serverDeliveries(connectionId: string) {
    const rows = all<Stored>(this.db, "select * from decisions where connection_id = ? and status = 'answered' and delivery = 'waiting' and route is not null and (delivery_detail is null or (delivery_detail like 'retry_at:%' and substr(delivery_detail, 10) <= ?)) order by updated_at", connectionId, now())
      .filter((row) => (JSON.parse(row.route!) as Route).harness === SERVER_HARNESS);
    return Promise.all(rows.map(async (row) => ({
      decision_id: row.id, route: JSON.parse(row.route!) as Route,
      text: (await this.vault.open(row.sealed_set ?? row.user_id, `${row.id}|delivery_text`, row.delivery_text)) ?? "",
    })));
  }

  /** 送り始めた印。送信の途中でサーバーが止まったら、届いたか分からないので送り直さない。 */
  markSending(id: string) {
    return run(this.db, "update decisions set delivery_detail = 'sending' where id = ? and delivery = 'waiting'", id).changes > 0;
  }

  /** 通話未開設が確定した一時失敗だけを永続待機へ戻す。取得済みの回答には触れない。期限は答えた時刻（decided_at）から。 */
  deferServerDelivery(id: string, seconds: 30) {
    const row = this.row(id);
    const retryAt = Date.now() + seconds * 1000;
    const answeredAt = row?.decided_at ?? row?.updated_at;
    if (!row?.answer || !answeredAt || retryAt > Date.parse(answeredAt) + 10 * 60_000) return false;
    const at = new Date(retryAt).toISOString();
    return run(this.db, "update decisions set delivery_detail = ? where id = ? and status = 'answered' and delivery = 'waiting' and delivery_detail = 'sending'", `retry_at:${at}`, id).changes > 0;
  }

  /** 前回の送信の途中で止まった配送。 */
  interruptedServerDeliveries(connectionId: string) {
    return all<{ id: string }>(this.db, "select id from decisions where connection_id = ? and status = 'answered' and delivery = 'waiting' and delivery_detail = 'sending'", connectionId).map((r) => r.id);
  }

  reportDelivery(conn: Connection, id: string, state: "delivered" | "unknown" | "failed", detail?: string) {
    return tx(this.db, () => {
      const row = this.forConnection(conn, id);
      if (row.status !== "answered" || row.delivery !== "waiting") return { decision_id: id, delivery: row.delivery };
      // 届いたか確かめられない配送と、届けられなかった配送は、どちらも利用者には「届いたか不明」として見せる。
      const delivery = state === "delivered" ? "delivered" : "unknown";
      run(this.db, "update decisions set delivery = ?, delivery_detail = ?, updated_at = ?, version = version + 1 where id = ?", delivery, detail ?? null, now(), row.id);
      if (delivery === "delivered") this.seenByAi(row.id);
      if (row.test && delivery !== "delivered") {
        run(this.db, "update setup_checks set status = 'failed', failed_step = 'delivery', detail = ? where decision_id = ?", detail ?? state, row.id);
        this.events.publish(row.user_id, "setup.updated", {});
      }
      this.changed(this.row(row.id)!, "delivery");
      return { decision_id: id, delivery };
    });
  }

  // ---- セットアップ確認 ----

  async startSetupTest(conn: Connection, client: string, os: string | undefined, route: Route | undefined, sessionLabel: string) {
    this.vault.assertReady();
    const replaced = "新しいテストに置き換えた";
    const previous = get<{ decision_id: string | null }>(this.db, "select decision_id from setup_checks where connection_id = ? and client = ?", conn.id, client);
    const old = previous?.decision_id ? this.row(previous.decision_id) : undefined;
    // The test it replaces is cancelled in the same transaction; its content is resealed with the reason first.
    const ending = old && OPEN.includes(old.status) ? await (async () => {
      const row = await this.open(old);
      const set = old.sealed_set ?? old.user_id;
      return { id: old.id, version: old.version, set, sealed: await this.sealContent(set, old.id, { ...this.content(row), cancel_reason: replaced }), note: await this.sealNote(set, old.id, replaced) };
    })() : undefined;
    const input = {
      title: "Approval Boxの接続テスト",
      context: "Approval Boxのセットアップ確認です。どちらを選んでもかまいません。答えがAIまで届けば、このAIは確認済みになります。",
      options: [{ id: "ok", label: "届いた（テスト）" }, { id: "again", label: "もう一度（テスト）" }],
      urgency: "normal", session_label: sessionLabel, client, ...(route ? { route } : {}),
    } as z.infer<typeof createSchema>;
    const prepared = await this.prepareCreate(conn, input, { test: true });
    const row = tx(this.db, () => {
      const current = ending ? this.row(ending.id) : undefined;
      if (ending && current && current.version === ending.version) {
        const at = now();
        run(this.db, "update decisions set status = 'cancelled', decided_at = ?, purge_by = ?, updated_at = ?, version = version + 1 where id = ?", at, capFrom(at), at, ending.id);
        this.writeContent(ending.id, ending.set, ending.sealed);
        run(this.db, "delete from attachments where decision_id = ? and position is null", ending.id);
        this.history(ending.id, "cancelled", "ai", ending.note);
        this.changed(this.row(ending.id)!, "cancelled");
      }
      const row = this.insert(conn, input, { test: true }, prepared);
      const at = now();
      run(this.db, `insert into setup_checks (id, user_id, connection_id, client, os, status, decision_id, code, tested_at)
          values (?, ?, ?, ?, ?, 'waiting_answer', ?, ?, ?)
          on conflict (connection_id, client) do update set os = excluded.os, status = 'waiting_answer', decision_id = excluded.decision_id,
          code = excluded.code, tested_at = excluded.tested_at, failed_step = null, detail = null`,
        uuid(), conn.user_id, conn.id, client, os ?? null, row.id, testCode(), at);
      this.events.publish(conn.user_id, "setup.updated", {});
      return row;
    });
    return this.toAi(await this.open(row), route?.channel_id);
  }

  /**
   * peer-channel の道（c8c、契約 Q8）: 接続テストはAIの端末で答えと確認コードを確かめる。サーバーへ届くのは「このAIの確認が済んだ」の印だけで、
   * 申請・答え・コードは来ない。印は接続トークンの持ち主（コネクタ）の自己申告で、今の購入の前の確認（setup.verified）にだけ使う。
   */
  setupVerified(conn: Connection, client: string, os: string | undefined) {
    return tx(this.db, () => {
      const at = now();
      run(this.db, `insert into setup_checks (id, user_id, connection_id, client, os, status, decision_id, code, tested_at, passed_at)
          values (?, ?, ?, ?, ?, 'passed', null, null, ?, ?)
          on conflict (connection_id, client) do update set os = coalesce(excluded.os, os), status = 'passed', decision_id = null, code = null,
          tested_at = excluded.tested_at, passed_at = excluded.passed_at, failed_step = null, detail = null`,
        uuid(), conn.user_id, conn.id, client, os ?? null, at, at);
      run(this.db, "update users set setup_verified_at = coalesce(setup_verified_at, ?) where id = ?", at, conn.user_id);
      this.events.publish(conn.user_id, "setup.updated", {});
      return { status: "passed", client };
    });
  }

  confirmSetupTest(conn: Connection, id: string, code: string) {
    return tx(this.db, () => {
      const row = this.forConnection(conn, id);
      const check = get<{ id: string; code: string; status: string }>(this.db, "select id, code, status from setup_checks where decision_id = ?", row.id);
      if (!check) throw new ApiError("not_found", "この申請は接続テストではありません。");
      if (check.code !== code.trim()) throw new ApiError("validation_failed", "確認コードが違います。届いた答えに書かれたコードをそのまま渡してください。");
      const at = now();
      run(this.db, "update setup_checks set status = 'passed', passed_at = ?, failed_step = null, detail = null where id = ?", at, check.id);
      // 確認コードはAIへ配送した本文の中にしか無い。これが返ってきたなら、答えはAIまで届いている。
      if (row.delivery !== "delivered" && row.delivery !== "fetched") {
        run(this.db, "update decisions set delivery = 'delivered', updated_at = ?, version = version + 1 where id = ?", at, row.id);
        this.changed(this.row(row.id)!, "delivery");
      }
      this.seenByAi(row.id);
      run(this.db, "update users set setup_verified_at = coalesce(setup_verified_at, ?) where id = ?", at, conn.user_id);
      this.events.publish(conn.user_id, "setup.updated", {});
      return { status: "passed", client: get<{ client: string }>(this.db, "select client from setup_checks where id = ?", check.id)!.client };
    });
  }
}

/** The 7-day cap from the moment a request was decided. */
const capFrom = (at: string) => new Date(Date.parse(at) + PURGE_CAP_MS).toISOString();
type Sealed = Record<(typeof CONTENT)[number], Uint8Array | null>;

/** The title and labels a notification shows (push.ts), opened in memory; undefined for a tombstone or an unknown id. */
export async function headline(db: Db, id: string) {
  const row = get<Pick<Stored, "user_id" | "title" | "session_label" | "requester" | "via" | "route" | "content_state" | "sealed_set">>(db,
    "select user_id, title, session_label, requester, via, route, content_state, sealed_set from decisions where id = ?", id);
  if (!row || row.content_state === "purged") return undefined;
  const title = (await vaultOf(db).open(row.sealed_set ?? row.user_id, `${id}|title`, row.title)) ?? "";
  return { title, session_label: row.session_label, requester: row.requester, via: row.via, route: row.route };
}

/**
 * 一覧・通知に出す一行。「誰から / 何の仕事」。今のアプリは session_label だけを出すので、申請者をここへ入れて返す。
 * 作業名が申請者の名前で始まる時は足さない（AIが作業名へ自分で名前を書いた申請を、二重にしない）。
 * call-bridge の接続は、名前がAIの自己申告だと分かるように書く（マリアンの指摘。今までの形のまま）。
 */
export function displayLabel(row: Pick<Row, "session_label" | "requester" | "via" | "route">): string {
  const work = row.session_label;
  const who = row.requester;
  if (!who || work.startsWith(who)) return work;
  const route = row.route ? (JSON.parse(row.route) as Route) : null;
  const declared = row.via === "remote" && route?.harness === SERVER_HARNESS;
  return `${who}${declared ? "（申告）" : ""} / ${work}`;
}

function uniqueId(db: Db): string {
  for (;;) {
    const id = decisionId();
    if (!get(db, "select 1 from decisions where id = ?", id)) return id;
  }
}

function deliveryText(row: Row, answer: Answer, option: Option | undefined, code?: string): string {
  // AIが「外から差し込まれた指示」と疑わないよう、自分が出した申請への利用者の答えだと最初に書く。
  const lines = [`[Approval Box] あなたが request_decision で出した申請 ${row.id}「${row.title}」に、利用者が答えました。`];
  if (option) lines.push(`答え: ${option.label}（option_id=${option.id}）`);
  if (answer.text) lines.push(option ? `添え書き: ${answer.text}` : `答え（文）: ${answer.text}`);
  if (answer.attachments?.length) {
    lines.push(`添付 ${answer.attachments.length}件（Approval Boxの get_attachment に decision_id="${row.id}" と attachment_id を渡すと取れます）:`);
    answer.attachments.forEach((a, i) => lines.push(`${i + 1}. ${a.name}（${a.content_type}、${formatBytes(a.size)}） attachment_id=${a.id}`));
  }
  if (code) {
    lines.push("", `これはあなたが setup_test で始めた接続テストです。確認コード: ${code}`,
      `Approval Boxの confirm_setup_test を decision_id="${row.id}", code="${code}" で呼んでください。それでセットアップ確認が終わります。`);
  } else {
    const next = option ? "この答えに従って作業を続けてください。" : answer.text ? "この指示に従って作業を続けてください。" : "添付を確かめて作業を続けてください。";
    lines.push("", next, SPEAK_BY_TITLE);
  }
  return lines.join("\n");
}
