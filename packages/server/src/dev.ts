#!/usr/bin/env node
// ローカル開発用のサーバー（レッドシューズ・インディビリアの手元だけ）。`npm run dev:server`。形は docs/architecture/peer-channel-adoption.md の 8。
// 本物の Apple・Google・ストア・APNs・FCM には一切つながらない: login-billing の TestKit を fetch に差し、偽のサインインで本物の通行証を出す。
// 127.0.0.1 だけで待ち、PUBLIC_URL がループバックでなければ起動しない（試験・本番のサーバーへ誤って置かないため）。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { deriveKWith } from "@kitepon/login-billing/server";
import { createTestKit } from "@kitepon/login-billing/testing";
import { Accounts } from "./accounts.ts";
import { openDb } from "./db.ts";
import { Decisions } from "./decisions.ts";
import { EventHub } from "./events.ts";
import { createApp } from "./http.ts";
import { createLibrary, PRODUCT_ID } from "./lb.ts";
import { createPeerChannel } from "./pc.ts";

export const DEV_BUNDLE = "dev.kitepon.approvalbox";
export const DEV_GOOGLE_CLIENT = "dev-google-client.apps.googleusercontent.com";

/** ループバックの URL だけを通す（127.0.0.0/8、::1、localhost）。それ以外は投げる。 */
export function assertLoopback(publicUrl: string): URL {
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw new Error(`PUBLIC_URL is not a URL: ${publicUrl}`); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !(host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))) {
    throw new Error(`the dev server runs only on a loopback http URL (got ${publicUrl}); it must never be deployed`);
  }
  return url;
}

export type DevServerOptions = { port?: number; publicUrl?: string; dataDir?: string; subject?: string; log?: (line: string) => void };

