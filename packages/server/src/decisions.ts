import { z } from "zod";
import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { decisionId, hash, normalizeTitle, now, secret, testCode, uuid } from "./ids.ts";

export const URGENCIES = ["low", "normal", "high"] as const;
export const AMEND_FIELDS = ["title", "context", "options", "recommendation", "urgency", "deadline"] as const;
const OPEN = ["pending", "held"];
const CREATE_LIMIT_PER_HOUR = 60;
const AMEND_LIMIT = 20;

export type Option = { id: string; label: string };
export type Route = { channel_id: string; harness: string };
export type Answer = { option_id?: string; text?: string; answered_at: string };

type Row = {
  id: string; user_id: string; connection_id: string | null; route: string | null;
  title: string; context: string; options: string; recommendation: string | null;
  urgency: string; deadline: string | null; client: string; session_label: string; via: string; test: number;
  status: string; answer: string | null; delivery: string | null; delivery_id: string | null; delivery_detail: string | null; delivery_text: string | null;
  resume_phrase: string; cancel_reason: string | null; distinct_reason: string | null; amend_count: number;
  created_at: string; updated_at: string; version: number;
};
type HistoryRow = { decision_id: string; at: string; kind: string; by: string; note: string | null; fields: string | null };

export type Connection = { id: string; user_id: string; label: string; os: string | null };

export const optionSchema = z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200) });
const optionsSchema = z.array(optionSchema).min(2).max(6).refine((options) => new Set(options.map((o) => o.id)).size === options.length, "選択肢のidが重なっています");

export const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  context: z.string().max(20000).default(""),
  options: optionsSchema,
  recommendation: z.string().optional(),
  urgency: z.enum(URGENCIES).default("normal"),
  deadline: z.iso.datetime({ offset: true }).optional(),
  session_label: z.string().trim().min(1).max(200),
  client: z.string().trim().min(1).max(40),
  route: z.object({ channel_id: z.string().min(1).max(100), harness: z.string().min(1).max(20) }).optional(),
  distinct_reason: z.string().trim().min(1).max(500).optional(),
  check_token: z.string().max(200).optional(),
});

export const amendSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().min(1).max(500),
  changes: z.object({
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
  version: z.number().int().positive(),
}).refine((body) => body.option_id || body.text, "選択肢か文のどちらかが必要です");

const CHECK_TTL_MS = 30 * 60_000;

const urgencyRank: Record<string, number> = { high: 0, normal: 1, low: 2 };

export class Decisions {
  private readonly db: Db;
  private readonly events: EventHub;

  constructor(db: Db, events: EventHub) {
    this.db = db;
    this.events = events;
  }

  // ---- 表示 ----

