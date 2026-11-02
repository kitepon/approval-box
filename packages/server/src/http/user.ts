import { LOCALES } from "../locales.ts";
import { requestLocale } from "../locale.ts";
import { Diagnostics, readDiagnostic } from "../diagnostics.ts";

import { onboarding } from "../onboarding.ts";
import { Hono } from "hono";

import { z } from "zod";

import { MAX_FILE_BYTES, mediaType, readLimited } from "../attachments.ts";
import { get, tx } from "../db.ts";
import { ApiError } from "../errors.ts";

import { answerSchema } from "../decisions.ts";

import type { Services } from "./types.ts";
import { bearer, body, idempotent, fileResponse, files, sweep } from "./common.ts";
import { userEvents } from "./streams.ts";

const STATUSES = ["pending", "held", "answered", "cancelled"] as const;

export function registerUserRoutes(app: Hono, services: Services, diagnostics: Diagnostics) {
  const { accounts, decisions } = services;
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
    sweep(services);
    return res;
  });
  v1.get("/decisions/:id", (c) => c.json(decisions.toApi(decisions.forUser(c.get("userId"), c.req.param("id")))));
  v1.post("/decisions/:id/answer", async (c) => {
    const input = await body(c, answerSchema);
    const res = await idempotent(c, services, c.get("userId"), () => decisions.answer(c.get("userId"), c.req.param("id"), input));
    sweep(services);
    return res;
  });
  // 添付（api.md「添付（v0.23）」）。本文はファイルの中身そのまま。
  v1.post("/decisions/:id/attachments", async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key || key.length > 200) throw new ApiError("validation_failed", "Idempotency-Key が要ります。");
    const data = await readLimited(c.req.raw.body, MAX_FILE_BYTES);
    return c.json(files(services).upload(c.get("userId"), c.req.param("id"), { name: c.req.query("name") ?? "", contentType: mediaType(c.req.header("content-type")), idempotencyKey: key, data }));
  });
  v1.get("/decisions/:id/attachments", (c) => c.json(files(services).staged(c.get("userId"), c.req.param("id"))));
  v1.delete("/decisions/:id/attachments/:aid", (c) => c.json(files(services).removeStaged(c.get("userId"), c.req.param("id"), c.req.param("aid"))));
  v1.get("/decisions/:id/attachments/:aid", (c) => {
    const file = files(services).readForUser(c.get("userId"), c.req.param("id"), c.req.param("aid"));
    return fileResponse(c, file.meta, file.data);
  });
  v1.post("/decisions/:id/hold", (c) => idempotent(c, services, c.get("userId"), () => decisions.setHold(c.get("userId"), c.req.param("id"), true)));
  v1.post("/decisions/:id/unhold", (c) => idempotent(c, services, c.get("userId"), () => decisions.setHold(c.get("userId"), c.req.param("id"), false)));

  v1.get("/events", (c) => userEvents(c, services, c.get("userId")));

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
      locale: z.enum(LOCALES).optional(),
      apns_token: z.string().min(1).max(400).optional(),
      apns_env: z.enum(["sandbox", "production"]).optional(),
      fcm_token: z.string().min(1).max(4096).optional(),
      web_push_subscription: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).optional(),
    }));
    return c.json(accounts.registerDevice(c.get("userId"), input));
  });
  v1.delete("/devices/:id", (c) => { accounts.removeDevice(c.get("userId"), c.req.param("id")); return c.json({ ok: true }); });
  v1.get("/onboarding", (c) => {
    const locale = requestLocale(c.req.header("Accept-Language"));
    c.header("Content-Language", locale); c.header("Vary", "Accept-Language");
    return c.json(onboarding(services.publicUrl, locale));
  });

  v1.get("/pairing/lookup", (c) => c.json(accounts.lookupPairing(c.req.query("code") ?? "")));
  v1.post("/pairing/:id/claim", (c) => idempotent(c, services, c.get("userId"), () => accounts.claimPairing(c.get("userId"), c.req.param("id"))));
  v1.post("/pairing/:id/reject", (c) => idempotent(c, services, c.get("userId"), () => { accounts.rejectPairing(c.get("userId"), c.req.param("id")); return { ok: true }; }));

  v1.get("/me", (c) => c.json(accounts.me(c.get("userId"))));
  v1.delete("/me", (c) => {
    const userId = c.get("userId"), ids = services.attachments?.userFileIds(userId) ?? [];
    tx(services.db, () => {
      accounts.deleteUser(userId);
      services.attachments?.eraseFiles(ids);
    });
    return c.json({ ok: true });
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

  // Google Play・Stripeの照合はまだ無い。セットアップ確認の関門だけ先に効かせる。
  v1.post("/billing/:store/:action", (c) => {
    accounts.assertSetupVerified(c.get("userId"));
    throw new ApiError("internal", "課金の受付はまだ準備中です。");
  });

  // 知らないAPIのpathにWeb版のHTMLを返さない（アプリが形式不正として扱えるよう、JSONの404にする）。
  v1.all("*", () => { throw new ApiError("not_found", "そのAPIはありません。"); });
  app.route("/v1", v1);

}