export async function startDevServer(o: DevServerOptions = {}) {
  const port = o.port ?? 8788;
  const publicUrl = (o.publicUrl ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  assertLoopback(publicUrl);
  const log = o.log ?? ((line: string) => console.log(`approval-box-dev: ${line}`));
  const dataDir = resolve(o.dataDir ?? ".dev-data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // 鍵はこの置き場に一度作って使い回す（起動し直しても同じ K・同じ通行証で入れる）。開発用で、本物の鍵とは無関係。
  const keysFile = join(dataDir, "dev-keys.json");
  const keys = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")) as { k: string; pass: string }
    : { k: randomBytes(32).toString("base64url"), pass: randomBytes(32).toString("base64url") };
  if (!existsSync(keysFile)) writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o600 });

  const kit = await createTestKit();
  const subject = o.subject ?? "dev-person";
  // その偽の人の K（Apple と Google の両方）を課金の対象外にする。ストア無しで契約の要る所まで通る。
  const exemptK = await Promise.all((["apple", "google"] as const).map((p) => deriveKWith(Buffer.from(keys.k, "base64url"), p, subject)));
  const db = openDb(join(dataDir, "approval-box.db"));
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store", new Set(exemptK));
  const decisions = new Decisions(db, events);
  const library = createLibrary({
    db, publicUrl, billing: "store", kKey: keys.k, passKey: { id: "dev", key: keys.pass },
    appleAudiences: [DEV_BUNDLE], googleAudiences: [DEV_GOOGLE_CLIENT], exemptK,
    apple: kit.appleStore(DEV_BUNDLE), google: kit.googleStore(DEV_BUNDLE), webSignIn: kit.webClients(), fetch: kit.fetch,
  });
  accounts.contract = (userId) => library.lb.known(userId);
  library.lb.onNone((userId) => decisions.endForNoContract(userId));
  // 起こしは送らない。1行だけ出す（K は出さない）。
  const peerChannel = createPeerChannel({ accounts, library, publicUrl, mirrorPath: join(dataDir, "pc-mirror.db"), wake: (_k, alert) => log(`wake alert=${alert ? 1 : 0} (not sent: dev server)`) });
  const app = createApp({ db, accounts, decisions, events, publicUrl, library, peerChannel: peerChannel.part, appleAudiences: [DEV_BUNDLE], googleAudiences: [DEV_GOOGLE_CLIENT] });

  // 開発だけの入口: 偽の人の id token を作る（アプリは /auth/v1/signin/nonce の nonce で頼み、/auth/v1/signin に渡す）と、
  // Webサインインの提供元の画面の代わり（websignin/start の providerUrl を渡すと、ブラウザが戻る先の URL を返す）。
  const dev = async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/dev/id-token" && path !== "/dev/websignin" && path !== "/dev/store-purchase")) return undefined;
    const body = (await request.json().catch(() => ({}))) as { provider?: string; sub?: string; nonce?: string; providerUrl?: string; k?: string };
    if (path === "/dev/store-purchase") {
      // ストア無しで通行証を「ストア」にする: 偽ストアに30日有効の購読を置き、アプリが /auth/v1/receipt へ送る形をそのまま返す。k（signin の k）を渡すとその口座の購入になる。
      if (body.provider !== "apple" && body.provider !== "google") return Response.json({ error: "provider" }, { status: 400 });
      const id = randomBytes(8).readBigUInt64BE().toString().slice(0, 15).padStart(15, "1"); // Apple の取引 ID は数字だけ
      const mark = typeof body.k === "string" && body.k ? body.k : undefined;
      const expires = Date.now() + 30 * 24 * 3600_000;
      const route = "/auth/v1/receipt";
      if (body.provider === "apple") {
        kit.apple.transactions[id] = { transactionId: id, originalTransactionId: id, productId: PRODUCT_ID, bundleId: DEV_BUNDLE, type: "Auto-Renewable Subscription", expiresDate: expires, ...(mark ? { appAccountToken: mark } : {}) };
        return Response.json({ route, receipts: [{ store: "apple", transactionId: id }] });
      }
      const token = `dev-token-${id}`;
      kit.google.subscriptions[token] = {
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        lineItems: [{ productId: PRODUCT_ID, expiryTime: new Date(expires).toISOString() }],
        ...(mark ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: mark } } : {}),
      };
      return Response.json({ route, receipts: [{ store: "google", productId: PRODUCT_ID, purchaseToken: token }] });
    }
    if (path === "/dev/websignin") {
      if (typeof body.providerUrl !== "string") return Response.json({ error: "providerUrl" }, { status: 400 });
      return Response.json({ location: await kit.signInAtProvider(body.providerUrl, { sub: body.sub ?? subject }) });
    }
    const sub = body.sub ?? subject;
    const token = body.provider === "google"
      ? await kit.googleIdToken({ aud: DEV_GOOGLE_CLIENT, sub, ...(body.nonce ? { nonce: body.nonce } : {}) })
      : await kit.appleIdToken({ aud: DEV_BUNDLE, sub, ...(body.nonce ? { nonce: body.nonce } : {}) });
    return Response.json({ id_token: token, provider: body.provider === "google" ? "google" : "apple", aud: body.provider === "google" ? DEV_GOOGLE_CLIENT : DEV_BUNDLE, sub });
  };
  const fetchHandler = async (request: Request, env: unknown) => (await dev(request)) ?? app.fetch(request, env as never);

  const server = await new Promise<ReturnType<typeof serve>>((ok) => {
    const s = serve({ fetch: fetchHandler, port, hostname: "127.0.0.1", createServer: peerChannel.createServer }, () => ok(s));
  });
  const actualPort = (server.address() as { port: number }).port;
  log(`listening on http://127.0.0.1:${actualPort} (fake sign-in for subject "${subject}"; Apple aud ${DEV_BUNDLE}, Google aud ${DEV_GOOGLE_CLIENT}; data ${dataDir})`);
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise<void>((ok) => { peerChannel.part.close(); server.close(() => { db.close(); ok(); }); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  startDevServer({
    port: Number(env.PORT ?? 8788),
    ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
    ...(env.DEV_DATA ? { dataDir: env.DEV_DATA } : {}), // not APPROVAL_BOX_DATA: never the real server's data
    ...(env.DEV_SUBJECT ? { subject: env.DEV_SUBJECT } : {}),
  }).catch((error: Error) => { console.error(`approval-box-dev: ${error.message}`); process.exit(1); });
}