  toApi(row: Row, historyRows?: HistoryRow[]) {
    const history = (historyRows ?? all<HistoryRow>(this.db, "select * from history where decision_id = ? order by id", row.id)).map((h) => ({
      at: h.at, kind: h.kind, by: h.by,
      ...(h.note ? { note: h.note } : {}),
      ...(h.fields ? { fields: JSON.parse(h.fields) as string[] } : {}),
    }));
    return {
      id: row.id,
      title: row.title,
      context: row.context,
      options: JSON.parse(row.options) as Option[],
      ...(row.recommendation ? { recommendation: row.recommendation } : {}),
      urgency: row.urgency,
      ...(row.deadline ? { deadline: row.deadline } : {}),
      source: { client: row.client, session_label: row.session_label, via: row.via, ...(row.test ? { test: true } : {}) },
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

  /** コネクタ（AI側）へ返す形。答えがあれば、AIへ渡す文も付ける。 */
  toAi(row: Row, routeChannel?: string) {
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
      session_label: row.session_label,
      this_session: !!routeChannel && route?.channel_id === routeChannel,
      ...(row.answer ? { answer: JSON.parse(row.answer) as Answer, answer_text: row.delivery_text } : {}),
      ...(row.delivery ? { delivery: row.delivery } : {}),
      ...(row.cancel_reason ? { cancel_reason: row.cancel_reason } : {}),
      ...(row.test ? { test: true } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private row(id: string): Row | undefined {
    return get<Row>(this.db, "select * from decisions where id = ?", id);
  }

  private history(id: string, kind: string, by: "ai" | "user", note?: string | null, fields?: string[]) {
    run(this.db, "insert into history (decision_id, at, kind, by, note, fields) values (?, ?, ?, ?, ?, ?)",
      id, now(), kind, by, note ?? null, fields ? JSON.stringify(fields) : null);
  }

  private changed(row: Row, change?: string) {
    this.events.publish(row.user_id, "decision.updated", { decision_id: row.id, version: row.version, ...(change ? { change } : {}) });
  }

  // ---- 利用者（アプリ・Web版）----

  forUser(userId: string, id: string): Row {
    const row = this.row(id);
    if (!row || row.user_id !== userId) throw new ApiError("not_found", "その申請は見つかりません。");
    return row;
  }

  list(userId: string, statuses: string[], limit: number, cursor: number) {
    const marks = statuses.map(() => "?").join(",");
    const rows = all<Row>(this.db, `select * from decisions where user_id = ? and status in (${marks})`, userId, ...statuses);
    const openOnly = statuses.every((s) => OPEN.includes(s));
    rows.sort(openOnly
      ? (a, b) => (urgencyRank[a.urgency]! - urgencyRank[b.urgency]!)
        || ((a.deadline ?? "9999") < (b.deadline ?? "9999") ? -1 : (a.deadline ?? "9999") > (b.deadline ?? "9999") ? 1 : 0)
        || (a.created_at < b.created_at ? -1 : 1)
      : (a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const page = rows.slice(cursor, cursor + limit);
    const next = cursor + limit < rows.length ? String(cursor + limit) : undefined;
    return { items: page.map((row) => this.toApi(row)), ...(next ? { next_cursor: next } : {}) };
  }

  answer(userId: string, id: string, body: z.infer<typeof answerSchema>) {
    return tx(this.db, () => {
      const row = this.forUser(userId, id);
      this.assertOpen(row, "user");
      if (row.version !== body.version) throw new ApiError("conflict", "AIが内容を直したか、別の画面で答えが出ています。最新の内容を確かめてください。", { decision: this.toApi(row) });
      const options = JSON.parse(row.options) as Option[];
      const option = body.option_id ? options.find((o) => o.id === body.option_id) : undefined;
      if (body.option_id && !option) throw new ApiError("validation_failed", "その選択肢はありません。");
      const answer: Answer = { ...(option ? { option_id: option.id } : {}), ...(body.text ? { text: body.text } : {}), answered_at: now() };
      const check = row.test ? get<{ code: string }>(this.db, "select code from setup_checks where decision_id = ?", row.id) : undefined;
      const text = deliveryText(row, answer, option, check?.code);
      run(this.db, "update decisions set status = 'answered', answer = ?, delivery = 'waiting', delivery_id = ?, delivery_text = ?, delivery_detail = null, updated_at = ?, version = version + 1 where id = ?",
        JSON.stringify(answer), uuid(), text, now(), row.id);
      this.history(row.id, "answered", "user");
      if (row.test) run(this.db, "update setup_checks set status = 'waiting_ai' where decision_id = ?", row.id);
      const updated = this.row(row.id)!;
      this.changed(updated, "answered");
      if (row.test) this.events.publish(userId, "setup.updated", {});
      if (updated.connection_id) this.events.notifyConnection(updated.connection_id);
      return this.toApi(updated);
    });
  }

  setHold(userId: string, id: string, hold: boolean) {
    return tx(this.db, () => {
      const row = this.forUser(userId, id);
      this.assertOpen(row, "user");
      const status = hold ? "held" : "pending";
      if (row.status === status) return this.toApi(row);
      run(this.db, "update decisions set status = ?, updated_at = ?, version = version + 1 where id = ?", status, now(), row.id);
      this.history(row.id, hold ? "held" : "unheld", "user");
      const updated = this.row(row.id)!;
      this.changed(updated);
      return this.toApi(updated);
    });
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

  private assertOpen(row: Row, by: "ai" | "user") {
    if (OPEN.includes(row.status)) return;
    const message = row.status === "answered"
      ? (by === "ai" ? "利用者がすでに答えています。answer_text の答えに従ってください。" : "この申請にはすでに答えが出ています。")
      : (by === "ai" ? "この申請はすでに取り下げられています。" : "この申請はAIが取り下げました。");
    throw new ApiError("conflict", message, { decision: by === "ai" ? this.toAi(row) : this.toApi(row) });
  }

  // ---- AI（コネクタ）----

  forConnection(conn: Connection, id: string): Row {
    const row = this.row(id);
    // 他の接続が出した申請は、見ることも直すこともできない。
    if (!row || row.connection_id !== conn.id) throw new ApiError("not_found", "その申請は見つかりません。この接続から出した申請だけを扱えます。");
    return row;
  }

  listMine(conn: Connection, routeChannel?: string) {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const rows = all<Row>(this.db,
      "select * from decisions where connection_id = ? and (status in ('pending','held') or updated_at >= ?) order by created_at desc",
      conn.id, since);
    return rows.map((row) => this.toAi(row, routeChannel));
  }

  create(conn: Connection, input: z.infer<typeof createSchema>, options: { test?: boolean } = {}) {
    if (!options.test) this.requireCheck(conn, input);
    return tx(this.db, () => {
      if (!options.test) this.useCheck(conn, input.check_token!);
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const recent = get<{ n: number }>(this.db, "select count(*) n from decisions where user_id = ? and created_at >= ?", conn.user_id, hourAgo)!.n;
      if (recent >= CREATE_LIMIT_PER_HOUR) throw new ApiError("rate_limited", "1時間に出せる申請の数を超えました。少し待ってください。", {}, 600);
      if (input.recommendation && !input.options.some((o) => o.id === input.recommendation)) throw new ApiError("validation_failed", "recommendation が選択肢のidにありません。");
      const norm = normalizeTitle(input.title);
      if (!options.test && !input.distinct_reason) {
        const existing = all<Row>(this.db, "select * from decisions where connection_id = ? and status in ('pending','held') and norm_title = ?", conn.id, norm);
        if (existing.length) {
          throw new ApiError("duplicate_suspected",
            "同じ件名の申請がまだ答えを待っています。新しく出さず、amend_decision で直すか、cancel_decision で取り下げてください。別件なら distinct_reason を付けて出し直せます。",
            { existing: existing.map((row) => this.toAi(row, input.route?.channel_id)) });
        }
      }
      const id = uniqueId(this.db);
      const at = now();
      run(this.db, `insert into decisions (id, user_id, connection_id, route, title, norm_title, context, options, recommendation, urgency, deadline,
          client, session_label, via, test, status, resume_phrase, distinct_reason, created_at, updated_at, version)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connector', ?, 'pending', ?, ?, ?, ?, 1)`,
        id, conn.user_id, conn.id, input.route ? JSON.stringify(input.route) : null, input.title, norm, input.context,
        JSON.stringify(input.options), input.recommendation ?? null, input.urgency, input.deadline ?? null,
        input.client, input.session_label, options.test ? 1 : 0, `Approval Box ${id} の答えを確認して続けて`, input.distinct_reason ?? null, at, at);
      this.history(id, "created", "ai");
      const row = this.row(id)!;
      this.events.publish(conn.user_id, "decision.created", { decision_id: id, version: 1 });
      return row;
    });
  }

  /**
   * 申請の前の確かめ（クオの裁定 2026-10-01）。AIが申請を出すと、まず自分の申請の一覧を返し、
   * 直す・取り下げる申請が無いかをAIに確かめさせる。AIが問題ないとして check_token を付けて出し直した時だけ受け付ける。
   * 何を直すか・取り下げるかはAIが決める。サーバーは中身を判断しない。
   */
  private requireCheck(conn: Connection, input: z.infer<typeof createSchema>) {
    if (input.check_token && this.checkUsable(conn, input.check_token)) return;
    const token = secret("chk");
    const at = new Date();
    run(this.db, "delete from request_checks where expires_at < ?", at.toISOString());
    run(this.db, "insert into request_checks (token_hash, connection_id, created_at, expires_at) values (?, ?, ?, ?)",
      hash(token), conn.id, at.toISOString(), new Date(at.getTime() + CHECK_TTL_MS).toISOString());
    const head = input.check_token ? "確認の札が古いか、もう使われています。もう一度確かめてください。\n" : "";
    throw new ApiError("confirm_required",
      `${head}申請はまだ受け付けていません。下はこの端末から出した申請の一覧です。直す申請があれば amend_decision、要らなくなった申請があれば cancel_decision を先に済ませてください。答えが出ている申請は、その答えに従ってください。問題が無ければ、同じ申請に check_token を付けて出し直してください。`,
      { check_token: token, decisions: this.listMine(conn, input.route?.channel_id) });
  }

  private checkUsable(conn: Connection, token: string) {
    const row = get<{ connection_id: string; expires_at: string; used_at: string | null }>(this.db, "select connection_id, expires_at, used_at from request_checks where token_hash = ?", hash(token));
    return !!row && row.connection_id === conn.id && !row.used_at && row.expires_at > now();
  }

  private useCheck(conn: Connection, token: string) {
    if (!this.checkUsable(conn, token)) throw new ApiError("conflict", "確認の札がもう使われています。申請を出し直してください。");
    run(this.db, "update request_checks set used_at = ? where token_hash = ?", now(), hash(token));
  }

  amend(conn: Connection, id: string, body: z.infer<typeof amendSchema>) {
    return tx(this.db, () => {
      const row = this.forConnection(conn, id);
      this.assertOpen(row, "ai");
      if (row.version !== body.version) throw new ApiError("conflict", "申請の内容が変わっています。最新の version で直してください。", { decision: this.toAi(row) });
      if (row.amend_count >= AMEND_LIMIT) throw new ApiError("rate_limited", "この申請はもう直せません（20回まで）。取り下げて出し直してください。");
      const c = body.changes;
      const options = c.options ?? (JSON.parse(row.options) as Option[]);
      const recommendation = c.recommendation === undefined ? row.recommendation : c.recommendation;
      if (recommendation && !options.some((o) => o.id === recommendation)) throw new ApiError("validation_failed", "recommendation が選択肢のidにありません。");
      const fields = AMEND_FIELDS.filter((f) => c[f] !== undefined);
      run(this.db, `update decisions set title = ?, norm_title = ?, context = ?, options = ?, recommendation = ?, urgency = ?, deadline = ?,
          amend_count = amend_count + 1, updated_at = ?, version = version + 1 where id = ?`,
        c.title ?? row.title, normalizeTitle(c.title ?? row.title), c.context ?? row.context, JSON.stringify(options), recommendation ?? null,
        c.urgency ?? row.urgency, c.deadline === undefined ? row.deadline : c.deadline, now(), row.id);
      this.history(row.id, "amended", "ai", body.note, [...fields]);
      const updated = this.row(row.id)!;
      this.changed(updated, "amended");
      return this.toAi(updated);
    });
  }

  cancel(conn: Connection, id: string, reason: string) {
    return tx(this.db, () => {
      const row = this.forConnection(conn, id);
      this.assertOpen(row, "ai");
      run(this.db, "update decisions set status = 'cancelled', cancel_reason = ?, updated_at = ?, version = version + 1 where id = ?", reason, now(), row.id);
      this.history(row.id, "cancelled", "ai", reason);
      if (row.test) run(this.db, "update setup_checks set status = 'untested', decision_id = null where decision_id = ?", row.id);
      const updated = this.row(row.id)!;
      this.changed(updated, "cancelled");
      return this.toAi(updated);
    });
  }

  aiView(conn: Connection, id: string, routeChannel?: string) {
    return this.toAi(this.forConnection(conn, id), routeChannel);
  }

  /** リモートMCPのAIが答えを取った。 */
  markFetched(row: Row) {
    if (row.status !== "answered" || row.delivery === "fetched") return;
    run(this.db, "update decisions set delivery = 'fetched', updated_at = ?, version = version + 1 where id = ?", now(), row.id);
    this.changed(this.row(row.id)!, "delivery");
  }

  // ---- 配送（コネクタのデーモン）----

  pendingDeliveries(conn: Connection) {
    return all<Row>(this.db, "select * from decisions where connection_id = ? and status = 'answered' and delivery = 'waiting' and route is not null order by updated_at", conn.id)
      .map((row) => ({ decision_id: row.id, delivery_id: row.delivery_id!, route: JSON.parse(row.route!) as Route, text: row.delivery_text! }));
  }

  reportDelivery(conn: Connection, id: string, state: "delivered" | "unknown" | "failed", detail?: string) {
    return tx(this.db, () => {
      const row = this.forConnection(conn, id);
      if (row.status !== "answered" || row.delivery !== "waiting") return { decision_id: id, delivery: row.delivery };
      // 届いたか確かめられない配送と、届けられなかった配送は、どちらも利用者には「届いたか不明」として見せる。
      const delivery = state === "delivered" ? "delivered" : "unknown";
      run(this.db, "update decisions set delivery = ?, delivery_detail = ?, updated_at = ?, version = version + 1 where id = ?", delivery, detail ?? null, now(), row.id);
      if (row.test && delivery !== "delivered") {
        run(this.db, "update setup_checks set status = 'failed', failed_step = 'delivery', detail = ? where decision_id = ?", detail ?? state, row.id);
        this.events.publish(row.user_id, "setup.updated", {});
      }
      this.changed(this.row(row.id)!, "delivery");
      return { decision_id: id, delivery };
    });
  }

  // ---- セットアップ確認 ----

  startSetupTest(conn: Connection, client: string, os: string | undefined, route: Route | undefined, sessionLabel: string) {
    return tx(this.db, () => {
      const previous = get<{ decision_id: string | null }>(this.db, "select decision_id from setup_checks where connection_id = ? and client = ?", conn.id, client);
      if (previous?.decision_id) {
        const old = this.row(previous.decision_id);
        if (old && OPEN.includes(old.status)) {
          run(this.db, "update decisions set status = 'cancelled', cancel_reason = ?, updated_at = ?, version = version + 1 where id = ?", "新しいテストに置き換えた", now(), old.id);
          this.history(old.id, "cancelled", "ai", "新しいテストに置き換えた");
          this.changed(this.row(old.id)!, "cancelled");
        }
      }
      const row = this.create(conn, {
        title: "Approval Boxの接続テスト",
        context: "Approval Boxのセットアップ確認です。どちらを選んでもかまいません。答えがAIまで届けば、このAIは確認済みになります。",
        options: [{ id: "ok", label: "届いた（テスト）" }, { id: "again", label: "もう一度（テスト）" }],
        urgency: "normal", session_label: sessionLabel, client, ...(route ? { route } : {}),
      }, { test: true });
      const at = now();
      run(this.db, `insert into setup_checks (id, user_id, connection_id, client, os, status, decision_id, code, tested_at)
          values (?, ?, ?, ?, ?, 'waiting_answer', ?, ?, ?)
          on conflict (connection_id, client) do update set os = excluded.os, status = 'waiting_answer', decision_id = excluded.decision_id,
          code = excluded.code, tested_at = excluded.tested_at, failed_step = null, detail = null`,
        uuid(), conn.user_id, conn.id, client, os ?? null, row.id, testCode(), at);
      this.events.publish(conn.user_id, "setup.updated", {});
      return this.toAi(row, route?.channel_id);
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
      run(this.db, "update users set setup_verified_at = coalesce(setup_verified_at, ?) where id = ?", at, conn.user_id);
      this.events.publish(conn.user_id, "setup.updated", {});
      return { status: "passed", client: get<{ client: string }>(this.db, "select client from setup_checks where id = ?", check.id)!.client };
    });
  }
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
  if (code) {
    lines.push("", `これはあなたが setup_test で始めた接続テストです。確認コード: ${code}`,
      `Approval Boxの confirm_setup_test を decision_id="${row.id}", code="${code}" で呼んでください。それでセットアップ確認が終わります。`);
  } else {
    lines.push("", option || !answer.text ? "この答えに従って作業を続けてください。" : "この指示に従って作業を続けてください。");
  }
  return lines.join("\n");
}
