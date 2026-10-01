import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { Accounts } from "./accounts.ts";
import { type Db, get, run } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub, UserEvent } from "./events.ts";
import { Decisions, amendSchema, answerSchema, createSchema } from "./decisions.ts";
import { now } from "./ids.ts";

export type Services = { db: Db; accounts: Accounts; decisions: Decisions; events: EventHub; publicUrl: string };

const STATUSES = ["pending", "held", "answered", "cancelled"] as const;
const HEARTBEAT_MS = 25_000;

function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try { raw = JSON.parse(text); } catch { throw new ApiError("validation_failed", "本文がJSONではありません。"); }
  }
  return schema.parse(raw);
}

/** 書き込みの冪等キー。同じキーの送り直しには、初回の応答をそのまま返す。 */
async function idempotent(c: Context, services: Services, userId: string, fn: () => unknown | Promise<unknown>) {
  const key = c.req.header("idempotency-key");
  const route = `${c.req.method} ${c.req.path}`;
  if (key) {
    const saved = get<{ route: string; status: number; body: string }>(services.db, "select route, status, body from idempotency where user_id = ? and key = ?", userId, key);
    if (saved) {
      if (saved.route !== route) throw new ApiError("validation_failed", "同じIdempotency-Keyが別の操作に使われています。");
      return c.body(saved.body, saved.status as 200, { "content-type": "application/json" });
    }
  }
  let status = 200;
  let payload: unknown;
  try {
    payload = await fn();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500 || error.code === "rate_limited") throw error;
    status = error.status;
    payload = error.body();
  }
  const text = JSON.stringify(payload);
  if (key) run(services.db, "insert or replace into idempotency (user_id, key, route, status, body, created_at) values (?, ?, ?, ?, ?, ?)", userId, key, route, status, text, now());
  return c.body(text, status as 200, { "content-type": "application/json" });
}

