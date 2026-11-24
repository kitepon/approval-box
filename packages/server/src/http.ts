import { getCookie } from "hono/cookie";
import { LOCALES } from "./locales.ts";
import { requestLocale } from "./locale.ts";
import { Diagnostics, diagnosticsAdmin, readDiagnostic } from "./diagnostics.ts";
import { type KeySource, type Provider, verifyIdToken } from "./oidc.ts";
import { onboarding } from "./onboarding.ts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { Accounts } from "./accounts.ts";
import type { AppStore } from "./appstore.ts";
import type { Play } from "./play.ts";
import { type Attachment, type Attachments, MAX_FILE_BYTES, contentDisposition, mediaType, readLimited } from "./attachments.ts";
import { type Db, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub, UserEvent } from "./events.ts";
import { Decisions, amendSchema, answerSchema, createSchema, routeSchema } from "./decisions.ts";
import { now } from "./ids.ts";
import { type RemoteMcpOptions, remoteMcpHandler } from "./remote-mcp.ts";
import { LoginBillingError, type Checked } from "@kitepon/login-billing/server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Library, PRODUCT_ID, rateLimiter } from "./lb.ts";
import { type AppKeyholes, KeyholeError, SIGNED_HEADER } from "./keyholes.ts";
import { exportAccount } from "./export.ts";
import { type AppLinks, appleAppSiteAssociation, assetLinks } from "./applinks.ts";

export type Services = { db: Db; accounts: Accounts; decisions: Decisions; events: EventHub; publicUrl: string; diagnosticsAdminToken?: string; attachments?: Attachments; appStore?: AppStore; play?: Play; appleAudiences?: string[]; googleAudiences?: string[]; idKeys?: KeySource; webLogin?: { google_client_id?: string; apple_services_id?: string }; remoteMcp?: RemoteMcpOptions; shutdown?: AbortSignal; library?: Library; peerChannel?: { forgetAccount(k: string): void; connectionRemoved(k: string, connectionId: string): void }; appLinks?: AppLinks; keyholes?: AppKeyholes };

/** 登録クライアント（BellTeamなど）のsessionが通れる `/v1` の経路。ここに無いものは403。 */
const CLIENT_ROUTES: [string, RegExp][] = [
  ["GET", /^\/decisions$/],
  ["GET", /^\/decisions\/[^/]+$/],
  ["POST", /^\/decisions\/[^/]+\/(answer|hold|unhold)$/],
  ["GET", /^\/decisions\/[^/]+\/attachments\/[^/]+$/],
  ["GET", /^\/events$/],
  ["GET", /^\/me$/],
];

/** 共有ライブラリの通行証で、契約が要る経路（G1）。申請の一覧・開く・答える・保留・消す・添付、更新の知らせ。 */
/** /events を Last-Event-ID なしで張った時に流す直近の幅。知らせは一覧を取り直す合図なので、古い履歴は要らない。 */
const FRESH_CONNECT_WINDOW_MS = 60_000;
const PAID_ROUTES = [/^\/decisions(\/|$)/, /^\/events$/];
/** 契約が無くても通す、セットアップ確認の申請を読む・答える経路。 */
const SETUP_ROUTES: [string, RegExp][] = [["GET", /^\/decisions\/([^/]+)$/], ["POST", /^\/decisions\/([^/]+)\/answer$/]];

/** ライブラリだけで動く時（login-pass.md「library-only mode」）に 410 を返す、個人の識別子を作る・使う旧い入口。 */
const LEGACY_ROUTES = [
  "/v1/auth/apple", "/v1/auth/google", "/v1/auth/link", "/v1/auth/apple/web/start", "/v1/auth/google/web/start", "/auth/apple/callback", "/auth/google/callback",
  "/v1/billing/appstore/verify", "/v1/billing/play/verify", "/v1/appstore/notifications", "/v1/play/notifications",
];

/** 回数制限の単位（接続元）。前段の中継が付ける X-Forwarded-For の最後（中継が見た相手）か、直の接続元。メモリだけで使い、保存もログにも出さない。 */
function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",").at(-1)!.trim();
  try { return getConnInfo(c).remote.address ?? ""; } catch { return ""; }
}

/** Body cap of /v1/keys/* (local-form.md "Edge limits"). */
const KEYS_BODY_MAX = 16 * 1024;

