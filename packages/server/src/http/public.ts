

import { type Provider, verifyIdToken } from "../oidc.ts";

import { Hono, type Context } from "hono";

import { z } from "zod";

import { get } from "../db.ts";
import { ApiError } from "../errors.ts";

import type { Services } from "./types.ts";
import { body } from "./common.ts";

const APP_SCHEME = "approvalbox";

export function registerPublicRoutes(app: Hono, services: Services) {
  const { accounts } = services;
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
      accounts.bindAuthFlow(state, signed.user.id);
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

}
