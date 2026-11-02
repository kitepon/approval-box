

import { Hono, type Context } from "hono";

import { z } from "zod";
import type { Accounts } from "../accounts.ts";

import { MAX_FILE_BYTES, mediaType, readLimited } from "../attachments.ts";
import { get } from "../db.ts";
import { ApiError } from "../errors.ts";

import { amendSchema, createSchema, routeSchema } from "../decisions.ts";
import { now } from "../ids.ts";

import type { Services } from "./types.ts";
import { bearer, body, fileResponse, files, sweep } from "./common.ts";
import { connectorEvents } from "./streams.ts";

export function registerConnectorRoutes(app: Hono, services: Services) {
  const { accounts, decisions } = services;
  // ================= コネクタ（AI側）=================
  // 接続トークンを持たない端末に公開するのは、この2経路だけ。
  const pairing = new Hono();
  pairing.post("/pairing", async (c) => {
    const input = await body(c, z.object({ device_name: z.string().trim().min(1).max(100), os: z.string().max(20).optional(), clients: z.array(z.string().max(40)).max(10).default([]) }));
    return c.json(accounts.startPairing(input.device_name, input.os ?? null, input.clients, services.publicUrl));
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
  conn.delete("/connection", (c) => { const me = c.get("conn"); accounts.revokeConnection(me.user_id, me.id); sweep(services); return c.json({ ok: true }); });
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
    return c.json(files(services).uploadRequest(me, { name: c.req.query("name") ?? "image", contentType: mediaType(c.req.header("content-type")), data }));
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
    sweep(services);
    return c.json(result);
  });
  conn.post("/decisions/:id/cancel", async (c) => {
    const input = await body(c, z.object({ reason: z.string().trim().min(1).max(500) }));
    const res = decisions.cancel(c.get("conn"), c.req.param("id"), input.reason);
    sweep(services);
    return c.json(res);
  });
  conn.get("/decisions/:id/attachments/:aid", (c) => {
    const row = decisions.forConnection(c.get("conn"), c.req.param("id"));
    const file = files(services).readForAi(row.id, c.req.param("aid"));
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
  conn.get("/stream", (c) => connectorEvents(c, services, c.get("conn").id));
  conn.all("*", () => { throw new ApiError("not_found", "そのAPIはありません。"); });
  app.route("/connector/v1", conn);

}