export function createApp(services: Services, options: { staticHandler?: (c: Context) => Response | Promise<Response> } = {}) {
  const { accounts, decisions, events } = services;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
      return c.json(error.body(), error.status as 400);
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return c.json(new ApiError("validation_failed", `入力が正しくありません。${where}${issue?.message ?? ""}`).body(), 400);
    }
    console.error(error);
    return c.json(new ApiError("internal", "サーバーで問題が起きました。時間を置いて試してください。").body(), 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ================= アプリ・Web版 =================
  // ログインのリンクを session に替える（session 不要。v1 の認証より前に置く）。
  app.post("/v1/auth/link", async (c) => {
    const input = await body(c, z.object({ code: z.string().min(10).max(200) }));
    return c.json(accounts.redeemLoginLink(input.code));
  });

  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use("*", async (c, next) => {
    c.set("userId", accounts.userBySession(bearer(c)));
    await next();
  });

  v1.get("/decisions", (c) => {
    const statuses = (c.req.query("status") ?? "pending,held").split(",").map((s) => s.trim()).filter(Boolean);
    if (!statuses.length || statuses.some((s) => !STATUSES.includes(s as (typeof STATUSES)[number]))) throw new ApiError("validation_failed", "status が正しくありません。");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const cursor = Math.max(Number(c.req.query("cursor") ?? 0) || 0, 0);
    return c.json(decisions.list(c.get("userId"), statuses, limit, cursor));
  });
  v1.delete("/decisions", (c) => {
    const statuses = (c.req.query("status") ?? "").split(",").sort().join(",");
    if (statuses !== "answered,cancelled") throw new ApiError("validation_failed", "消せるのは既決だけです（status=answered,cancelled）。");
    return idempotent(c, services, c.get("userId"), () => decisions.deleteClosed(c.get("userId")));
  });
  v1.get("/decisions/:id", (c) => c.json(decisions.toApi(decisions.forUser(c.get("userId"), c.req.param("id")))));
  v1.post("/decisions/:id/answer", async (c) => {
    const input = await body(c, answerSchema);
    return idempotent(c, services, c.get("userId"), () => decisions.answer(c.get("userId"), c.req.param("id"), input));
  });
  v1.post("/decisions/:id/hold", (c) => idempotent(c, services, c.get("userId"), () => decisions.setHold(c.get("userId"), c.req.param("id"), true)));
  v1.post("/decisions/:id/unhold", (c) => idempotent(c, services, c.get("userId"), () => decisions.setHold(c.get("userId"), c.req.param("id"), false)));

  v1.get("/events", (c) => {
    const userId = c.get("userId");
    const last = Number(c.req.header("last-event-id") ?? c.req.query("last_event_id") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: UserEvent[] = events.since(userId, last);
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe(userId, (event) => { queue.push(event); wake?.(); });
      stream.onAbort(() => { unsubscribe(); wake?.(); });
      let sent = last;
      while (!stream.aborted) {
        while (queue.length) {
          const event = queue.shift()!;
          if (event.id <= sent) continue;
          sent = event.id;
          await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event.data) });
        }
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, HEARTBEAT_MS); });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.write(": ping\n\n");
      }
      unsubscribe();
    });
  });

  v1.get("/connections", (c) => c.json(accounts.connections(c.get("userId"))));
  v1.delete("/connections/:id", (c) => idempotent(c, services, c.get("userId"), () => { accounts.revokeConnection(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.get("/pairing/lookup", (c) => c.json(accounts.lookupPairing(c.req.query("code") ?? "")));
  v1.post("/pairing/:id/claim", (c) => idempotent(c, services, c.get("userId"), () => accounts.claimPairing(c.get("userId"), c.req.param("id"))));
  v1.post("/pairing/:id/reject", (c) => idempotent(c, services, c.get("userId"), () => { accounts.rejectPairing(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.get("/me", (c) => c.json(accounts.me(c.get("userId"))));
  v1.delete("/me", (c) => { accounts.deleteUser(c.get("userId")); return c.json({ ok: true }); });
  v1.get("/me/settings", (c) => c.json(accounts.settings(c.get("userId"))));
  v1.patch("/me/settings", async (c) => {
    const input = await body(c, z.object({ retention_days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]) }));
    return c.json(accounts.updateSettings(c.get("userId"), input.retention_days));
  });
  v1.post("/auth/logout", (c) => { accounts.revokeSession(bearer(c)!); return c.json({ ok: true }); });

  // 課金の窓口。ストアとStripeの照合はまだ無い。セットアップ確認の関門だけ先に効かせる。
  v1.post("/billing/:store/:action", (c) => {
    accounts.assertSetupVerified(c.get("userId"));
    throw new ApiError("internal", "課金の受付はまだ準備中です。");
  });

  app.route("/v1", v1);

  // ================= コネクタ（AI側）=================
  const conn = new Hono<{ Variables: { conn: ReturnType<Accounts["connectionByToken"]> } }>();
  conn.post("/pairing", async (c) => {
    const input = await body(c, z.object({ device_name: z.string().trim().min(1).max(100), os: z.string().max(20).optional(), clients: z.array(z.string().max(40)).max(10).default([]) }));
    return c.json(accounts.startPairing(input.device_name, input.os ?? null, input.clients, services.publicUrl));
  });
  conn.get("/pairing/:id", async (c) => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const result = accounts.pollPairing(c.req.param("id"), c.req.header("x-poll-secret"));
      if (result.status !== "waiting" || Date.now() > deadline) return c.json(result);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
  conn.use("*", async (c, next) => {
    if (!c.req.path.includes("/pairing")) {
      c.set("conn", accounts.connectionByToken(bearer(c)));
    }
    await next();
  });
  const routeChannel = (c: Context) => c.req.query("channel_id") || undefined;

  conn.get("/connection", (c) => c.json(accounts.connectionInfo(c.get("conn"))));
  conn.delete("/connection", (c) => { const me = c.get("conn"); accounts.revokeConnection(me.user_id, me.id); return c.json({ ok: true }); });
  conn.put("/connection/clients", async (c) => {
    const input = await body(c, z.object({ clients: z.array(z.string().max(40)).max(10), os: z.string().max(20).optional() }));
    accounts.updateConnectionClients(c.get("conn"), input.clients, input.os);
    return c.json(accounts.connectionInfo(c.get("conn")));
  });
  conn.get("/decisions", (c) => c.json({ items: decisions.listMine(c.get("conn"), routeChannel(c)) }));
  conn.post("/decisions", async (c) => {
    const input = await body(c, createSchema);
    accounts.assertCanUse(c.get("conn").user_id);
    const row = decisions.create(c.get("conn"), input);
    return c.json(decisions.toAi(row, input.route?.channel_id));
  });
  conn.get("/decisions/:id", (c) => {
    const row = decisions.forConnection(c.get("conn"), c.req.param("id"));
    return c.json(decisions.toAi(row, routeChannel(c)));
  });
  conn.post("/decisions/:id/fetched", (c) => {
    const row = decisions.forConnection(c.get("conn"), c.req.param("id"));
    decisions.markFetched(row);
    return c.json(decisions.aiView(c.get("conn"), row.id));
  });
  conn.post("/decisions/:id/amend", async (c) => c.json(decisions.amend(c.get("conn"), c.req.param("id"), await body(c, amendSchema))));
  conn.post("/decisions/:id/cancel", async (c) => {
    const input = await body(c, z.object({ reason: z.string().trim().min(1).max(500) }));
    return c.json(decisions.cancel(c.get("conn"), c.req.param("id"), input.reason));
  });
  conn.post("/setup-test", async (c) => {
    const input = await body(c, z.object({
      client: z.string().trim().min(1).max(40), os: z.string().max(20).optional(), session_label: z.string().trim().min(1).max(200),
      route: z.object({ channel_id: z.string().min(1).max(100), harness: z.string().min(1).max(20) }).optional(),
    }));
    return c.json(decisions.startSetupTest(c.get("conn"), input.client, input.os, input.route, input.session_label));
  });
  conn.post("/setup-test/confirm", async (c) => {
    const input = await body(c, z.object({ decision_id: z.string(), code: z.string() }));
    return c.json(decisions.confirmSetupTest(c.get("conn"), input.decision_id, input.code));
  });
  conn.get("/deliveries", (c) => c.json({ items: decisions.pendingDeliveries(c.get("conn")) }));
  conn.post("/deliveries/:id", async (c) => {
    const input = await body(c, z.object({ state: z.enum(["delivered", "unknown", "failed"]), detail: z.string().max(1000).optional() }));
    return c.json(decisions.reportDelivery(c.get("conn"), c.req.param("id"), input.state, input.detail));
  });
  conn.get("/stream", (c) => {
    const connection = c.get("conn");
    return streamSSE(c, async (stream) => {
      let pending = true;
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribeConnection(connection.id, () => { pending = true; wake?.(); });
      stream.onAbort(() => { unsubscribe(); wake?.(); });
      while (!stream.aborted) {
        if (pending) {
          pending = false;
          await stream.writeSSE({ event: "deliveries", data: "{}" });
        }
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, HEARTBEAT_MS); });
        wake = null;
        if (!pending && !stream.aborted) await stream.write(": ping\n\n");
      }
      unsubscribe();
    });
  });
  app.route("/connector/v1", conn);

  if (options.staticHandler) app.get("*", options.staticHandler);
  return app;
}