/** The library's KeyholeRequest: the path with query exactly as the device sent it (Node's raw url when served by Node), and the raw body bytes. */
function keyholeRequest(c: Context, body: Uint8Array) {
  const incoming = (c.env as { incoming?: { url?: string } } | undefined)?.incoming?.url;
  const url = new URL(c.req.url);
  return { method: c.req.method, path: incoming ?? `${url.pathname}${url.search}`, headers: c.req.raw.headers, body };
}

/** Reads the raw body once for the signed-request check and puts the same bytes back on the request, so the route reads it as before. */
async function takeBody(c: Context, limit: number, message: string): Promise<Uint8Array> {
  const raw = c.req.raw;
  if (!raw.body) return new Uint8Array();
  if (Number(raw.headers.get("content-length") ?? 0) > limit) throw new ApiError("too_large", message);
  const bytes = await readLimited(raw.body, limit).catch((error: unknown) => { throw error instanceof ApiError && error.code === "too_large" ? new ApiError("too_large", message) : error; });
  c.req.raw = new Request(raw.url, { method: raw.method, headers: raw.headers, body: new Uint8Array(bytes), signal: raw.signal });
  return new Uint8Array(bytes);
}

const STATUSES = ["pending", "held", "answered", "cancelled"] as const;
/** アプリへ戻すURLのscheme（AndroidのCustom Tabsから戻る先）。 */
const APP_SCHEME = "approvalbox";
/**
 * デスクトップ版の戻り先（RFC 8252 §7.3 のループバック）。http の 127.0.0.1 か [::1]、1024〜65535のポート、パスあり、
 * ユーザー情報・クエリ・フラグメントなし。満たさなければ400。返すのは正規化したURL（これをflowに保存して戻り先にする）。
 */
function loopbackRedirect(raw: string): string {
  const invalid = new ApiError("validation_failed", "redirect_uri は http://127.0.0.1:ポート番号/ か http://[::1]:ポート番号/ の形にしてください。ポートは1024から65535で、ユーザー名・クエリ・フラグメントは付けられません。");
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid; }
  const port = Number(url.port);
  // 空のクエリ（"?"）と空のフラグメント（"#"）はURLの上では空になるので、元の文字列でも断る。
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") || !url.port || !(port >= 1024 && port <= 65535)
    || url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) throw invalid;
  return url.href;
}
const HEARTBEAT_MS = 25_000;
/** 次の知らせ・切断・停止の合図か、ping の時刻まで待つ。起こされたら時計を片付ける。 */
function untilWake(shutdown: AbortSignal | undefined, arm: (resume: () => void) => void) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HEARTBEAT_MS);
    const resume = () => { clearTimeout(timer); resolve(); };
    arm(resume);
    if (shutdown?.aborted) resume();
  });
}

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

