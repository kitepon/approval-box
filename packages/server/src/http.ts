import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { requestLocale } from "./locale.ts";
import { ApiError } from "./errors.ts";
import { Diagnostics, diagnosticsAdmin } from "./diagnostics.ts";
import { remoteMcpHandler } from "./remote-mcp.ts";
import type { Services } from "./http/types.ts";
import { registerPublicRoutes } from "./http/public.ts";
import { registerUserRoutes } from "./http/user.ts";
import { registerConnectorRoutes } from "./http/connector.ts";
export type { Services } from "./http/types.ts";

export function createApp(services: Services, options: { staticHandler?: (c: Context) => Response | Promise<Response> } = {}) {
  const { accounts, decisions } = services;
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

  const diagnostics = new Diagnostics(services.db);
  app.route("/api/admin",diagnosticsAdmin(diagnostics,services.diagnosticsAdminToken));

  app.get("/healthz", (c) => c.json({ ok: true }));

  registerPublicRoutes(app, services);
  registerUserRoutes(app, services, diagnostics);
  registerConnectorRoutes(app, services);

  // ================= リモートMCP（端末にコネクタを置けないAI）=================
  app.post("/mcp", remoteMcpHandler(accounts, decisions, services.remoteMcp));
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" }));

  if (options.staticHandler) app.get("*", options.staticHandler);
  return app;
}
