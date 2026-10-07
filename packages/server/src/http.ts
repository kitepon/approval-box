import { Diagnostics, diagnosticsAdmin, readDiagnostic } from "./diagnostics.ts";
import { type KeySource, type Provider, verifyIdToken } from "./oidc.ts";
import { onboarding } from "./onboarding.ts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { Accounts } from "./accounts.ts";
import type { AppStore } from "./appstore.ts";
import { type Attachment, type Attachments, MAX_FILE_BYTES, contentDisposition, mediaType, readLimited } from "./attachments.ts";
import { type Db, get, run } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub, UserEvent } from "./events.ts";
import { Decisions, amendSchema, answerSchema, createSchema, routeSchema } from "./decisions.ts";
import { now } from "./ids.ts";
import { type RemoteMcpOptions, remoteMcpHandler } from "./remote-mcp.ts";

export type Services = { db: Db; accounts: Accounts; decisions: Decisions; events: EventHub; publicUrl: string; diagnosticsAdminToken?: string; attachments?: Attachments; appStore?: AppStore; appleAudiences?: string[]; googleAudiences?: string[]; idKeys?: KeySource; webLogin?: { google_client_id?: string; apple_services_id?: string }; remoteMcp?: RemoteMcpOptions };

const STATUSES = ["pending", "held", "answered", "cancelled"] as const;
/** アプリへ戻すURLのscheme（AndroidのCustom Tabsから戻る先）。 */
const APP_SCHEME = "approvalbox";
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