/** 書き込みの冪等キー。同期の変更処理と初回応答の記録の間では実行を譲らない。 */
function idempotent(c: Context, services: Services, userId: string, fn: () => Record<string, unknown>) {
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
    payload = fn();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500 || error.code === "rate_limited") throw error;
    status = error.status;
    payload = error.body(requestLocale(c.req.header("Accept-Language")));
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
  const { accounts, decisions, events, library } = services;
  const files = () => {
    if (!services.attachments) throw new ApiError("not_found", "このサーバーでは添付を使えません。");
    return services.attachments;
  };
  /** 消した行のファイルを片付ける。失敗しても操作そのものは済んでいるので、記録だけ残す。 */
  const sweep = () => { try { services.attachments?.gc(); } catch (error) { console.error(error); } };
  const app = new Hono();

  app.onError((error, c) => {
    const locale = requestLocale(c.req.header("Accept-Language"));
    c.header("Content-Language", locale);
    c.header("Vary", "Accept-Language");
    if (error instanceof ApiError) {
      if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
      return c.json(error.body(locale), error.status as 400);
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return c.json(new ApiError("validation_failed", `入力が正しくありません。${where}${issue?.message ?? ""}`).body(locale), 400);
    }
    console.error(error);
    return c.json(new ApiError("internal", "サーバーで問題が起きました。時間を置いて試してください。").body(locale), 500);
  });

  // 共有ライブラリ（login-billing）の受け口。署名・QR・通行証の更新など、wire v1の経路は全部ここで答える。
  if (library) {
    app.use("/auth/v1/*", async (c, next) => {
      if (!library.allow(c.req.path, clientKey(c))) return library.handler.errorResponse("rate_limited", c.req.raw);
      return (await library.handler.handle(c.req.raw)) ?? next();
    });
    // 旧い入口は、下の今までの処理より先に登録して閉じる（セルフホストでライブラリを使わない時は今まで通り）。
    for (const path of LEGACY_ROUTES) app.post(path, () => { throw new ApiError("gone", "この入口はもう使えません。アプリを新しい版にしてください。"); });
  }

  // The library's keyholes (local-form.md): start, accept, others, leave. Mounted ahead of the /v1 device check, since a key in no entry must reach start and accept.
  const keyholes = services.keyholes;
  if (keyholes) {
    const allow = rateLimiter(30, 60_000);
    app.all("/v1/keys/:route{start|accept|others|leave}", async (c) => {
      if (!allow(clientKey(c))) throw new ApiError("rate_limited", "回数が多すぎます。少し待ってから試してください。");
      return keyholes.handle(keyholeRequest(c, await takeBody(c, KEYS_BODY_MAX, "本文は16KBまでです。")));
    });
  }

  const diagnostics = new Diagnostics(services.db);
  app.route("/api/admin",diagnosticsAdmin(diagnostics,services.diagnosticsAdminToken));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // アプリのリンクの宣言（設定がある時だけ。無ければ404。リダイレクトしない）。
  const wellKnown = (body: unknown) => (c: Context) => {
    if (!body) throw new ApiError("not_found", "このサーバーではアプリのリンクを設定していません。");
    return c.body(JSON.stringify(body), 200, { "content-type": "application/json", "cache-control": "public, max-age=3600" });
  };
  app.get("/.well-known/assetlinks.json", wellKnown(services.appLinks && assetLinks(services.appLinks)));
  app.get("/.well-known/apple-app-site-association", wellKnown(services.appLinks && appleAppSiteAssociation(services.appLinks)));

  // ================= アプリ・Web版 =================
  // GoogleとAppleのログイン。同じIDなら同じアカウント、違うIDなら別のアカウント。
  const signIn = (provider: Provider, audiences: string[]) => async (c: Context) => {
    if (!audiences.length) throw new ApiError("validation_failed", `このサーバーでは${provider === "apple" ? "Apple" : "Google"}のログインを使えません。`);
    const input = await body(c, z.object({ identity_token: z.string().min(10).max(10000).optional(), id_token: z.string().min(10).max(10000).optional(), nonce: z.string().min(1).max(500).optional() }));
    const token = input.identity_token ?? input.id_token;
    if (!token) throw new ApiError("validation_failed", provider === "apple" ? "identity_token が要ります。" : "id_token が要ります。");
    const id = await verifyIdToken(provider, token, { audiences, ...(input.nonce ? { nonce: input.nonce } : {}), ...(services.idKeys ? { keys: services.idKeys } : {}) });
    return c.json(accounts.signInWithIdentity(provider, id.sub));
  };
  // Web版のログインボタンに要る公開の値（秘密ではない）。設定が無ければボタンは出ない。library_login はライブラリのQRログインを使うサーバーだけ true。
  // peer_channel: /pc/v1 が置かれている（コネクタは、これと鍵の登録がそろった時だけ peer-channel の道を使う。c8c）。
  app.get("/v1/auth/config", (c) => c.json({ ...(services.webLogin ?? {}), library_login: !!library, peer_channel: !!services.peerChannel }));
  app.post("/v1/auth/apple", signIn("apple", services.appleAudiences ?? []));

  // ブラウザで始めるAppleとGoogleのログイン（AndroidのCustom Tabs・Linuxデスクトップ版のシステムのブラウザ）。
  // 提供元は結果を /auth/<provider>/callback へ form_post する。サーバーは確かめてから、一度きりのコードを付けてアプリへ戻す。
  // アプリは /v1/auth/link に code と code_verifier を送って session に替える。BearerやsessionはURLに載せない。
  // 戻り先は、開始時に state へ結んで保存した値だけで決める（無ければ approvalbox://auth/<provider>）。callbackのリクエストからは決めない。
  const webLogin = {
    apple: { label: "Apple", clientId: () => services.webLogin?.apple_services_id, authorize: "https://appleid.apple.com/auth/authorize", cancelled: "user_cancelled_authorize",
      params: { response_type: "code id_token", response_mode: "form_post" } },
    google: { label: "Google", clientId: () => services.webLogin?.google_client_id, authorize: "https://accounts.google.com/o/oauth2/v2/auth", cancelled: "access_denied",
      params: { response_type: "id_token", response_mode: "form_post", scope: "openid email", prompt: "select_account" } },
  } as const;
  for (const provider of ["apple", "google"] as const) {
    const login = webLogin[provider];
    app.post(`/v1/auth/${provider}/web/start`, async (c) => {
      const clientId = login.clientId();
      if (!clientId) throw new ApiError("validation_failed", `このサーバーでは${login.label}のログインを使えません。`);
      const input = await body(c, z.object({ code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256"), redirect_uri: z.string().max(300).optional() }));
      const flow = accounts.startAuthFlow(provider, input.code_challenge, input.redirect_uri === undefined ? undefined : loopbackRedirect(input.redirect_uri));
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: `${services.publicUrl}/auth/${provider}/callback`, ...login.params, state: flow.state, nonce: flow.nonce });
      return c.json({ authorization_url: `${login.authorize}?${params}`, state: flow.state, expires_at: flow.expires_at });
    });
    app.post(`/auth/${provider}/callback`, async (c) => {
      const form = await c.req.parseBody();
      const state = typeof form.state === "string" ? form.state : "";
      const target = accounts.authFlowRedirect(state, provider) ?? `${APP_SCHEME}://auth/${provider}`;
      const back = (query: Record<string, string>) => c.redirect(`${target}?${new URLSearchParams({ ...query, state })}`, 303);
      try {
        if (typeof form.error === "string") return back({ error: form.error === login.cancelled ? "cancelled" : `${provider}_error` });
        const audience = login.clientId();
        if (!audience) return back({ error: `${provider}_error` });
        const flow = accounts.takeAuthFlow(state, provider);
        if (typeof form.id_token !== "string") return back({ error: `${provider}_error` });
        const id = await verifyIdToken(provider, form.id_token, { audiences: [audience], nonce: flow.nonce, ...(services.idKeys ? { keys: services.idKeys } : {}) });
        const signed = accounts.signInWithIdentity(provider, id.sub);
        accounts.bindAuthFlow(state, signed.user.id);
        accounts.revokeSession(signed.session); // ここで作ったsessionは使わない。アプリには一度きりのコードを渡す
        return back({ code: accounts.createAppCode(signed.user.id, flow.code_challenge) });
      } catch (error) {
        return back({ error: error instanceof ApiError ? error.code : `${provider}_error` });
      }
    });
  }
  app.post("/v1/auth/google", signIn("google", services.googleAudiences ?? []));

  // App Store Server Notifications V2（Appleのサーバーから。ログインは無く、署名で確かめる）。
  app.post("/v1/appstore/notifications", async (c) => {
    if (!services.appStore) throw new ApiError("not_found", "App Storeの照合は設定されていません。");
    const input = await body(c, z.object({ signedPayload: z.string().min(1).max(100_000) }));
    return c.json(await services.appStore.notification(input.signedPayload));
  });

  // Google PlayのPub/Sub push（Googleのサーバーから。ログインは無く、OIDCの署名で確かめる）。
  app.post("/v1/play/notifications", async (c) => {
    if (!services.play) throw new ApiError("not_found", "Google Playの照合は設定されていません。");
    return c.json(await services.play.notification(await c.req.text(), c.req.header("authorization")));
  });

  // ブラウザで始めたAppleのログインから戻ったアプリが、一度きりのコードを session に替える（code_verifier 必須）。
  app.post("/v1/auth/link", async (c) => {
    const input = await body(c, z.object({ code: z.string().min(10).max(200), code_verifier: z.string().min(43).max(128) }));
    return c.json(accounts.redeemAppCode(input.code, input.code_verifier));
  });

  const v1 = new Hono<{ Variables: { userId: string; clientSessionId: string | undefined; pass: Checked | undefined; keyhole: string | undefined } }>();
  v1.use("*", async (c, next) => {
    const path = c.req.path.slice("/v1".length);
    // The new form: a request signed with the device's library key -> the entry is the account. No paid gate: the paid check is on each device.
    if (keyholes && c.req.header(SIGNED_HEADER) !== undefined) {
      let who: { entry: string; key: string };
      try {
        who = await keyholes.verify(keyholeRequest(c, await takeBody(c, MAX_FILE_BYTES, "1つのファイルは20MBまでです。")));
      } catch (error) {
        if (error instanceof KeyholeError) return c.json(error.body(), error.status as 401);
        throw error;
      }
      keyholes.entries.signedIn(who.entry);
      c.set("userId", who.entry);
      c.set("keyhole", who.key);
      return next();
    }
    // ライブラリを使う時は、先にライブラリの通行証（Bearerかcookie）として確かめる。通行証でなければ（pass_invalid）、今までのsessionとして扱う。
    const pass = library ? await library.handler.authenticate(c.req.raw).catch((error: unknown) => {
      if (!(error instanceof LoginBillingError)) throw error;
      return error.code === "pass_invalid" ? undefined : library.handler.errorResponse(error.code, c.req.raw);
    }) : undefined;
    if (pass instanceof Response) return pass;
    if (pass) {
      accounts.ensureUser(pass.k);
      // 更新された通行証（Login-Billing-Pass、cookieならSet-Cookie）を、この応答に付ける。
      for (const [name, value] of pass.headers) if (name !== "set-cookie") c.header(name, value);
      for (const cookie of pass.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
      // G1: 契約（またはexemptのK）が要る経路。セットアップ確認の申請を読む・答えるだけは契約なしで通す。
      if (PAID_ROUTES.some((p) => p.test(path)) && !pass.entitlements.some((e) => e.productId === PRODUCT_ID)
        && !SETUP_ROUTES.some(([method, p]) => method === c.req.method && get<{ test: number }>(services.db, "select test from decisions where id = ? and user_id = ?", p.exec(path)?.[1] ?? "", pass.k)?.test)) {
        throw new ApiError("subscription_expired", "Approval Boxの契約がありません。iPhone・Mac・Android のアプリで契約してください。");
      }
      c.set("userId", pass.k);
      c.set("pass", pass);
      return next();
    }
    const auth = accounts.authenticate(bearer(c));
    // ライブラリだけで動く時、通行証でないBearerは登録クライアントのsession（BellTeam）だけ。旧いログインのsessionは使えない。
    if (library && !auth.client) throw new ApiError("unauthorized", "ログインの期限が切れました。もう一度ログインしてください。");
    if (auth.client) {
      // 登録クライアントのsessionが通れるのは許可表の経路だけ（docs/bellteam-client.md）。ログインのsessionは制限しない。
      if (!CLIENT_ROUTES.some(([method, p]) => method === c.req.method && p.test(path))) throw new ApiError("forbidden", "この許可では、このAPIは使えません。");
      // G2: ライブラリが「契約なし」と覚えているアカウントは、/me 以外を402にする。
      if (path !== "/me") accounts.assertContract(auth.userId);
    }
    c.set("userId", auth.userId);
    c.set("clientSessionId", auth.sessionId);
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
    if (statuses !== "answered,cancelled") throw new ApiError("validation_failed", "消せるのは履歴（回答済み・取り下げ）だけです（status=answered,cancelled）。");
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
    const clientSessionId = c.get("clientSessionId");
    const last = Number(c.req.header("last-event-id") ?? c.req.query("last_event_id") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: UserEvent[] = last ? events.since(userId, last) : events.recent(userId, FRESH_CONNECT_WINDOW_MS);
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe(userId, (event) => { queue.push(event); wake?.(); });
      stream.onAbort(() => { unsubscribe(); wake?.(); });
      const stop = () => wake?.();
      services.shutdown?.addEventListener("abort", stop, { once: true });
      let sent = last;
      // 外された登録クライアントの流れは、次の心拍（25秒以内）で閉じる。
      const granted = () => !clientSessionId || accounts.clientSessionActive(clientSessionId);
      while (!stream.aborted && !services.shutdown?.aborted && granted()) {
        while (queue.length) {
          const event = queue.shift()!;
          if (event.id <= sent) continue;
          sent = event.id;
          await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event.data) });
        }
        await untilWake(services.shutdown, (resume) => { wake = resume; });
        wake = null;
        if (!queue.length && !stream.aborted && !services.shutdown?.aborted) await stream.write(": ping\n\n");
      }
      // 停止の合図では、流れを正しく閉じて返す。利用側は切断でなく正常終了として再接続できる。
      services.shutdown?.removeEventListener("abort", stop);
      unsubscribe();
    });
  });

  v1.get("/connections", (c) => c.json(accounts.connections(c.get("userId"))));
  v1.delete("/connections/:id", (c) => idempotent(c, services, c.get("userId"), () => { accounts.revokeConnection(c.get("userId"), c.req.param("id")); services.peerChannel?.connectionRemoved(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.post("/tokens", async (c) => {
    const input = await body(c, z.object({ label: z.string().trim().min(1).max(100) }));
    // tokenは1回だけ返す。冪等の記録（返事の本文をDBに残す）には通さない。
    return c.json(accounts.issueToken(c.get("userId"), input.label, services.publicUrl));
  });
  v1.get("/tokens", (c) => c.json(accounts.tokens(c.get("userId"))));
  v1.delete("/tokens/:id", (c) => idempotent(c, services, c.get("userId"), () => { accounts.revokeToken(c.get("userId"), c.req.param("id")); services.peerChannel?.connectionRemoved(c.get("userId"), c.req.param("id")); return { ok: true }; }));
  v1.post("/devices", async (c) => {
    const input = await body(c, z.object({
      platform: z.enum(["ios", "android", "web"]),
      locale: z.enum(LOCALES).optional(),
      apns_token: z.string().min(1).max(400).optional(),
      apns_env: z.enum(["sandbox", "production"]).optional(),
      fcm_token: z.string().min(1).max(4096).optional(),
      web_push_subscription: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).optional(),
    }));
    return c.json(accounts.registerDevice(c.get("userId"), input, c.get("keyhole")));
  });
  v1.delete("/devices/:id", (c) => { accounts.removeDevice(c.get("userId"), c.req.param("id")); return c.json({ ok: true }); });
  v1.get("/onboarding", (c) => {
    const locale = requestLocale(c.req.header("Accept-Language"));
    c.header("Content-Language", locale); c.header("Vary", "Accept-Language");
    return c.json(onboarding(services.publicUrl, locale));
  });

  v1.get("/pairing/lookup", (c) => c.json(accounts.lookupPairing(c.req.query("code") ?? "")));
  v1.post("/pairing/:id/claim", async (c) => {
    const input = await body(c, z.object({ confirm_client: z.string().max(40).optional() }));
    return idempotent(c, services, c.get("userId"), () => accounts.claimPairing(c.get("userId"), c.req.param("id"), input.confirm_client));
  });
  v1.post("/pairing/:id/reject", (c) => idempotent(c, services, c.get("userId"), () => { accounts.rejectPairing(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.get("/me", (c) => c.json(accounts.me(c.get("userId"), c.get("pass")?.entitlements)));
  // 自分のアカウントに保存している全ての写し。どの端末でも（契約が切れていても）取れる。
  v1.get("/me/export", (c) => {
    const day = now().slice(0, 10).replaceAll("-", "");
    return c.body(JSON.stringify(exportAccount(services, c.get("userId"))), 200, {
      "content-type": "application/json", "content-disposition": `attachment; filename="approval-box-export-${day}.json"`, "cache-control": "private, no-store",
    });
  });
  v1.delete("/me", async (c) => {
    const userId = c.get("userId");
    // A signed request: erase the entry and its keyholes, so every device of it is signed out of it.
    if (c.get("keyhole")) { keyholes!.entries.erase(userId); return c.json({ ok: true }); }
    // 通行証で入った時は、消す前にこのアカウントの全端末のログインを止める（契約 1.32 endAllLogins、ミント 2026-11-23）。端末の後追いのサインアウトが失敗しても、他の端末が残っていても、消したアカウントの通行証は残らない。止められなければ何も消さない。
    const token = c.get("pass") && library ? bearer(c) ?? getCookie(c, "__Host-lb_pass") : undefined;
    if (token) await library!.lb.endAllLogins(token);
    const ids = services.attachments?.userFileIds(userId) ?? [];
    tx(services.db, () => {
      accounts.deleteUser(userId);
      services.attachments?.eraseFiles(ids);
    });
    services.peerChannel?.forgetAccount(userId); // peer-channel の登録の写し（公開鍵だけ）も消し、その K の接続を閉じる
    return c.json({ ok: true });
  });
  // Migration (local-form.md): the old pass in Authorization and a signed request together move every row of K to the entry, once.
  v1.post("/me/move-to-entry", async (c) => {
    if (!c.get("keyhole")) throw new ApiError("unauthorized", "端末の鍵で署名した要求が要ります。アプリを新しい版にしてください。");
    const entry = c.get("userId");
    const token = bearer(c);
    const pass = library && token ? await library.handler.authenticate(new Request(c.req.raw.url, { headers: { authorization: `Bearer ${token}` } })).catch((error: unknown) => {
      if (error instanceof LoginBillingError) return undefined;
      throw error;
    }) : undefined;
    const moved = !!pass && tx(services.db, () => {
      if (get(services.db, "select 1 from k_moved where k = ?", pass.k)) return false; // already moved, to this entry or to one that later joined
      keyholes!.entries.move(pass.k, entry, true);
      run(services.db, "insert into k_moved (k, entry, at) values (?, ?, ?)", pass.k, entry, now());
      return true;
    });
    if (!moved) return c.json({ entry, moved: false });
    // The old pass of this device has done its work; end that one login (its peer-channel sockets close through onPassEnded). The move stands if this fails.
    await library!.lb.signOut(token!).catch(() => console.error("approval-box-server: move_to_entry_signout_failed"));
    return c.json({ entry, moved: true });
  });
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

  v1.post("/billing/play/verify", async (c) => {
    if (!services.play) accounts.assertSetupVerified(c.get("userId")); // Playが無くても、確認前の関門は同じ順で効かせる
    if (!services.play) throw new ApiError("not_found", "このサーバーではGoogle Playで契約できません。");
    const input = await body(c, z.object({ product_id: z.string().min(1).max(200), purchase_token: z.string().min(1).max(4096) }));
    return c.json(await services.play.verifyPurchase(c.get("userId"), input.product_id, input.purchase_token));
  });

  // 知らないAPIのpathにWeb版のHTMLを返さない（アプリが形式不正として扱えるよう、JSONの404にする）。
  v1.all("*", () => { throw new ApiError("not_found", "そのAPIはありません。"); });
  app.route("/v1", v1);

  // ================= コネクタ（AI側）=================
  // 接続トークンを持たない端末に公開するのは、この2経路だけ。
  const pairing = new Hono();
  pairing.post("/pairing", async (c) => {
    const input = await body(c, z.object({ device_name: z.string().trim().min(1).max(100), os: z.string().max(20).optional(), clients: z.array(z.string().max(40)).max(10).default([]), client: z.string().max(40).optional() }));
    return c.json(accounts.startPairing(input.device_name, input.os ?? null, input.clients, services.publicUrl, input.client));
  });
  pairing.get("/pairing/:id", async (c) => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const result = accounts.pollPairing(c.req.param("id"), c.req.header("x-poll-secret"));
      if (result.status !== "waiting" || Date.now() > deadline) return c.json(result);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
  app.route("/connector/v1", pairing);

  // 上の公開経路に一致しなかった要求は、未知の経路も含めて必ず認証する。
  const conn = new Hono<{ Variables: { conn: ReturnType<Accounts["connectionByToken"]> } }>();
  conn.use("*", async (c, next) => {
    c.set("conn", accounts.connectionByToken(bearer(c)));
    await next();
  });
  const routeChannel = (c: Context) => c.req.query("channel_id") || undefined;

  conn.get("/connection", (c) => c.json(accounts.connectionInfo(c.get("conn"))));
  conn.delete("/connection", (c) => { const me = c.get("conn"); accounts.revokeConnection(me.user_id, me.id); services.peerChannel?.connectionRemoved(me.user_id, me.id); sweep(); return c.json({ ok: true }); });
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
  // peer-channel の道（c8c）: 手元で通った接続テストの印だけ（中身・コードなし）。
  conn.post("/setup-test/verified", async (c) => {
    const input = await body(c, z.object({ client: z.string().trim().min(1).max(40), os: z.string().max(20).optional() }));
    return c.json(decisions.setupVerified(c.get("conn"), input.client, input.os));
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
      const stop = () => wake?.();
      services.shutdown?.addEventListener("abort", stop, { once: true });
      while (!stream.aborted && !services.shutdown?.aborted) {
        if (pending) {
          pending = false;
          await stream.writeSSE({ event: "deliveries", data: "{}" });
        }
        await untilWake(services.shutdown, (resume) => { wake = resume; });
        wake = null;
        if (!pending && !stream.aborted && !services.shutdown?.aborted) await stream.write(": ping\n\n");
      }
      services.shutdown?.removeEventListener("abort", stop);
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