/** 添付の中身を返す。ブラウザで開かれても実行されないよう、ダウンロード扱いにして中身の推測を止める。 */
function fileResponse(c: Context, meta: Attachment, data: Buffer) {
  return c.body(new Uint8Array(data), 200, {
    "content-type": meta.content_type,
    "content-length": String(data.length),
    "content-disposition": contentDisposition(meta.name),
    "etag": `"${meta.sha256}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

export function createApp(services: Services, options: { staticHandler?: (c: Context) => Response | Promise<Response> } = {}) {
  const { accounts, decisions, events } = services;
  const files = () => {
    if (!services.attachments) throw new ApiError("not_found", "このサーバーでは添付を使えません。");
    return services.attachments;
  };
  /** 消した行のファイルを片付ける。失敗しても操作そのものは済んでいるので、記録だけ残す。 */
  const sweep = () => { try { services.attachments?.gc(); } catch (error) { console.error(error); } };
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

  const diagnostics = new Diagnostics(services.db);
  app.route("/api/admin",diagnosticsAdmin(diagnostics,services.diagnosticsAdminToken));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ================= アプリ・Web版 =================
  // GoogleとAppleのログイン。同じIDなら同じアカウント、違うIDなら別のアカウント。
  const signIn = (provider: Provider, audiences: string[]) => async (c: Context) => {
    if (!audiences.length) throw new ApiError("validation_failed", `このサーバーでは${provider === "apple" ? "Apple" : "Google"}のログインを使えません。`);
    const input = await body(c, z.object({ identity_token: z.string().min(10).max(10000).optional(), id_token: z.string().min(10).max(10000).optional(), nonce: z.string().min(1).max(500).optional() }));
    const token = input.identity_token ?? input.id_token;
    if (!token) throw new ApiError("validation_failed", provider === "apple" ? "identity_token が要ります。" : "id_token が要ります。");
    const id = await verifyIdToken(provider, token, { audiences, ...(input.nonce ? { nonce: input.nonce } : {}), ...(services.idKeys ? { keys: services.idKeys } : {}) });
    return c.json(accounts.signInWithIdentity(provider, id.sub, id.email));
  };
  // Web版のログインボタンに要る公開の値（秘密ではない）。設定が無ければ空で、Web版はボタンを出さない。
  app.get("/v1/auth/config", (c) => c.json(services.webLogin ?? {}));
  app.post("/v1/auth/apple", signIn("apple", services.appleAudiences ?? []));

  // ブラウザで始めるAppleのログイン（AndroidのCustom Tabs）。
  // Appleは結果を /auth/apple/callback へ form_post する。サーバーは確かめてから、一度きりのコードを付けてアプリへ戻す。
  // アプリは /v1/auth/link に code と code_verifier を送って session に替える。BearerやsessionはURLに載せない。
  app.post("/v1/auth/apple/web/start", async (c) => {
    const servicesId = services.webLogin?.apple_services_id;
    if (!servicesId) throw new ApiError("validation_failed", "このサーバーではAppleのログインを使えません。");
    const input = await body(c, z.object({ code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256") }));
    const flow = accounts.startAuthFlow("apple", input.code_challenge);
    const params = new URLSearchParams({ client_id: servicesId, redirect_uri: `${services.publicUrl}/auth/apple/callback`, response_type: "code id_token", response_mode: "form_post", state: flow.state, nonce: flow.nonce });
    return c.json({ authorization_url: `https://appleid.apple.com/auth/authorize?${params}`, state: flow.state, expires_at: flow.expires_at });
  });
  app.post("/auth/apple/callback", async (c) => {
    const form = await c.req.parseBody();
    const state = typeof form.state === "string" ? form.state : "";
    const back = (query: Record<string, string>) => c.redirect(`${APP_SCHEME}://auth/apple?${new URLSearchParams({ ...query, state })}`, 303);
    try {
      if (typeof form.error === "string") return back({ error: form.error === "user_cancelled_authorize" ? "cancelled" : "apple_error" });
      const flow = accounts.takeAuthFlow(state);
      if (typeof form.id_token !== "string") return back({ error: "apple_error" });
      const id = await verifyIdToken("apple", form.id_token, { audiences: [services.webLogin!.apple_services_id!], nonce: flow.nonce, ...(services.idKeys ? { keys: services.idKeys } : {}) });
      const signed = accounts.signInWithIdentity("apple", id.sub, id.email);
      accounts.revokeSession(signed.session); // ここで作ったsessionは使わない。アプリには一度きりのコードを渡す
      return back({ code: accounts.createAppCode(signed.user.id, flow.code_challenge) });
    } catch (error) {
      return back({ error: error instanceof ApiError ? error.code : "apple_error" });
    }
  });
  app.post("/v1/auth/google", signIn("google", services.googleAudiences ?? []));

  // App Store Server Notifications V2（Appleのサーバーから。ログインは無く、署名で確かめる）。
  app.post("/v1/appstore/notifications", async (c) => {
    if (!services.appStore) throw new ApiError("not_found", "App Storeの照合は設定されていません。");
    const input = await body(c, z.object({ signedPayload: z.string().min(1).max(100_000) }));
    return c.json(await services.appStore.notification(input.signedPayload));
  });

  // ブラウザで始めたAppleのログインから戻ったアプリが、一度きりのコードを session に替える（code_verifier 必須）。
  app.post("/v1/auth/link", async (c) => {
    const input = await body(c, z.object({ code: z.string().min(10).max(200), code_verifier: z.string().min(43).max(128) }));
    return c.json(accounts.redeemAppCode(input.code, input.code_verifier));
  });

  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use("*", async (c, next) => {
    c.set("userId", accounts.userBySession(bearer(c)));
    await next();
  });

  v1.post("/diagnostics",async c=>c.json(diagnostics.accept(c.get("userId"),await readDiagnostic(c.req.raw),c.req.header("idempotency-key")),202));

  v1.get("/decisions", (c) => {
    const statuses = (c.req.query("status") ?? "pending,held").split(",").map((s) => s.trim()).filter(Boolean);
    if (!statuses.length || statuses.some((s) => !STATUSES.includes(s as (typeof STATUSES)[number]))) throw new ApiError("validation_failed", "status が正しくありません。");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const cursor = Math.max(Number(c.req.query("cursor") ?? 0) || 0, 0);
    return c.json(decisions.list(c.get("userId"), statuses, limit, cursor));
  });
  v1.delete("/decisions", async (c) => {
    const statuses = (c.req.query("status") ?? "").split(",").sort().join(",");
    if (statuses !== "answered,cancelled") throw new ApiError("validation_failed", "消せるのは既決だけです（status=answered,cancelled）。");
    const res = await idempotent(c, services, c.get("userId"), () => decisions.deleteClosed(c.get("userId")));
    sweep();
    return res;
  });
  v1.get("/decisions/:id", (c) => c.json(decisions.toApi(decisions.forUser(c.get("userId"), c.req.param("id")))));
  v1.post("/decisions/:id/answer", async (c) => {
    const input = await body(c, answerSchema);
    const res = await idempotent(c, services, c.get("userId"), () => decisions.answer(c.get("userId"), c.req.param("id"), input));
    sweep();
    return res;
  });
  // 添付（api.md「添付（v0.23）」）。本文はファイルの中身そのまま。
  v1.post("/decisions/:id/attachments", async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key || key.length > 200) throw new ApiError("validation_failed", "Idempotency-Key が要ります。");
    const data = await readLimited(c.req.raw.body, MAX_FILE_BYTES);
    return c.json(files().upload(c.get("userId"), c.req.param("id"), { name: c.req.query("name") ?? "", contentType: mediaType(c.req.header("content-type")), idempotencyKey: key, data }));
  });
  v1.get("/decisions/:id/attachments", (c) => c.json(files().staged(c.get("userId"), c.req.param("id"))));
  v1.delete("/decisions/:id/attachments/:aid", (c) => c.json(files().removeStaged(c.get("userId"), c.req.param("id"), c.req.param("aid"))));
  v1.get("/decisions/:id/attachments/:aid", (c) => {
    const file = files().readForUser(c.get("userId"), c.req.param("id"), c.req.param("aid"));
    return fileResponse(c, file.meta, file.data);
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

  v1.post("/tokens", async (c) => {
    const input = await body(c, z.object({ label: z.string().trim().min(1).max(100) }));
    // tokenは1回だけ返す。冪等の記録（返事の本文をDBに残す）には通さない。
    return c.json(accounts.issueToken(c.get("userId"), input.label, services.publicUrl));
  });
  v1.get("/tokens", (c) => c.json(accounts.tokens(c.get("userId"))));
  v1.delete("/tokens/:id", (c) => idempotent(c, services, c.get("userId"), () => { accounts.revokeToken(c.get("userId"), c.req.param("id")); return { ok: true }; }));
  v1.post("/devices", async (c) => {
    const input = await body(c, z.object({
      platform: z.enum(["ios", "android", "web"]),
      apns_token: z.string().min(1).max(400).optional(),
      apns_env: z.enum(["sandbox", "production"]).optional(),
      fcm_token: z.string().min(1).max(4096).optional(),
      web_push_subscription: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).optional(),
    }));
    return c.json(accounts.registerDevice(c.get("userId"), input));
  });
  v1.delete("/devices/:id", (c) => { accounts.removeDevice(c.get("userId"), c.req.param("id")); return c.json({ ok: true }); });
  v1.get("/onboarding", (c) => c.json(onboarding(services.publicUrl)));

  v1.get("/pairing/lookup", (c) => c.json(accounts.lookupPairing(c.req.query("code") ?? "")));
  v1.post("/pairing/:id/claim", (c) => idempotent(c, services, c.get("userId"), () => accounts.claimPairing(c.get("userId"), c.req.param("id"))));
  v1.post("/pairing/:id/reject", (c) => idempotent(c, services, c.get("userId"), () => { accounts.rejectPairing(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.get("/me", (c) => c.json(accounts.me(c.get("userId"))));
  v1.delete("/me", (c) => { accounts.deleteUser(c.get("userId")); sweep(); return c.json({ ok: true }); });
  v1.get("/me/settings", (c) => c.json(accounts.settings(c.get("userId"))));
  v1.patch("/me/settings", async (c) => {
    const input = await body(c, z.object({ retention_days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]) }));
    return c.json(accounts.updateSettings(c.get("userId"), input.retention_days));
  });
  v1.post("/auth/logout", (c) => { accounts.revokeSession(bearer(c)!); return c.json({ ok: true }); });

  v1.post("/billing/appstore/verify", async (c) => {
    if (!services.appStore) throw new ApiError("internal", "App Storeの照合は設定されていません。");
    const input = await body(c, z.object({ jws: z.string().min(1).max(100_000) }));
    return c.json(await services.appStore.verifyPurchase(c.get("userId"), input.jws));
  });

  // Google Play・Stripeの照合はまだ無い。セットアップ確認の関門だけ先に効かせる。
  v1.post("/billing/:store/:action", (c) => {
    accounts.assertSetupVerified(c.get("userId"));
    throw new ApiError("internal", "課金の受付はまだ準備中です。");
  });

  // 知らないAPIのpathにWeb版のHTMLを返さない（アプリが形式不正として扱えるよう、JSONの404にする）。
  v1.all("*", () => { throw new ApiError("not_found", "そのAPIはありません。"); });
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
  conn.delete("/connection", (c) => { const me = c.get("conn"); accounts.revokeConnection(me.user_id, me.id); sweep(); return c.json({ ok: true }); });
  conn.put("/connection/clients", async (c) => {
    const input = await body(c, z.object({ clients: z.array(z.string().max(40)).max(10), os: z.string().max(20).optional() }));
    accounts.updateConnectionClients(c.get("conn"), input.clients, input.os);
    return c.json(accounts.connectionInfo(c.get("conn")));
  });
  conn.get("/decisions", (c) => c.json({ items: decisions.listMine(c.get("conn"), routeChannel(c)) }));
  conn.post("/request-images", async (c) => {
    const me = c.get("conn");
    accounts.assertCanUse(me.user_id);
    const data = await readLimited(c.req.raw.body, MAX_FILE_BYTES);
    return c.json(files().uploadRequest(me, { name: c.req.query("name") ?? "image", contentType: mediaType(c.req.header("content-type")), data }));
  });
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
  conn.post("/decisions/:id/resume", async (c) => c.json(decisions.resume(c.get("conn"), c.req.param("id"), await body(c, routeSchema))));
  conn.post("/decisions/:id/amend", async (c) => {
    const result = decisions.amend(c.get("conn"), c.req.param("id"), await body(c, amendSchema));
    sweep();
    return c.json(result);
  });
  conn.post("/decisions/:id/cancel", async (c) => {
    const input = await body(c, z.object({ reason: z.string().trim().min(1).max(500) }));
    const res = decisions.cancel(c.get("conn"), c.req.param("id"), input.reason);
    sweep();
    return c.json(res);
  });
  conn.get("/decisions/:id/attachments/:aid", (c) => {
    const row = decisions.forConnection(c.get("conn"), c.req.param("id"));
    const file = files().readForAi(row.id, c.req.param("aid"));
    return fileResponse(c, file.meta, file.data);
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
  conn.all("*", () => { throw new ApiError("not_found", "そのAPIはありません。"); });
  app.route("/connector/v1", conn);

  // ================= リモートMCP（端末にコネクタを置けないAI）=================
  app.post("/mcp", remoteMcpHandler(accounts, decisions, services.remoteMcp));
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" }));

  if (options.staticHandler) app.get("*", options.staticHandler);
  return app;
}
